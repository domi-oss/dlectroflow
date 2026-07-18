import { describe, it, expect, vi, beforeEach } from "vitest";

const { db } = vi.hoisted(() => {
  const db = {
    $transaction: vi.fn(async (input: unknown) => {
      // Handle both callback-based and array-based transactions
      if (typeof input === "function") {
        return input(db);
      }
      // Array-based transaction
      if (Array.isArray(input)) {
        return Promise.all(input);
      }
      return input;
    }),
    workspace: { findMany: vi.fn(), delete: vi.fn() },
    guestDailyActivity: { deleteMany: vi.fn() },
    guestAiUsage: { deleteMany: vi.fn() },
  };
  return { db };
});

vi.mock("@/lib/db", () => ({ prisma: db }));

import { purgeWorkspace, purgeExpiredGuests, purgeStaleGuestCounters } from "./purge";

beforeEach(() => vi.clearAllMocks());

describe("purgeWorkspace", () => {
  it("refuses to purge the owner workspace", async () => {
    await expect(purgeWorkspace("owner")).rejects.toThrow();
    expect(db.workspace.delete).not.toHaveBeenCalled();
  });
  it("deletes the workspace row (cascade removes scoped rows at the DB level)", async () => {
    await purgeWorkspace("guest-123");
    expect(db.workspace.delete).toHaveBeenCalledWith({ where: { id: "guest-123" } });
    expect(db.workspace.delete).toHaveBeenCalledTimes(1);
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
