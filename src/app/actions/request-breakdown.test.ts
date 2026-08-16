/**
 * Action tests for requestBreakdown + breakdownRequestedAt lifecycle.
 *
 * Dropping onto Multi-step moves the item immediately: triaged +
 * breakdownRequestedAt stamped, so it sits in the Multi-step bucket with a
 * "Break into steps now?" call-to-action instead of a blocking prompt.
 * Any move to another bucket (triage / snooze / moveToReview / complete /
 * keepAsTask) clears the stamp — moving out means you changed your mind.
 *
 * Mirrors the vi.mock shape used in snooze.test.ts.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const { prismaMock, revalidatePathMock, currentWorkspaceIdMock } = vi.hoisted(
  () => {
    const prismaMock = {
      brainDumpItem: {
        findFirst: vi.fn(),
        update: vi.fn().mockResolvedValue({}),
        // `{ count: 1 }`, not `{}` — #233 gave `completeItem` a guarded write
        // that BRANCHES on this count, and a bare `{}` reads as `undefined`,
        // which happens to fall through the wrong side of the guard for the
        // wrong reason. Every guarded bulk write in this action file reports a
        // count; the mock says so too.
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        // #225 — `keepAsTask`'s guarded triage stamp. Returns the row AS
        // UPDATED, which is where it reads back whether the item already has a
        // Task; `[]` would mean the row is gone.
        updateManyAndReturn: vi.fn().mockResolvedValue([{ taskId: null }]),
      },
      task: {
        create: vi.fn().mockResolvedValue({ id: "t1" }),
      },
      // Pass-through: the callback gets the same delegates, so shape assertions
      // read the same mocks whether the write is inside a transaction or not.
      // What a mock cannot show is the row lock the guard actually depends on —
      // that is `keep-as-task.integration.test.ts`, against real Postgres.
      $transaction: vi.fn(<T>(fn: (tx: unknown) => Promise<T>) =>
        fn(prismaMock),
      ),
    };
    return {
      prismaMock,
      revalidatePathMock: vi.fn(),
      currentWorkspaceIdMock: vi.fn().mockResolvedValue("owner"),
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
  touchStreakOnEngagement: vi.fn().mockResolvedValue(null),
  // #233 — the ledger attributes a streak credit to the inbox item behind a
  // task. `null` is the ordinary answer for a task with no item, and is what
  // makes a credit permanent, so it is the right default for a file not asking
  // about attribution.
  itemIdForTask: vi.fn().mockResolvedValue(null),
  // #233 — "this item credited no day", so the streak revocation below is
  // handed an empty set and is a no-op. A file asking about the ledger sets
  // these up; every other file asserts the untouched-streak path.
  engagementDaysOfItem: vi.fn().mockResolvedValue([]),
  engagementDaysNowEmpty: vi.fn().mockResolvedValue([]),
  revokeUnqualifiedStreakBadges: vi.fn().mockResolvedValue([]),
  maybeAwardInboxZero: vi.fn().mockResolvedValue(undefined),
  maybeAwardTenStepsDay: vi.fn().mockResolvedValue(undefined),
  logReward: vi.fn().mockResolvedValue(undefined),
  awardBadge: vi.fn().mockResolvedValue(undefined),
  touchStreakOnCompletion: vi.fn().mockResolvedValue(null),
}));

beforeEach(() => {
  vi.clearAllMocks();
  currentWorkspaceIdMock.mockResolvedValue("owner");
});

describe("requestBreakdown", () => {
  it("no-ops when the item is missing", async () => {
    prismaMock.brainDumpItem.findFirst.mockResolvedValueOnce(null);
    const { requestBreakdown } = await import("./braindump");
    await requestBreakdown("nope");
    expect(prismaMock.brainDumpItem.update).not.toHaveBeenCalled();
  });

  it("triages + stamps breakdownRequestedAt + clears snoozedUntil", async () => {
    prismaMock.brainDumpItem.findFirst.mockResolvedValueOnce({ id: "i1" });
    const { requestBreakdown } = await import("./braindump");
    await requestBreakdown("i1");

    const call = prismaMock.brainDumpItem.update.mock.calls[0][0];
    expect(call.where).toEqual({ id: "i1" });
    expect(call.data.status).toBe("triaged");
    expect(call.data.triagedAt).toBeInstanceOf(Date);
    expect(call.data.breakdownRequestedAt).toBeInstanceOf(Date);
    expect(call.data.snoozedUntil).toBeNull();
    expect(revalidatePathMock).toHaveBeenCalledWith("/");
  });
});

describe("breakdownRequestedAt is cleared by every move out of Multi-step", () => {
  it("triageBrainDumpItem (→ Single-task) clears it", async () => {
    prismaMock.brainDumpItem.findFirst.mockResolvedValueOnce({ id: "i1" });
    const { triageBrainDumpItem } = await import("./braindump");
    await triageBrainDumpItem("i1");
    expect(
      prismaMock.brainDumpItem.update.mock.calls[0][0].data
        .breakdownRequestedAt,
    ).toBeNull();
  });

  it("snoozeBrainDumpItem (→ Saved for later) clears it", async () => {
    prismaMock.brainDumpItem.findFirst.mockResolvedValueOnce({ id: "i1" });
    const { snoozeBrainDumpItem } = await import("./braindump");
    await snoozeBrainDumpItem("i1", 60);
    expect(
      prismaMock.brainDumpItem.update.mock.calls[0][0].data
        .breakdownRequestedAt,
    ).toBeNull();
  });

  it("moveToReview (→ Needs review) clears it", async () => {
    prismaMock.brainDumpItem.findFirst.mockResolvedValueOnce({ id: "i1" });
    const { moveToReview } = await import("./braindump");
    await moveToReview("i1");
    expect(
      prismaMock.brainDumpItem.updateMany.mock.calls[0][0].data
        .breakdownRequestedAt,
    ).toBeNull();
  });

  // #233 — the stamp moved into the guarded write, the same way #225 moved
  // `keepAsTask`'s. `completeItem` now clears it on the `updateMany` whose
  // `completedAt: null` precondition is what stops a second concurrent
  // completion banking the rewards twice, so the clear is asserted where it now
  // lives rather than on the `update` that no longer runs.
  it("completeItem (→ Completed) clears it", async () => {
    prismaMock.brainDumpItem.findFirst.mockResolvedValueOnce({
      id: "i1",
      completedAt: null,
      task: null,
    });
    const { completeItem } = await import("./braindump");
    await completeItem("i1");
    expect(
      prismaMock.brainDumpItem.updateMany.mock.calls[0][0].data
        .breakdownRequestedAt,
    ).toBeNull();
  });

  // #225 — the stamp moved into the guarded write, so the clear is asserted
  // where it now lives. `update` here only links the new Task to the item.
  it("keepAsTask (→ Single-task with a task) clears it", async () => {
    prismaMock.brainDumpItem.updateManyAndReturn.mockResolvedValueOnce([
      { taskId: null, text: "x", notes: null },
    ]);
    const { keepAsTask } = await import("./braindump");
    await keepAsTask("i1");
    expect(
      prismaMock.brainDumpItem.updateManyAndReturn.mock.calls[0][0].data
        .breakdownRequestedAt,
    ).toBeNull();
  });
});
