import { describe, it, expect, vi, beforeEach } from "vitest";

const {
  workspaceMock,
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
  itemUpdateManyMock,
  taskCreateMock,
  taskDeleteMock,
  taskDeleteManyMock,
  taskFindFirstMock,
  taskUpdateMock,
  getSettingsMock,
} = vi.hoisted(() => ({
  workspaceMock: vi.fn(),
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
  itemUpdateManyMock: vi.fn(),
  taskCreateMock: vi.fn(),
  taskDeleteMock: vi.fn(),
  taskDeleteManyMock: vi.fn(),
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
      // #244 — the lazy link is an `updateMany` now, because the precondition
      // (`taskId: null`) lives in its `where`. `update` stays on the mock: other
      // actions in this module still write the item by primary key.
      updateMany: itemUpdateManyMock,
    },
    task: {
      create: taskCreateMock,
      // #244 (Duo review) — the loser's discard is a workspace-scoped
      // `deleteMany` now. `delete` stays on the mock rather than being swapped
      // out: leaving it means a regression to the unscoped form fails on THIS
      // FILE's assertion, with a sentence about scope, instead of on
      // `delete is not a function`, which says nothing about why it is wrong.
      delete: taskDeleteMock,
      deleteMany: taskDeleteManyMock,
      findFirst: taskFindFirstMock,
      update: taskUpdateMock,
    },
    // Interactive transaction: run the callback with the same mock client, so
    // the lazy Task-create + item-link (now wrapped in $transaction) still hit
    // taskCreateMock / itemUpdateManyMock.
    //
    // Note what this CANNOT show, and why the sibling integration file exists
    // (#244): the callback runs with no row lock to block on and nothing to roll
    // back, so the loser's `updateMany` reports whatever this file tells it to
    // rather than the `count: 0` Postgres produces when it re-qualifies a blocked
    // `UPDATE`. The specs below pin the SHAPE — the precondition is in the write,
    // the speculative Task is dropped, the winner is adopted. The behaviour is
    // proved in `schedule-single-task.integration.test.ts`.
    //
    // The options argument is accepted and ignored: the budget it carries
    // (`TASK_WRITER_TX_BUDGET`) is a real-Postgres property, and
    // `braindump-to-task-hygiene` is what fails the build if a writer drops it.
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
  currentUser: currentUserMock,
}));

import { RewardType, BadgeKey } from "@/lib/constants";
import { logReward, awardBadge } from "@/lib/rewards";
import { scheduleSingleTask } from "./google-schedule";

// #35 Phase A — the owner's workspace is a real per-account id now, not the
// "owner" constant; this id is just the workspace that account happens to own.
const OWNER_WS = "ws-owner";

// #118 Phase C — currentUser() is the ONE identity mock in this file. The action
// no longer calls isOwnerRequest() at all: the acting user's id is what keys
// their own GoogleAuth row, and "signed in" is the whole gate. Two mocks
// answering one question is how a test ends up describing two different people,
// so isOwnerRequest is gone from the factory rather than left inert.
const OWNER_ID = "user-owner";
const ownerUser = () => ({
  id: OWNER_ID,
  role: "owner" as const,
  workspaceId: OWNER_WS,
  provider: "gitlab",
  handle: "owner",
});
const MEMBER_ID = "user-member";
const memberUser = () => ({
  id: MEMBER_ID,
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
  // #244 — won the race unless a spec says otherwise. `clearAllMocks` wipes
  // return values as well as calls, and an `updateMany` answering `undefined`
  // would read as "lost" on every single spec in this file.
  itemUpdateManyMock.mockResolvedValue({ count: 1 });
  taskDeleteManyMock.mockResolvedValue({ count: 1 });
});

describe("scheduleSingleTask", () => {
  // #118 Phase C — a member scheduling a single to-do against THEIR OWN Google
  // connection is the intended behaviour now. #119's role negative is not
  // deleted, it moves to "no account at all" (a guest, or a revoked account).
  it("lets a MEMBER schedule against their OWN credential (was 403 in #119)", async () => {
    workspaceMock.mockResolvedValue("ws-member");
    currentUserMock.mockResolvedValue(memberUser());
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

    expect(await scheduleSingleTask("item-1", 30)).toEqual({ ok: true });
    // Their own row, by their own id — and never the owner's.
    expect(tokenMock).toHaveBeenCalledWith(MEMBER_ID);
    expect(tokenMock).not.toHaveBeenCalledWith(OWNER_ID);
  });

  it("refuses a caller with no signed-in account, touching Google not at all", async () => {
    workspaceMock.mockResolvedValue("guest-ws");
    currentUserMock.mockResolvedValue(null);
    configuredMock.mockReturnValue(true);
    await expect(scheduleSingleTask("item-1", 30)).rejects.toThrow(
      /sign in required/,
    );
    expect(tokenMock).not.toHaveBeenCalled();
    expect(itemFindFirstMock).not.toHaveBeenCalled();
    expect(upsertGoogleTaskMock).not.toHaveBeenCalled();
  });

  it("resolves the token for the ACTING user, never a fixed id", async () => {
    // #118 — no id parameter exists on this action; the credential is reached BY
    // the acting account, so there is no other row to point at.
    workspaceMock.mockResolvedValue(OWNER_WS);
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
    // #244 — the precondition is IN the write. `taskId: null` is what makes a
    // second caller's link match zero rows instead of overwriting the first's,
    // and `workspaceId` puts the scope on the write rather than inheriting it
    // from the read above. Asserted here as a shape; the behaviour it buys needs
    // a real row lock and is proved in `schedule-single-task.integration.test.ts`.
    expect(itemUpdateManyMock).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "item-2", workspaceId: OWNER_WS, taskId: null },
        data: expect.objectContaining({ taskId: "task-2" }),
      }),
    );
    expect(taskDeleteManyMock).not.toHaveBeenCalled();
    expect(taskUpdateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "task-2" },
        data: expect.objectContaining({ googleTaskId: "gtask-3" }),
      }),
    );
  });

  /**
   * #244 — the adopt branch, in shape. Two callers can both read `taskId: null`
   * from a snapshot taken before either wrote, because that read takes no lock;
   * the guard is the `taskId: null` term in the link's `where`, and a `count: 0`
   * is how the loser learns it lost.
   */
  it("adopts the winner's Task and drops its own when the link matches nothing", async () => {
    workspaceMock.mockResolvedValue(OWNER_WS);
    configuredMock.mockReturnValue(true);
    tokenMock.mockResolvedValue("tok");
    itemFindFirstMock
      // The pre-lock snapshot: no Task yet, so the branch is entered.
      .mockResolvedValueOnce({
        id: "item-2",
        text: "Water the plants",
        taskId: null,
        task: null,
      })
      // The re-read inside the transaction, after the losing link.
      .mockResolvedValueOnce({
        taskId: "task-winner",
        task: { notes: "can under the sink", scheduledAt: null },
      });
    taskCreateMock.mockResolvedValue({ id: "task-loser" });
    itemUpdateManyMock.mockResolvedValue({ count: 0 });
    findReclaimListMock.mockResolvedValue({ id: "list-9", title: "🗓 Reclaim" });
    upsertGoogleTaskMock.mockResolvedValue({ id: "gtask-4", created: true });

    const res = await scheduleSingleTask("item-2", 15);

    // A lost race is not an error to raise at somebody who pressed a button
    // twice — the schedule still happens, against the Task that already exists.
    expect(res).toEqual({ ok: true });
    // The Task nobody outside the transaction saw is gone, so the orphan this
    // whole guard is about never reaches the database.
    //
    // Asserted as the WHOLE call including `workspaceId` (Duo review), so
    // dropping that term fails HERE rather than only in a cross-tenant scenario
    // nobody has written a test for.
    expect(taskDeleteManyMock).toHaveBeenCalledWith({
      where: { id: "task-loser", workspaceId: OWNER_WS },
    });
    expect(taskDeleteMock).not.toHaveBeenCalled();
    // And the schedule lands on the ADOPTED row, not on the discarded one.
    expect(taskUpdateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "task-winner" },
        data: expect.objectContaining({ googleTaskId: "gtask-4" }),
      }),
    );
    // The note comes from the adopted row too. Derived from the pre-lock
    // snapshot it would have been null, because `item.task` is null BY
    // CONSTRUCTION on the path that enters this branch (#179 review, `!281`,
    // one case wider).
    // Stringified rather than reached into, the same way the #179 spec below
    // does: the encoder owns which field of its payload the note lands in, and
    // this spec is about the note travelling at all.
    expect(JSON.stringify(upsertGoogleTaskMock.mock.calls[0][3])).toContain(
      "can under the sink",
    );
  });

  /**
   * #244 — the reward marker is re-read from the winner for the same reason the
   * note is. A winner that has already stamped `scheduledAt` must not be paid
   * for again, and the pre-lock snapshot says "never scheduled" about a `Task`
   * that did not exist when it was taken.
   */
  it("does not re-award when the Task it adopts was already scheduled", async () => {
    workspaceMock.mockResolvedValue(OWNER_WS);
    configuredMock.mockReturnValue(true);
    tokenMock.mockResolvedValue("tok");
    itemFindFirstMock
      .mockResolvedValueOnce({
        id: "item-2",
        text: "Water the plants",
        taskId: null,
        task: null,
      })
      .mockResolvedValueOnce({
        taskId: "task-winner",
        task: { notes: null, scheduledAt: new Date("2026-08-01T10:00:00Z") },
      });
    taskCreateMock.mockResolvedValue({ id: "task-loser" });
    itemUpdateManyMock.mockResolvedValue({ count: 0 });
    findReclaimListMock.mockResolvedValue({ id: "list-9", title: "🗓 Reclaim" });

    expect(await scheduleSingleTask("item-2", 15)).toEqual({ ok: true });

    expect(logReward).not.toHaveBeenCalled();
    expect(awardBadge).not.toHaveBeenCalled();
    // And the marker is not restamped either — it is a FIRST-schedule fact.
    expect(taskUpdateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "task-winner" },
        data: expect.not.objectContaining({ scheduledAt: expect.anything() }),
      }),
    );
  });

  /**
   * #244 — the other reason a link can match nothing: the row is gone, or is not
   * this workspace's. Reported as the same RESULT the read above gives for a
   * missing item rather than thrown, because it is reachable by scheduling a row
   * a second tab has just deleted.
   */
  it("reports the item as not found when the row has gone, and calls Google not at all", async () => {
    workspaceMock.mockResolvedValue(OWNER_WS);
    configuredMock.mockReturnValue(true);
    tokenMock.mockResolvedValue("tok");
    itemFindFirstMock
      .mockResolvedValueOnce({
        id: "item-2",
        text: "Water the plants",
        taskId: null,
        task: null,
      })
      .mockResolvedValueOnce(null);
    taskCreateMock.mockResolvedValue({ id: "task-loser" });
    itemUpdateManyMock.mockResolvedValue({ count: 0 });

    expect(await scheduleSingleTask("item-2", 15)).toEqual({
      ok: false,
      reason: "error",
      message: "Item not found",
    });

    expect(taskDeleteManyMock).toHaveBeenCalledWith({
      where: { id: "task-loser", workspaceId: OWNER_WS },
    });
    expect(findReclaimListMock).not.toHaveBeenCalled();
    expect(upsertGoogleTaskMock).not.toHaveBeenCalled();
  });

  it("sets the provider-agnostic scheduled marker (scheduledVia='google') on success", async () => {
    workspaceMock.mockResolvedValue(OWNER_WS);
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

describe("scheduleSingleTask — the lazily-created Task's note reaches Google (#179)", () => {
  // Review finding on `!281`, and it is the self-contradiction shape again. This
  // MR made `brainDumpItemToTaskData` copy `item.notes` onto the new `Task`, but
  // the Google Task payload a few lines further down still read
  // `item.task?.notes`. `item.task` was fetched BEFORE the lazy-create branch, so
  // in the `!taskId` path it is always null — and the comment on that line said
  // exactly that ("a task that did not exist a moment ago has no note"), which was
  // true before this MR and false after it.
  //
  // Net effect: a note captured with #179's inline `{...}` syntax was persisted to
  // `Task.notes` and silently dropped from the Google Task, surfacing only if
  // someone later opened the task page. The opposite of what #179 exists to do.
  it("carries the note into the Google Task payload on first schedule", async () => {
    process.env.PUBLIC_ORIGIN = "https://app.example";
    workspaceMock.mockResolvedValue("ws-1");
    currentUserMock.mockResolvedValue({ id: OWNER_ID, role: "owner" });
    getSettingsMock.mockResolvedValue({ voice: "plain" });
    tokenMock.mockResolvedValue("tok");
    // No linked Task yet — the lazy-create path — and the ITEM carries the note.
    itemFindFirstMock.mockResolvedValue({
      id: "item-1",
      text: "Call the dentist",
      taskId: null,
      task: null,
      notes: "ask about the crown",
    });
    taskCreateMock.mockResolvedValue({
      id: "task-new",
      notes: "ask about the crown",
    });
    findReclaimListMock.mockResolvedValue({ id: "list-9", title: "🗓 Reclaim" });
    upsertGoogleTaskMock.mockResolvedValue({ id: "gtask-9", created: true });

    const res = await scheduleSingleTask("item-1", 45);
    expect(res).toEqual({ ok: true });

    // The Task really was created carrying the note — the control, so that a
    // failure below means "the payload dropped it" rather than "nothing wrote it".
    expect(taskCreateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ notes: "ask about the crown" }),
      }),
    );

    // And the Google Task's own notes field carries it too. Asserted on the
    // payload rather than on an internal variable, because the user-visible
    // failure was in Google, not in Postgres.
    const payload = upsertGoogleTaskMock.mock.calls[0][3];
    expect(JSON.stringify(payload)).toContain("ask about the crown");

    // Cleaned up, matching the "sends the full intent for a stepless to-do" case
    // earlier in this file. Review round on `!281`: vitest runs a file's specs
    // sequentially and `process.env` mutations persist across `it` blocks, so
    // leaving this set would leak into whatever runs next — a flake planted for
    // whoever adds the next spec to this block, not for me.
    delete process.env.PUBLIC_ORIGIN;
  });
});
