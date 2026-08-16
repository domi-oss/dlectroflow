/**
 * Tests for bulkBrainDumpAction.
 *
 * The brief's draft test self-mocked this module (`vi.mock("./braindump", …)`)
 * to spy on the per-item actions it reuses. Self-mocking a module under test
 * to intercept its own sibling exports is fragile in ESM/vitest (the mocked
 * exports don't reliably rebind the internal call sites). Instead this
 * mirrors the established pattern in snooze.test.ts / complete.test.ts:
 * mock at the `prisma` level and assert the REAL effects produced by the
 * real completeItem / snoozeBrainDumpItem / deleteBrainDumpItem functions
 * running underneath bulkBrainDumpAction. That verifies actual behavior
 * (workspace filtering, per-action routing, resulting prisma calls) rather
 * than just that a mock was invoked.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { prismaMock, revalidatePathMock, currentWorkspaceIdMock } = vi.hoisted(
  () => {
    const prismaMock = {
      brainDumpItem: {
        findMany: vi.fn(),
        findFirst: vi.fn(),
        update: vi.fn().mockResolvedValue({}),
        // #251 — deleteBrainDumpItem claims the row's completion with a guarded
        // updateMany before deleting it. `count: 0` here: these fixtures are
        // uncompleted items, so nothing is claimed and nothing is reversed.
        updateMany: vi.fn().mockResolvedValue({ count: 0 }),
        deleteMany: vi.fn().mockResolvedValue({ count: 1 }),
        count: vi.fn().mockResolvedValue(0),
      },
      step: {
        updateMany: vi.fn().mockResolvedValue({ count: 0 }),
        // #233 — `completeItem` closes a to-do's open steps with
        // `updateManyAndReturn`, because the rows it turned not-done → done are
        // the only source of truth for what the payout and the Google patch list
        // both owe. It resolves to an ARRAY OF ROWS, not a `{ count }` — same
        // default (`[]`, nothing closed) and same shape as complete.test.ts's
        // mock, so the two files cannot disagree about what the write returns. A
        // stub of the wrong shape would be worse than none: `is not a function`
        // is loud, whereas a count here would silently make `closed.steps`
        // un-iterable or empty and turn a payout bug into a passing test (#160).
        updateManyAndReturn: vi.fn().mockResolvedValue([]),
        // #251 — the done steps a delete destroys, and so the step_done rows it
        // owes back. None here, for the same reason.
        count: vi.fn().mockResolvedValue(0),
      },
      task: {
        update: vi.fn().mockResolvedValue({}),
        deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
      },
      $transaction: vi.fn(),
    };
    // deleteBrainDumpItem (#64) wraps its item delete + orphan-cleanup Task
    // delete in a transaction — run the callback against this same mock, as
    // in complete.test.ts.
    prismaMock.$transaction.mockImplementation((arg: unknown) =>
      typeof arg === "function"
        ? (arg as (tx: unknown) => unknown)(prismaMock)
        : Promise.all(arg as Promise<unknown>[]),
    );
    return {
      prismaMock,
      revalidatePathMock: vi.fn(),
      currentWorkspaceIdMock: vi.fn().mockResolvedValue("ws1"),
    };
  },
);
vi.mock("next/cache", () => ({ revalidatePath: revalidatePathMock }));
vi.mock("@/lib/db", () => ({ prisma: prismaMock }));
vi.mock("@/lib/workspace", () => ({
  currentWorkspaceId: currentWorkspaceIdMock,
  isOwnerRequest: vi.fn().mockResolvedValue(true),
  MissingWorkspaceError: class extends Error {},
}));
vi.mock("@/lib/rewards", () => ({
  // #233 — this file deletes items through the bulk action, so it reaches the
  // engagement ledger. "Credited no day" is the right default here: the streak
  // revocation is handed an empty set and is a no-op, which keeps this file's
  // question (the IDOR filter) the only thing it asserts.
  engagementDaysOfItem: vi.fn().mockResolvedValue([]),
  engagementDaysNowEmpty: vi.fn().mockResolvedValue([]),
  revokeUnqualifiedStreakBadges: vi.fn().mockResolvedValue([]),
  touchStreakOnEngagement: vi.fn().mockResolvedValue(null),
  maybeAwardInboxZero: vi.fn().mockResolvedValue(undefined),
  maybeAwardTenStepsDay: vi.fn().mockResolvedValue(undefined),
  // #265 — see the note in `complete.test.ts`: the per-step quantity is asserted
  // on the callee in `rewards.test.ts`, the count handed to it is asserted here.
  rewardCompletedSteps: vi.fn().mockResolvedValue(undefined),
  logReward: vi.fn().mockResolvedValue(undefined),
  awardBadge: vi.fn().mockResolvedValue(undefined),
  touchStreakOnCompletion: vi.fn().mockResolvedValue(null),
  // #251 — a bulk delete routes through deleteBrainDumpItem, which now reverses
  // what each row banked. Stubbed as "took nothing": the reversal's own arithmetic
  // is proved in delete-completed-item.integration.test.ts, and what this file
  // asks about is the workspace filtering and the per-action routing.
  reverseItemCompletionRewards: vi
    .fn()
    .mockResolvedValue({ stepDone: 0, taskComplete: false }),
  revokeUnqualifiedBadges: vi.fn().mockResolvedValue([]),
}));

beforeEach(async () => {
  vi.clearAllMocks();
  currentWorkspaceIdMock.mockResolvedValue("ws1");
  prismaMock.brainDumpItem.updateMany.mockResolvedValue({ count: 0 });
  prismaMock.step.count.mockResolvedValue(0);
  // Re-armed for the same reason as the two above: the task-branch spec sets a
  // persistent value, and `clearAllMocks` clears calls but not implementations.
  // Persistent rather than a `mockResolvedValueOnce`, deliberately — a queued
  // once-value that its spec never reaches survives into the next spec and shifts
  // the whole file by one, which is the failure complete.test.ts's seed helper
  // carries a warning about (it cost seven bogus Google-sync failures in #233).
  prismaMock.step.updateManyAndReturn.mockResolvedValue([]);
  // Nothing re-arms the two reward stubs: `clearAllMocks` leaves a
  // `mockResolvedValue` set in the mock factory intact, and no spec in this file
  // queues a `mockResolvedValueOnce` on them. Stated because the sibling file
  // DOES re-arm, and for a different reason (#168's once-queue leak).
  // Each per-item action re-fetches the item by id (defense in depth beyond
  // bulkBrainDumpAction's own workspace filter) — keep it "found" by default.
  prismaMock.brainDumpItem.findFirst.mockImplementation(
    ({ where }: { where: { id: string } }) =>
      Promise.resolve({ id: where.id, completedAt: null, task: null }),
  );
});

describe("bulkBrainDumpAction", () => {
  it("filters ids to the caller's workspace before acting (IDOR guard) and returns the owned count", async () => {
    prismaMock.brainDumpItem.findMany.mockResolvedValueOnce([
      { id: "a" },
      { id: "b" },
    ]); // "c" not owned
    const { bulkBrainDumpAction } = await import("./braindump");

    const res = await bulkBrainDumpAction(["a", "b", "c"], "delete");

    expect(prismaMock.brainDumpItem.findMany).toHaveBeenCalledWith({
      where: { id: { in: ["a", "b", "c"] }, workspaceId: "ws1" },
      select: { id: true },
    });
    expect(prismaMock.brainDumpItem.deleteMany).toHaveBeenCalledTimes(2);
    expect(prismaMock.brainDumpItem.deleteMany).toHaveBeenCalledWith({
      where: { id: "a", workspaceId: "ws1" },
    });
    expect(prismaMock.brainDumpItem.deleteMany).toHaveBeenCalledWith({
      where: { id: "b", workspaceId: "ws1" },
    });
    expect(prismaMock.brainDumpItem.deleteMany).not.toHaveBeenCalledWith({
      where: { id: "c", workspaceId: "ws1" },
    });
    expect(res).toEqual({ count: 2 });
  });

  it("routes saveForLater through the real 60-minute snooze (status=inbox, snoozedUntil ~60min out)", async () => {
    prismaMock.brainDumpItem.findMany.mockResolvedValueOnce([{ id: "a" }]);
    const { bulkBrainDumpAction } = await import("./braindump");
    const before = Date.now();

    const res = await bulkBrainDumpAction(["a"], "saveForLater");

    expect(prismaMock.brainDumpItem.update).toHaveBeenCalledTimes(1);
    const call = prismaMock.brainDumpItem.update.mock.calls[0][0];
    expect(call.where).toEqual({ id: "a" });
    expect(call.data.status).toBe("inbox");
    expect(call.data.snoozedUntil).toBeInstanceOf(Date);
    // 60-minute snooze: future timestamp at least ~59 minutes out.
    expect(call.data.snoozedUntil.getTime()).toBeGreaterThan(
      before + 59 * 60_000,
    );
    expect(res).toEqual({ count: 1 });
  });

  it("routes complete through the real completeItem path (stamps completedAt + awards TaskComplete)", async () => {
    prismaMock.brainDumpItem.findMany.mockResolvedValueOnce([{ id: "a" }]);
    // #233 — `completeItem` now stamps the completion through a guarded
    // `updateMany` and pays out only on its count, so this spec has to say the
    // write MATCHED. The file-wide default is `{ count: 0 }`, which is the right
    // default for `deleteBrainDumpItem` (these fixtures are uncompleted, so it
    // claims nothing) and exactly wrong here: one mock, two callers, opposite
    // meanings. Stated locally rather than by changing the default, which would
    // silently turn the delete specs into assertions about a reversal that never
    // runs.
    prismaMock.brainDumpItem.updateMany.mockResolvedValue({ count: 1 });
    const { bulkBrainDumpAction } = await import("./braindump");
    const rewards = await import("@/lib/rewards");

    const res = await bulkBrainDumpAction(["a"], "complete");

    expect(prismaMock.brainDumpItem.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        // The precondition is the guard, so it is named here: `completedAt: null`
        // is what makes a second concurrent completion match nothing, and the
        // scope travels in the write's own arguments.
        where: { id: "a", workspaceId: "ws1", completedAt: null },
        data: expect.objectContaining({ completedAt: expect.any(Date) }),
      }),
    );
    expect(rewards.logReward).toHaveBeenCalledWith("ws1", "task_complete");
    expect(res).toEqual({ count: 1 });
  });

  it("routes complete for a to-do WITH a task through the guarded step write (one step_done per step it closed)", async () => {
    prismaMock.brainDumpItem.findMany.mockResolvedValueOnce([{ id: "a" }]);
    prismaMock.brainDumpItem.updateMany.mockResolvedValue({ count: 1 });
    // The file-wide `findFirst` fixture is `task: null`, which routes every other
    // spec here down the stepless branch — so the task branch of `completeItem`
    // had no coverage in this file at all, and the `step.updateManyAndReturn`
    // stub it needs was missing without anything being red. Overridden for this
    // one spec rather than by loosening the shared fixture, which would push
    // every other spec through the step write they are not about.
    //
    // Both Google address halves are null on the task and on the rows the write
    // reports, so `completeGoogleTasksForItem` filters the patch queue to empty
    // and returns before it resolves a token (#209) — that is what keeps this a
    // unit test without this file having to mock `@/lib/google-task-sync`.
    prismaMock.brainDumpItem.findFirst.mockResolvedValueOnce({
      id: "a",
      completedAt: null,
      task: {
        id: "t1",
        googleTaskId: null,
        googleTaskListId: null,
        steps: [
          { id: "s1", done: true },
          { id: "s2", done: false },
          { id: "s3", done: false },
        ],
      },
    });
    // #233 — the payout is counted off the rows the WRITE reports turning
    // not-done → done, not off the snapshot above, so the two have to be stated
    // to agree the way real Postgres would: `done: false` in the where drops the
    // already-done `s1`, leaving two rows.
    prismaMock.step.updateManyAndReturn.mockResolvedValue([
      { googleTaskId: null, googleTaskListId: null },
      { googleTaskId: null, googleTaskListId: null },
    ]);
    const { bulkBrainDumpAction } = await import("./braindump");
    const rewards = await import("@/lib/rewards");

    const res = await bulkBrainDumpAction(["a"], "complete");

    expect(prismaMock.step.updateManyAndReturn).toHaveBeenCalledWith({
      where: { taskId: "t1", done: false, task: { workspaceId: "ws1" } },
      data: { done: true },
      select: { googleTaskId: true, googleTaskListId: true },
    });
    // Inside the same transaction as the two writes above: a bulk complete must
    // not be able to leave a to-do completed with its task still Active.
    expect(prismaMock.task.update).toHaveBeenCalledWith({
      where: { id: "t1" },
      data: { status: "done" },
    });
    expect(rewards.rewardCompletedSteps).toHaveBeenCalledWith("ws1", 2);
    expect(rewards.logReward).toHaveBeenCalledWith("ws1", "task_complete");
    expect(revalidatePathMock).toHaveBeenCalledWith("/tasks/t1");
    expect(res).toEqual({ count: 1 });
  });

  it("no-ops on empty input without querying the workspace", async () => {
    const { bulkBrainDumpAction } = await import("./braindump");
    const res = await bulkBrainDumpAction([], "complete");
    expect(res).toEqual({ count: 0 });
    expect(prismaMock.brainDumpItem.findMany).not.toHaveBeenCalled();
  });
});
