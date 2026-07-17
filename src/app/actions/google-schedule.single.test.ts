import { describe, it, expect, vi, beforeEach } from "vitest";

const {
  workspaceMock,
  revalidatePathMock,
  configuredMock,
  tokenMock,
  statusMock,
  findReclaimListMock,
  createGoogleTaskMock,
  itemFindFirstMock,
  itemUpdateMock,
  taskCreateMock,
  taskUpdateMock,
} = vi.hoisted(() => ({
  workspaceMock: vi.fn(),
  revalidatePathMock: vi.fn(),
  configuredMock: vi.fn(),
  tokenMock: vi.fn(),
  statusMock: vi.fn(),
  findReclaimListMock: vi.fn(),
  createGoogleTaskMock: vi.fn(),
  itemFindFirstMock: vi.fn(),
  itemUpdateMock: vi.fn(),
  taskCreateMock: vi.fn(),
  taskUpdateMock: vi.fn(),
}));

vi.mock("next/cache", () => ({ revalidatePath: revalidatePathMock }));
vi.mock("@/lib/db", () => {
  const prisma: Record<string, unknown> = {
    brainDumpItem: {
      findFirst: itemFindFirstMock,
      update: itemUpdateMock,
    },
    task: {
      create: taskCreateMock,
      update: taskUpdateMock,
    },
    // Interactive transaction: run the callback with the same mock client, so
    // the lazy Task-create + item-link (now wrapped in $transaction) still hit
    // taskCreateMock / itemUpdateMock.
    $transaction: (fn: (tx: unknown) => unknown) => fn(prisma),
  };
  return { prisma };
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
  getGoogleStatus: statusMock,
  disconnectGoogle: vi.fn(),
}));
vi.mock("@/lib/workspace", () => ({ currentWorkspaceId: workspaceMock }));

import { OWNER_WORKSPACE_ID, RewardType, BadgeKey } from "@/lib/constants";
import { logReward, awardBadge } from "@/lib/rewards";
import { scheduleSingleTask } from "./google-schedule";

beforeEach(() => vi.clearAllMocks());

describe("scheduleSingleTask", () => {
  it("rejects non-owner", async () => {
    workspaceMock.mockResolvedValue("guest-ws");
    await expect(scheduleSingleTask("item-1", 30)).rejects.toThrow("owner only");
  });

  it("rejects a duration outside 1..480 minutes (server clamp) without touching Google", async () => {
    workspaceMock.mockResolvedValue(OWNER_WORKSPACE_ID);
    configuredMock.mockReturnValue(true);
    tokenMock.mockResolvedValue("tok");

    expect(await scheduleSingleTask("item-1", 9999)).toEqual({
      ok: false,
      reason: "error",
      message: "Duration must be 1-480 minutes",
    });
    expect(itemFindFirstMock).not.toHaveBeenCalled();
    expect(createGoogleTaskMock).not.toHaveBeenCalled();
  });

  it("returns reconnect_required when tokens are dead", async () => {
    workspaceMock.mockResolvedValue(OWNER_WORKSPACE_ID);
    configuredMock.mockReturnValue(true);
    tokenMock.mockResolvedValue(null);
    statusMock.mockResolvedValue({ configured: true, connected: false, needsReconnect: true });
    expect(await scheduleSingleTask("item-1", 30)).toEqual({ ok: false, reason: "reconnect_required" });
  });

  it("creates one Google task titled with the duration convention and stores ids", async () => {
    workspaceMock.mockResolvedValue(OWNER_WORKSPACE_ID);
    configuredMock.mockReturnValue(true);
    tokenMock.mockResolvedValue("tok");
    itemFindFirstMock.mockResolvedValue({
      id: "item-1",
      text: "Call the dentist",
      taskId: "task-1",
      task: { id: "task-1", title: "Call the dentist" },
    });
    findReclaimListMock.mockResolvedValue({ id: "list-9", title: "🗓 Reclaim" });
    createGoogleTaskMock.mockResolvedValue({ id: "gtask-9" });

    const res = await scheduleSingleTask("item-1", 45);

    expect(res).toEqual({ ok: true });
    expect(createGoogleTaskMock).toHaveBeenCalledWith(
      "tok",
      "list-9",
      expect.objectContaining({ title: expect.stringContaining("(duration:45m)") }),
    );
    expect(taskUpdateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "task-1" },
        data: expect.objectContaining({ googleTaskId: "gtask-9", googleTaskListId: "list-9" }),
      }),
    );
    expect(revalidatePathMock).toHaveBeenCalledWith("/inbox");
  });

  it("returns no_reclaim_list when no matching Google Tasks list exists", async () => {
    workspaceMock.mockResolvedValue(OWNER_WORKSPACE_ID);
    configuredMock.mockReturnValue(true);
    tokenMock.mockResolvedValue("tok");
    itemFindFirstMock.mockResolvedValue({
      id: "item-1",
      text: "Call the dentist",
      taskId: "task-1",
      task: { id: "task-1", title: "Call the dentist" },
    });
    findReclaimListMock.mockResolvedValue(null);

    expect(await scheduleSingleTask("item-1", 30)).toEqual({ ok: false, reason: "no_reclaim_list" });
    expect(createGoogleTaskMock).not.toHaveBeenCalled();
  });

  it("lazily creates a Task row when the item has none yet, then schedules it", async () => {
    workspaceMock.mockResolvedValue(OWNER_WORKSPACE_ID);
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
    createGoogleTaskMock.mockResolvedValue({ id: "gtask-3" });

    const res = await scheduleSingleTask("item-2", 15);

    expect(res).toEqual({ ok: true });
    expect(taskCreateMock).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ title: "Water the plants" }) }),
    );
    expect(itemUpdateMock).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "item-2" }, data: expect.objectContaining({ taskId: "task-2" }) }),
    );
    expect(taskUpdateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "task-2" },
        data: expect.objectContaining({ googleTaskId: "gtask-3" }),
      }),
    );
  });

  // ── reward parity with the steps path (#25) ──────────────────────────────
  it("awards Scheduled (+10) and the FirstSchedule badge on a successful single-task schedule", async () => {
    workspaceMock.mockResolvedValue(OWNER_WORKSPACE_ID);
    configuredMock.mockReturnValue(true);
    tokenMock.mockResolvedValue("tok");
    itemFindFirstMock.mockResolvedValue({
      id: "item-1",
      text: "Call the dentist",
      taskId: "task-1",
      task: { id: "task-1", title: "Call the dentist", googleTaskId: null },
    });
    findReclaimListMock.mockResolvedValue({ id: "list-9", title: "🗓 Reclaim" });
    createGoogleTaskMock.mockResolvedValue({ id: "gtask-9" });

    const res = await scheduleSingleTask("item-1", 30);

    expect(res).toEqual({ ok: true });
    // Same helpers, same args as pushStepsToGoogleTasks (google-schedule.ts).
    expect(logReward).toHaveBeenCalledWith(OWNER_WORKSPACE_ID, RewardType.Scheduled);
    expect(awardBadge).toHaveBeenCalledWith(OWNER_WORKSPACE_ID, BadgeKey.FirstSchedule);
  });

  it("awards Scheduled + FirstSchedule for a lazily-created task (first-ever schedule)", async () => {
    workspaceMock.mockResolvedValue(OWNER_WORKSPACE_ID);
    configuredMock.mockReturnValue(true);
    tokenMock.mockResolvedValue("tok");
    itemFindFirstMock.mockResolvedValue({ id: "item-2", text: "Water the plants", taskId: null, task: null });
    taskCreateMock.mockResolvedValue({ id: "task-2" });
    findReclaimListMock.mockResolvedValue({ id: "list-9", title: "🗓 Reclaim" });
    createGoogleTaskMock.mockResolvedValue({ id: "gtask-3" });

    const res = await scheduleSingleTask("item-2", 15);

    expect(res).toEqual({ ok: true });
    expect(logReward).toHaveBeenCalledWith(OWNER_WORKSPACE_ID, RewardType.Scheduled);
    expect(awardBadge).toHaveBeenCalledWith(OWNER_WORKSPACE_ID, BadgeKey.FirstSchedule);
  });

  it("does not re-award when the task was already scheduled (idempotency — task has a googleTaskId)", async () => {
    workspaceMock.mockResolvedValue(OWNER_WORKSPACE_ID);
    configuredMock.mockReturnValue(true);
    tokenMock.mockResolvedValue("tok");
    itemFindFirstMock.mockResolvedValue({
      id: "item-1",
      text: "Call the dentist",
      taskId: "task-1",
      task: { id: "task-1", title: "Call the dentist", googleTaskId: "gtask-old" },
    });
    findReclaimListMock.mockResolvedValue({ id: "list-9", title: "🗓 Reclaim" });
    createGoogleTaskMock.mockResolvedValue({ id: "gtask-9" });

    const res = await scheduleSingleTask("item-1", 30);

    expect(res).toEqual({ ok: true });
    // Re-scheduling still performs the Google push + update — only the reward is skipped.
    expect(createGoogleTaskMock).toHaveBeenCalled();
    expect(taskUpdateMock).toHaveBeenCalled();
    expect(logReward).not.toHaveBeenCalled();
    expect(awardBadge).not.toHaveBeenCalled();
  });

  it("does not award when the Google push fails", async () => {
    workspaceMock.mockResolvedValue(OWNER_WORKSPACE_ID);
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

  it("revalidates /inbox after the lazy Task-create even when the Google push fails (Duo review)", async () => {
    workspaceMock.mockResolvedValue(OWNER_WORKSPACE_ID);
    configuredMock.mockReturnValue(true);
    tokenMock.mockResolvedValue("tok");
    itemFindFirstMock.mockResolvedValue({ id: "item-3", text: "Water the plants", taskId: null, task: null });
    taskCreateMock.mockResolvedValue({ id: "task-3" });
    findReclaimListMock.mockResolvedValue(null); // Google push fails after the lazy-create

    const res = await scheduleSingleTask("item-3", 15);

    expect(res).toEqual({ ok: false, reason: "no_reclaim_list" });
    // The item is now linked to a new Task, so the inbox cache MUST be invalidated
    // regardless of the Google failure.
    expect(revalidatePathMock).toHaveBeenCalledWith("/inbox");
  });

  it("still returns ok when a reward call fails — reward errors must not fail scheduling (Duo !77)", async () => {
    workspaceMock.mockResolvedValue(OWNER_WORKSPACE_ID);
    configuredMock.mockReturnValue(true);
    tokenMock.mockResolvedValue("tok");
    itemFindFirstMock.mockResolvedValue({
      id: "item-1",
      text: "Call the dentist",
      taskId: "task-1",
      task: { id: "task-1", title: "Call the dentist", googleTaskId: null },
    });
    findReclaimListMock.mockResolvedValue({ id: "list-9", title: "🗓 Reclaim" });
    createGoogleTaskMock.mockResolvedValue({ id: "gtask-9" });
    // The Google task + task.update have already committed by the time rewards run;
    // a reward failure must NOT return { ok: false } (a retry would duplicate the
    // Google task). The reward calls are isolated in their own try/catch.
    vi.mocked(logReward).mockRejectedValueOnce(new Error("reward store down"));

    const res = await scheduleSingleTask("item-1", 30);

    expect(res).toEqual({ ok: true });
    // allSettled: a logReward failure must NOT skip the idempotent awardBadge.
    expect(awardBadge).toHaveBeenCalledWith(OWNER_WORKSPACE_ID, BadgeKey.FirstSchedule);
    expect(taskUpdateMock).toHaveBeenCalled();
    expect(revalidatePathMock).toHaveBeenCalledWith("/inbox");
  });
});
