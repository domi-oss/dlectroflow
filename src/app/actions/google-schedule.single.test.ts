import { describe, it, expect, vi, beforeEach } from "vitest";

const {
  workspaceMock,
  isOwnerMock,
  currentUserMock,
  revalidatePathMock,
  configuredMock,
  tokenMock,
  statusMock,
  findReclaimListMock,
  createGoogleTaskMock,
  upsertGoogleTaskMock,
  itemFindFirstMock,
  itemUpdateMock,
  taskCreateMock,
  taskFindFirstMock,
  taskUpdateMock,
  getSettingsMock,
} = vi.hoisted(() => ({
  workspaceMock: vi.fn(),
  isOwnerMock: vi.fn(),
  currentUserMock: vi.fn(),
  revalidatePathMock: vi.fn(),
  configuredMock: vi.fn(),
  tokenMock: vi.fn(),
  statusMock: vi.fn(),
  findReclaimListMock: vi.fn(),
  createGoogleTaskMock: vi.fn(),
  upsertGoogleTaskMock: vi.fn(),
  itemFindFirstMock: vi.fn(),
  itemUpdateMock: vi.fn(),
  taskCreateMock: vi.fn(),
  taskFindFirstMock: vi.fn(),
  taskUpdateMock: vi.fn(),
  getSettingsMock: vi.fn(),
}));

vi.mock("next/cache", () => ({ revalidatePath: revalidatePathMock }));
vi.mock("@/lib/db", () => {
  // getSettings is read for the voice of the focus deep-link note (#104).
  const prisma: Record<string, unknown> = {
    brainDumpItem: {
      findFirst: itemFindFirstMock,
      update: itemUpdateMock,
    },
    task: {
      create: taskCreateMock,
      findFirst: taskFindFirstMock,
      update: taskUpdateMock,
    },
    // Interactive transaction: run the callback with the same mock client, so
    // the lazy Task-create + item-link (now wrapped in $transaction) still hit
    // taskCreateMock / itemUpdateMock.
    $transaction: (fn: (tx: unknown) => unknown) => fn(prisma),
  };
  return { prisma, getSettings: getSettingsMock };
});
vi.mock("@/lib/rewards", () => ({
  logReward: vi.fn().mockResolvedValue(undefined),
  awardBadge: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/google", () => ({
  getValidAccessToken: tokenMock,
  googleConfigured: configuredMock,
  findReclaimList: findReclaimListMock,
  listTaskLists: vi.fn(),
  createGoogleTask: createGoogleTaskMock,
  upsertGoogleTask: upsertGoogleTaskMock,
  getGoogleStatus: statusMock,
  disconnectGoogle: vi.fn(),
}));
vi.mock("@/lib/workspace", () => ({
  currentWorkspaceId: workspaceMock,
  isOwnerRequest: isOwnerMock,
  currentUser: currentUserMock,
}));

import { RewardType, BadgeKey } from "@/lib/constants";
import { logReward, awardBadge } from "@/lib/rewards";
import { scheduleSingleTask } from "./google-schedule";

// #35 Phase A — the owner's workspace is a real per-account id now, not the
// "owner" constant. Ownership is asserted through isOwnerRequest (the role
// check the action actually makes); this id is just the workspace that
// account happens to own.
const OWNER_WS = "ws-owner";

// #118 Phase C — the action reads currentUser() now, because the acting user's
// id is what keys their own GoogleAuth row. isOwnerRequest() is no longer called
// by the action; its mock stays only until #118 retires it in the next commit.
// The two must always describe the SAME person — two mocks answering one
// question is how a test ends up proving something about nobody.
const OWNER_ID = "user-owner";
const ownerUser = () => ({
  id: OWNER_ID,
  role: "owner" as const,
  workspaceId: OWNER_WS,
  provider: "gitlab",
  handle: "owner",
});
const memberUser = () => ({
  id: "user-member",
  role: "member" as const,
  workspaceId: "ws-member",
  provider: "gitlab",
  handle: "member",
});

beforeEach(() => {
  vi.clearAllMocks();
  currentUserMock.mockResolvedValue(ownerUser());
  getSettingsMock.mockResolvedValue({ voice: "plain" });
  taskFindFirstMock.mockResolvedValue(null);
  upsertGoogleTaskMock.mockResolvedValue({ id: "gtask-9", created: true });
});

describe("scheduleSingleTask", () => {
  it("rejects non-owner", async () => {
    workspaceMock.mockResolvedValue("guest-ws");
    isOwnerMock.mockResolvedValue(false);
    // Kept in sync with isOwnerMock — the action gates on currentUser().role
    // now (#118), so the member has to be the one asking.
    currentUserMock.mockResolvedValue(memberUser());
    await expect(scheduleSingleTask("item-1", 30)).rejects.toThrow(
      "owner only",
    );
  });

  it("resolves the token for the ACTING user, never a fixed id", async () => {
    // #118 — no id parameter exists on this action; the credential is reached BY
    // the acting account, so there is no other row to point at.
    workspaceMock.mockResolvedValue(OWNER_WS);
    isOwnerMock.mockResolvedValue(true);
    configuredMock.mockReturnValue(true);
    tokenMock.mockResolvedValue("tok");
    itemFindFirstMock.mockResolvedValue({
      id: "item-1",
      text: "todo",
      taskId: "task-1",
      task: { scheduledAt: null },
    });
    findReclaimListMock.mockResolvedValue({ id: "list-9", title: "🗓 Reclaim" });
    taskUpdateMock.mockResolvedValue({});
    await scheduleSingleTask("item-1", 30);
    expect(tokenMock).toHaveBeenCalledWith(OWNER_ID);
  });

  it("rejects a duration outside 1..480 minutes (server clamp) without touching Google", async () => {
    workspaceMock.mockResolvedValue(OWNER_WS);
    isOwnerMock.mockResolvedValue(true);
    configuredMock.mockReturnValue(true);
    tokenMock.mockResolvedValue("tok");

    expect(await scheduleSingleTask("item-1", 9999)).toEqual({
      ok: false,
      reason: "error",
      message: "Duration must be 1-480 minutes",
    });
    expect(itemFindFirstMock).not.toHaveBeenCalled();
    expect(upsertGoogleTaskMock).not.toHaveBeenCalled();
  });

  it("returns reconnect_required when tokens are dead", async () => {
    workspaceMock.mockResolvedValue(OWNER_WS);
    isOwnerMock.mockResolvedValue(true);
    configuredMock.mockReturnValue(true);
    tokenMock.mockResolvedValue(null);
    statusMock.mockResolvedValue({
      configured: true,
      connected: false,
      needsReconnect: true,
    });
    expect(await scheduleSingleTask("item-1", 30)).toEqual({
      ok: false,
      reason: "reconnect_required",
    });
  });

  it("creates one Google task titled with the duration convention and stores ids", async () => {
    workspaceMock.mockResolvedValue(OWNER_WS);
    isOwnerMock.mockResolvedValue(true);
    configuredMock.mockReturnValue(true);
    tokenMock.mockResolvedValue("tok");
    itemFindFirstMock.mockResolvedValue({
      id: "item-1",
      text: "Call the dentist",
      taskId: "task-1",
      task: { id: "task-1", title: "Call the dentist" },
    });
    findReclaimListMock.mockResolvedValue({ id: "list-9", title: "🗓 Reclaim" });
    upsertGoogleTaskMock.mockResolvedValue({ id: "gtask-9", created: true });

    const res = await scheduleSingleTask("item-1", 45);

    expect(res).toEqual({ ok: true });
    expect(upsertGoogleTaskMock).toHaveBeenCalledWith(
      "tok",
      "list-9",
      null, // no stored id yet -> POST
      expect.objectContaining({
        title: expect.stringContaining("(duration:45m)"),
      }),
    );
    expect(taskUpdateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "task-1" },
        data: expect.objectContaining({
          googleTaskId: "gtask-9",
          googleTaskListId: "list-9",
        }),
      }),
    );
    expect(revalidatePathMock).toHaveBeenCalledWith("/");
  });

  // #104: one code path for the format, so a to-do and a step cannot drift.
  it("sends the full intent for a stepless to-do — floor, priority, hours, due, no (not before)", async () => {
    process.env.PUBLIC_ORIGIN = "https://app.example";
    workspaceMock.mockResolvedValue(OWNER_WS);
    isOwnerMock.mockResolvedValue(true);
    configuredMock.mockReturnValue(true);
    tokenMock.mockResolvedValue("tok");
    itemFindFirstMock.mockResolvedValue({
      id: "item-1",
      text: "Call the dentist",
      taskId: "task-1",
      task: { id: "task-1", title: "Call the dentist" },
    });
    findReclaimListMock.mockResolvedValue({ id: "list-9", title: "🗓 Reclaim" });

    await scheduleSingleTask("item-1", 10);

    const body = upsertGoogleTaskMock.mock.calls[0][3] as {
      title: string;
      notes: string;
    };
    expect(body.title).toContain("(duration:30m)"); // 10m clamped by the floor
    expect(body.title).toContain("(priority:P2)");
    expect(body.title).toContain("(type work)");
    expect(body.title).toContain("(due ");
    // Nothing to sequence, so no badge, no (nosplit) and no (not before).
    expect(body.title).not.toContain("not before");
    expect(body.title).not.toContain("(nosplit)");
    expect(body.title).not.toContain("[1/1]");
    // And it still carries the focus deep-link (the to-do's own task id).
    expect(body.notes).toContain("https://app.example/focus/task-1");
    delete process.env.PUBLIC_ORIGIN;
  });

  // #104: re-scheduling used to POST a second task, so Reclaim booked a
  // second block. The stored Task.googleTaskId is now read and PATCHed.
  it("updates the stored Google Task on a re-schedule instead of creating a second one", async () => {
    workspaceMock.mockResolvedValue(OWNER_WS);
    isOwnerMock.mockResolvedValue(true);
    configuredMock.mockReturnValue(true);
    tokenMock.mockResolvedValue("tok");
    itemFindFirstMock.mockResolvedValue({
      id: "item-1",
      text: "Call the dentist",
      taskId: "task-1",
      task: { id: "task-1", title: "Call the dentist" },
    });
    findReclaimListMock.mockResolvedValue({ id: "list-9", title: "🗓 Reclaim" });
    taskFindFirstMock.mockResolvedValue({ googleTaskId: "gtask-existing" });
    upsertGoogleTaskMock.mockResolvedValue({
      id: "gtask-existing",
      created: false,
    });

    expect(await scheduleSingleTask("item-1", 30)).toEqual({ ok: true });
    expect(upsertGoogleTaskMock).toHaveBeenCalledWith(
      "tok",
      "list-9",
      "gtask-existing",
      expect.objectContaining({ title: expect.any(String) }),
    );
    // The lookup is workspace-scoped, so another workspace's id is unreachable.
    expect(taskFindFirstMock).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "task-1", workspaceId: OWNER_WS },
      }),
    );
    expect(createGoogleTaskMock).not.toHaveBeenCalled();
  });

  it("returns no_reclaim_list when no matching Google Tasks list exists", async () => {
    workspaceMock.mockResolvedValue(OWNER_WS);
    isOwnerMock.mockResolvedValue(true);
    configuredMock.mockReturnValue(true);
    tokenMock.mockResolvedValue("tok");
    itemFindFirstMock.mockResolvedValue({
      id: "item-1",
      text: "Call the dentist",
      taskId: "task-1",
      task: { id: "task-1", title: "Call the dentist" },
    });
    findReclaimListMock.mockResolvedValue(null);

    expect(await scheduleSingleTask("item-1", 30)).toEqual({
      ok: false,
      reason: "no_reclaim_list",
    });
    expect(upsertGoogleTaskMock).not.toHaveBeenCalled();
  });

  it("lazily creates a Task row when the item has none yet, then schedules it", async () => {
    workspaceMock.mockResolvedValue(OWNER_WS);
    isOwnerMock.mockResolvedValue(true);
    configuredMock.mockReturnValue(true);
    tokenMock.mockResolvedValue("tok");
    itemFindFirstMock.mockResolvedValue({
      id: "item-2",
      text: "Water the plants",
      taskId: null,
      task: null,
    });
    taskCreateMock.mockResolvedValue({ id: "task-2" });
    findReclaimListMock.mockResolvedValue({ id: "list-9", title: "🗓 Reclaim" });
    upsertGoogleTaskMock.mockResolvedValue({ id: "gtask-3", created: true });

    const res = await scheduleSingleTask("item-2", 15);

    expect(res).toEqual({ ok: true });
    expect(taskCreateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ title: "Water the plants" }),
      }),
    );
    expect(itemUpdateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "item-2" },
        data: expect.objectContaining({ taskId: "task-2" }),
      }),
    );
    expect(taskUpdateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "task-2" },
        data: expect.objectContaining({ googleTaskId: "gtask-3" }),
      }),
    );
  });

  it("sets the provider-agnostic scheduled marker (scheduledVia='google') on success", async () => {
    workspaceMock.mockResolvedValue(OWNER_WS);
    isOwnerMock.mockResolvedValue(true);
    configuredMock.mockReturnValue(true);
    tokenMock.mockResolvedValue("tok");
    itemFindFirstMock.mockResolvedValue({
      id: "item-1",
      text: "Call the dentist",
      taskId: "task-1",
      task: { id: "task-1", scheduledAt: null },
    });
    findReclaimListMock.mockResolvedValue({ id: "list-9", title: "🗓 Reclaim" });
    upsertGoogleTaskMock.mockResolvedValue({ id: "gtask-9", created: true });

    await scheduleSingleTask("item-1", 30);

    expect(taskUpdateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "task-1" },
        data: expect.objectContaining({
          scheduledVia: "google",
          googleTaskId: "gtask-9",
        }),
      }),
    );
  });

  // ── reward parity with the steps path (#25) ──────────────────────────────
  it("awards Scheduled (+10) and the FirstSchedule badge on a successful single-task schedule", async () => {
    workspaceMock.mockResolvedValue(OWNER_WS);
    isOwnerMock.mockResolvedValue(true);
    configuredMock.mockReturnValue(true);
    tokenMock.mockResolvedValue("tok");
    itemFindFirstMock.mockResolvedValue({
      id: "item-1",
      text: "Call the dentist",
      taskId: "task-1",
      task: { id: "task-1", title: "Call the dentist", googleTaskId: null },
    });
    findReclaimListMock.mockResolvedValue({ id: "list-9", title: "🗓 Reclaim" });
    upsertGoogleTaskMock.mockResolvedValue({ id: "gtask-9", created: true });

    const res = await scheduleSingleTask("item-1", 30);

    expect(res).toEqual({ ok: true });
    // Same helpers, same args as pushStepsToGoogleTasks (google-schedule.ts).
    expect(logReward).toHaveBeenCalledWith(OWNER_WS, RewardType.Scheduled);
    expect(awardBadge).toHaveBeenCalledWith(OWNER_WS, BadgeKey.FirstSchedule);
  });

  it("awards Scheduled + FirstSchedule for a lazily-created task (first-ever schedule)", async () => {
    workspaceMock.mockResolvedValue(OWNER_WS);
    isOwnerMock.mockResolvedValue(true);
    configuredMock.mockReturnValue(true);
    tokenMock.mockResolvedValue("tok");
    itemFindFirstMock.mockResolvedValue({
      id: "item-2",
      text: "Water the plants",
      taskId: null,
      task: null,
    });
    taskCreateMock.mockResolvedValue({ id: "task-2" });
    findReclaimListMock.mockResolvedValue({ id: "list-9", title: "🗓 Reclaim" });
    upsertGoogleTaskMock.mockResolvedValue({ id: "gtask-3", created: true });

    const res = await scheduleSingleTask("item-2", 15);

    expect(res).toEqual({ ok: true });
    expect(logReward).toHaveBeenCalledWith(OWNER_WS, RewardType.Scheduled);
    expect(awardBadge).toHaveBeenCalledWith(OWNER_WS, BadgeKey.FirstSchedule);
  });

  it("does not re-award when the task was already scheduled (idempotency — task has a scheduledAt marker)", async () => {
    workspaceMock.mockResolvedValue(OWNER_WS);
    isOwnerMock.mockResolvedValue(true);
    configuredMock.mockReturnValue(true);
    tokenMock.mockResolvedValue("tok");
    // S0 (#29): idempotency moved from googleTaskId → the provider-agnostic
    // scheduledAt marker, so a task scheduled via ICS or Google won't re-award.
    itemFindFirstMock.mockResolvedValue({
      id: "item-1",
      text: "Call the dentist",
      taskId: "task-1",
      task: {
        id: "task-1",
        title: "Call the dentist",
        scheduledAt: new Date("2026-07-17T10:00:00Z"),
      },
    });
    findReclaimListMock.mockResolvedValue({ id: "list-9", title: "🗓 Reclaim" });
    upsertGoogleTaskMock.mockResolvedValue({ id: "gtask-9", created: true });

    const res = await scheduleSingleTask("item-1", 30);

    expect(res).toEqual({ ok: true });
    // Re-scheduling still performs the Google push + update — only the reward is skipped.
    expect(upsertGoogleTaskMock).toHaveBeenCalled();
    expect(taskUpdateMock).toHaveBeenCalled();
    expect(logReward).not.toHaveBeenCalled();
    expect(awardBadge).not.toHaveBeenCalled();
  });

  it("does not award when the Google push fails", async () => {
    workspaceMock.mockResolvedValue(OWNER_WS);
    isOwnerMock.mockResolvedValue(true);
    configuredMock.mockReturnValue(true);
    tokenMock.mockResolvedValue("tok");
    itemFindFirstMock.mockResolvedValue({
      id: "item-1",
      text: "Call the dentist",
      taskId: "task-1",
      task: { id: "task-1", title: "Call the dentist", googleTaskId: null },
    });
    findReclaimListMock.mockResolvedValue(null); // no Reclaim list → push fails

    const res = await scheduleSingleTask("item-1", 30);

    expect(res).toEqual({ ok: false, reason: "no_reclaim_list" });
    expect(logReward).not.toHaveBeenCalled();
    expect(awardBadge).not.toHaveBeenCalled();
  });

  it("revalidates / after the lazy Task-create even when the Google push fails (Duo review)", async () => {
    workspaceMock.mockResolvedValue(OWNER_WS);
    isOwnerMock.mockResolvedValue(true);
    configuredMock.mockReturnValue(true);
    tokenMock.mockResolvedValue("tok");
    itemFindFirstMock.mockResolvedValue({
      id: "item-3",
      text: "Water the plants",
      taskId: null,
      task: null,
    });
    taskCreateMock.mockResolvedValue({ id: "task-3" });
    findReclaimListMock.mockResolvedValue(null); // Google push fails after the lazy-create

    const res = await scheduleSingleTask("item-3", 15);

    expect(res).toEqual({ ok: false, reason: "no_reclaim_list" });
    // The item is now linked to a new Task, so the inbox cache MUST be invalidated
    // regardless of the Google failure.
    expect(revalidatePathMock).toHaveBeenCalledWith("/");
  });

  it("still returns ok when a reward call fails — reward errors must not fail scheduling (Duo !77)", async () => {
    workspaceMock.mockResolvedValue(OWNER_WS);
    isOwnerMock.mockResolvedValue(true);
    configuredMock.mockReturnValue(true);
    tokenMock.mockResolvedValue("tok");
    itemFindFirstMock.mockResolvedValue({
      id: "item-1",
      text: "Call the dentist",
      taskId: "task-1",
      task: { id: "task-1", title: "Call the dentist", googleTaskId: null },
    });
    findReclaimListMock.mockResolvedValue({ id: "list-9", title: "🗓 Reclaim" });
    upsertGoogleTaskMock.mockResolvedValue({ id: "gtask-9", created: true });
    // The Google task + task.update have already committed by the time rewards run;
    // a reward failure must NOT return { ok: false } (a retry would duplicate the
    // Google task). The reward calls are isolated in their own try/catch.
    vi.mocked(logReward).mockRejectedValueOnce(new Error("reward store down"));

    const res = await scheduleSingleTask("item-1", 30);

    expect(res).toEqual({ ok: true });
    // allSettled: a logReward failure must NOT skip the idempotent awardBadge.
    expect(awardBadge).toHaveBeenCalledWith(OWNER_WS, BadgeKey.FirstSchedule);
    expect(taskUpdateMock).toHaveBeenCalled();
    expect(revalidatePathMock).toHaveBeenCalledWith("/");
  });
});
