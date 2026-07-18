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

const { prismaMock, revalidatePathMock, currentWorkspaceIdMock } = vi.hoisted(() => {
  const prismaMock = {
    brainDumpItem: {
      findMany: vi.fn(),
      findFirst: vi.fn(),
      update: vi.fn().mockResolvedValue({}),
      delete: vi.fn().mockResolvedValue({}),
    },
    step: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
    task: { update: vi.fn().mockResolvedValue({}) },
  };
  return {
    prismaMock,
    revalidatePathMock: vi.fn(),
    currentWorkspaceIdMock: vi.fn().mockResolvedValue("ws1"),
  };
});
vi.mock("next/cache", () => ({ revalidatePath: revalidatePathMock }));
vi.mock("@/lib/db", () => ({ prisma: prismaMock }));
vi.mock("@/lib/workspace", () => ({
  currentWorkspaceId: currentWorkspaceIdMock,
  isOwnerRequest: vi.fn().mockResolvedValue(true),
  MissingWorkspaceError: class extends Error {},
}));
vi.mock("@/lib/rewards", () => ({
  maybeAwardInboxZero: vi.fn().mockResolvedValue(undefined),
  maybeAwardTenStepsDay: vi.fn().mockResolvedValue(undefined),
  logReward: vi.fn().mockResolvedValue(undefined),
  awardBadge: vi.fn().mockResolvedValue(undefined),
  touchStreakOnCompletion: vi.fn().mockResolvedValue(null),
}));

beforeEach(() => {
  vi.clearAllMocks();
  currentWorkspaceIdMock.mockResolvedValue("ws1");
  // Each per-item action re-fetches the item by id (defense in depth beyond
  // bulkBrainDumpAction's own workspace filter) — keep it "found" by default.
  prismaMock.brainDumpItem.findFirst.mockImplementation(
    ({ where }: { where: { id: string } }) =>
      Promise.resolve({ id: where.id, completedAt: null, task: null }),
  );
});

describe("bulkBrainDumpAction", () => {
  it("filters ids to the caller's workspace before acting (IDOR guard) and returns the owned count", async () => {
    prismaMock.brainDumpItem.findMany.mockResolvedValueOnce([{ id: "a" }, { id: "b" }]); // "c" not owned
    const { bulkBrainDumpAction } = await import("./braindump");

    const res = await bulkBrainDumpAction(["a", "b", "c"], "delete");

    expect(prismaMock.brainDumpItem.findMany).toHaveBeenCalledWith({
      where: { id: { in: ["a", "b", "c"] }, workspaceId: "ws1" },
      select: { id: true },
    });
    expect(prismaMock.brainDumpItem.delete).toHaveBeenCalledTimes(2);
    expect(prismaMock.brainDumpItem.delete).toHaveBeenCalledWith({ where: { id: "a" } });
    expect(prismaMock.brainDumpItem.delete).toHaveBeenCalledWith({ where: { id: "b" } });
    expect(prismaMock.brainDumpItem.delete).not.toHaveBeenCalledWith({ where: { id: "c" } });
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
    expect(call.data.snoozedUntil.getTime()).toBeGreaterThan(before + 59 * 60_000);
    expect(res).toEqual({ count: 1 });
  });

  it("routes complete through the real completeItem path (stamps completedAt + awards TaskComplete)", async () => {
    prismaMock.brainDumpItem.findMany.mockResolvedValueOnce([{ id: "a" }]);
    const { bulkBrainDumpAction } = await import("./braindump");
    const rewards = await import("@/lib/rewards");

    const res = await bulkBrainDumpAction(["a"], "complete");

    expect(prismaMock.brainDumpItem.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "a" },
        data: expect.objectContaining({ completedAt: expect.any(Date) }),
      }),
    );
    expect(rewards.logReward).toHaveBeenCalledWith("ws1", "task_complete");
    expect(res).toEqual({ count: 1 });
  });

  it("no-ops on empty input without querying the workspace", async () => {
    const { bulkBrainDumpAction } = await import("./braindump");
    const res = await bulkBrainDumpAction([], "complete");
    expect(res).toEqual({ count: 0 });
    expect(prismaMock.brainDumpItem.findMany).not.toHaveBeenCalled();
  });
});
