import { describe, it, expect, vi, beforeEach } from "vitest";

const { tx, db } = vi.hoisted(() => {
  const tx = {
    brainDumpItem: { deleteMany: vi.fn() },
    step: { deleteMany: vi.fn() },
    breakdownTurn: { deleteMany: vi.fn() },
    focusSession: { deleteMany: vi.fn() },
    dayRollup: { deleteMany: vi.fn() },
    rewardEvent: { deleteMany: vi.fn() },
    streak: { deleteMany: vi.fn() },
    streakRecord: { deleteMany: vi.fn() },
    badge: { deleteMany: vi.fn() },
    dailySpark: { deleteMany: vi.fn() },
    settings: { deleteMany: vi.fn() },
    task: { deleteMany: vi.fn() },
    workspace: { delete: vi.fn() },
    guestDailyActivity: { deleteMany: vi.fn() },
    guestAiUsage: { deleteMany: vi.fn() },
  };
  const db = {
    $transaction: vi.fn(async (input: unknown) => {
      // Handle both callback-based and array-based transactions
      if (typeof input === "function") {
        return input(tx);
      }
      // Array-based transaction
      if (Array.isArray(input)) {
        return Promise.all(input);
      }
      return input;
    }),
    workspace: { findMany: vi.fn() },
    guestDailyActivity: { deleteMany: vi.fn() },
    guestAiUsage: { deleteMany: vi.fn() },
  };
  return { tx, db };
});

vi.mock("@/lib/db", () => ({ prisma: db }));

import { purgeWorkspace, purgeExpiredGuests, purgeStaleGuestCounters } from "./purge";

beforeEach(() => vi.clearAllMocks());

describe("purgeWorkspace", () => {
  it("refuses to purge the owner workspace", async () => {
    await expect(purgeWorkspace("owner")).rejects.toThrow();
    expect(db.$transaction).not.toHaveBeenCalled();
  });
  it("deletes across scoped models then the workspace row", async () => {
    await purgeWorkspace("guest-123");
    // Relation-filtered children (cascade via Task)
    expect(tx.step.deleteMany).toHaveBeenCalledWith({ where: { task: { workspaceId: "guest-123" } } });
    expect(tx.breakdownTurn.deleteMany).toHaveBeenCalledWith({ where: { task: { workspaceId: "guest-123" } } });
    // Direct-workspaceId models
    expect(tx.brainDumpItem.deleteMany).toHaveBeenCalledWith({ where: { workspaceId: "guest-123" } });
    expect(tx.focusSession.deleteMany).toHaveBeenCalledWith({ where: { workspaceId: "guest-123" } });
    expect(tx.dayRollup.deleteMany).toHaveBeenCalledWith({ where: { workspaceId: "guest-123" } });
    expect(tx.rewardEvent.deleteMany).toHaveBeenCalledWith({ where: { workspaceId: "guest-123" } });
    expect(tx.streak.deleteMany).toHaveBeenCalledWith({ where: { workspaceId: "guest-123" } });
    expect(tx.streakRecord.deleteMany).toHaveBeenCalledWith({ where: { workspaceId: "guest-123" } });
    expect(tx.badge.deleteMany).toHaveBeenCalledWith({ where: { workspaceId: "guest-123" } });
    expect(tx.dailySpark.deleteMany).toHaveBeenCalledWith({ where: { workspaceId: "guest-123" } });
    expect(tx.settings.deleteMany).toHaveBeenCalledWith({ where: { workspaceId: "guest-123" } });
    expect(tx.task.deleteMany).toHaveBeenCalledWith({ where: { workspaceId: "guest-123" } });
    // Workspace row last
    expect(tx.workspace.delete).toHaveBeenCalledWith({ where: { id: "guest-123" } });
  });
});

describe("purgeExpiredGuests", () => {
  it("purges each expired guest and returns the count", async () => {
    db.workspace.findMany.mockResolvedValue([{ id: "g1" }, { id: "g2" }]);
    const n = await purgeExpiredGuests();
    expect(n).toBe(2);
  });
});

describe("purgeStaleGuestCounters", () => {
  it("deletes GuestDailyActivity and GuestAiUsage older than days (default 30)", async () => {
    const now = new Date("2026-07-18T00:00:00Z");
    db.guestDailyActivity.deleteMany.mockResolvedValue({ count: 5 });
    db.guestAiUsage.deleteMany.mockResolvedValue({ count: 3 });

    const result = await purgeStaleGuestCounters(now, 30);

    // Cutoff = now - 30 days = 2026-06-18
    const expectedCutoffDay = "2026-06-18";
    const expectedCutoffDate = new Date("2026-06-18T00:00:00Z");

    expect(db.guestDailyActivity.deleteMany).toHaveBeenCalledWith({
      where: { day: { lt: expectedCutoffDay } },
    });
    expect(db.guestAiUsage.deleteMany).toHaveBeenCalledWith({
      where: { updatedAt: { lt: expectedCutoffDate } },
    });
    expect(result).toEqual({ dailyActivity: 5, aiUsage: 3 });
  });

  it("uses default days=30 when omitted", async () => {
    const now = new Date("2026-07-18T00:00:00Z");
    db.guestDailyActivity.deleteMany.mockResolvedValue({ count: 0 });
    db.guestAiUsage.deleteMany.mockResolvedValue({ count: 0 });

    await purgeStaleGuestCounters(now); // no days param

    // Should still use 30 days as default
    const expectedCutoffDay = "2026-06-18";
    expect(db.guestDailyActivity.deleteMany).toHaveBeenCalledWith({
      where: { day: { lt: expectedCutoffDay } },
    });
  });

  it("uses current date when now is omitted", async () => {
    db.guestDailyActivity.deleteMany.mockResolvedValue({ count: 1 });
    db.guestAiUsage.deleteMany.mockResolvedValue({ count: 2 });

    await purgeStaleGuestCounters(undefined, 30);

    // Just verify it was called; exact date will be close to current time
    expect(db.guestDailyActivity.deleteMany).toHaveBeenCalled();
  });

  it("wraps deletes in a transaction", async () => {
    const now = new Date("2026-07-18T00:00:00Z");
    db.guestDailyActivity.deleteMany.mockResolvedValue({ count: 1 });
    db.guestAiUsage.deleteMany.mockResolvedValue({ count: 1 });

    await purgeStaleGuestCounters(now, 30);

    expect(db.$transaction).toHaveBeenCalled();
  });
});
