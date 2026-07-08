import { describe, it, expect, vi, beforeEach } from "vitest";

const db = vi.hoisted(() => ({
  guestAiUsage: { findUnique: vi.fn(), upsert: vi.fn(), update: vi.fn() },
  guestDailyActivity: { findUnique: vi.fn(), count: vi.fn(), create: vi.fn() },
}));

vi.mock("@/lib/db", () => ({ prisma: db }));

import { clientIpHash, consumeGuestBreakdown, peekGuestAllowance, refundGuestBreakdown } from "./guest-quota";

beforeEach(() => {
  vi.clearAllMocks();
  process.env.GUEST_IP_HASH_SALT = "test-salt";
  process.env.GUEST_AI_QUOTA_PER_WINDOW = "5";
  process.env.GUEST_AI_WINDOW_HOURS = "24";
  process.env.GUEST_GLOBAL_DAILY_GUEST_CAP = "10";
});

describe("clientIpHash", () => {
  it("hashes the leftmost x-forwarded-for IP deterministically", () => {
    const h = new Headers({ "x-forwarded-for": "1.2.3.4, 5.6.7.8" });
    const a = clientIpHash(h);
    const b = clientIpHash(new Headers({ "x-forwarded-for": "1.2.3.4" }));
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });
  it("returns null when no IP header present", () => {
    expect(clientIpHash(new Headers())).toBeNull();
  });
  it("x-real-ip fallback: returns a 64-hex string when only x-real-ip is present", () => {
    const hash = clientIpHash(new Headers({ "x-real-ip": "9.9.9.9" }));
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("consumeGuestBreakdown", () => {
  it("allows and increments when under quota and under global cap", async () => {
    db.guestDailyActivity.findUnique.mockResolvedValue(null);
    db.guestDailyActivity.count.mockResolvedValue(3);
    db.guestAiUsage.findUnique.mockResolvedValue({ count: 1, windowStartedAt: new Date() });
    db.guestAiUsage.upsert.mockResolvedValue({});
    const r = await consumeGuestBreakdown("iphash");
    expect(r.allowed).toBe(true);
    expect(r.remaining).toBe(3); // 5 - (1+1)
  });
  it("blocks with reason=quota when the per-IP window is exhausted", async () => {
    db.guestDailyActivity.findUnique.mockResolvedValue({ day: "x", ipHash: "iphash" });
    db.guestAiUsage.findUnique.mockResolvedValue({ count: 5, windowStartedAt: new Date() });
    const r = await consumeGuestBreakdown("iphash");
    expect(r.allowed).toBe(false);
    expect(r.reason).toBe("quota");
  });
  it("blocks a NEW guest with reason=global_cap when the day is full", async () => {
    db.guestDailyActivity.findUnique.mockResolvedValue(null); // not counted today
    db.guestDailyActivity.count.mockResolvedValue(10); // cap reached
    db.guestAiUsage.findUnique.mockResolvedValue({ count: 0, windowStartedAt: new Date() });
    const r = await consumeGuestBreakdown("iphash");
    expect(r.allowed).toBe(false);
    expect(r.reason).toBe("global_cap");
  });
  it("window-expiry reset: allows when window is older than 24h and resets count", async () => {
    const expiredStart = new Date(Date.now() - 25 * 3600_000);
    db.guestAiUsage.findUnique.mockResolvedValue({ count: 5, windowStartedAt: expiredStart });
    db.guestDailyActivity.findUnique.mockResolvedValue({ day: "x", ipHash: "iphash" }); // already counted today
    db.guestAiUsage.upsert.mockResolvedValue({});
    const r = await consumeGuestBreakdown("iphash");
    expect(r.allowed).toBe(true);
    expect(r.remaining).toBe(4); // fresh window: 5 - 1
    expect(db.guestAiUsage.upsert).toHaveBeenCalledTimes(1);
  });
});

describe("peekGuestAllowance", () => {
  it("returns full quota when no row exists and never writes", async () => {
    db.guestAiUsage.findUnique.mockResolvedValue(null);
    const result = await peekGuestAllowance("iphash");
    expect(result.remaining).toBe(5);
    expect(db.guestAiUsage.upsert).not.toHaveBeenCalled();
    expect(db.guestAiUsage.update).not.toHaveBeenCalled();
  });
});

describe("refundGuestBreakdown", () => {
  it("decrements count when row exists with count > 0", async () => {
    db.guestAiUsage.findUnique.mockResolvedValue({ ipHash: "iphash", count: 3, windowStartedAt: new Date() });
    db.guestAiUsage.update.mockResolvedValue({});
    await refundGuestBreakdown("iphash");
    expect(db.guestAiUsage.update).toHaveBeenCalledWith({
      where: { ipHash: "iphash" },
      data: { count: { decrement: 1 } },
    });
  });
  it("does NOT call update when no row exists", async () => {
    db.guestAiUsage.findUnique.mockResolvedValue(null);
    await refundGuestBreakdown("iphash");
    expect(db.guestAiUsage.update).not.toHaveBeenCalled();
  });
  it("does NOT call update when count is 0", async () => {
    db.guestAiUsage.findUnique.mockResolvedValue({ ipHash: "iphash", count: 0, windowStartedAt: new Date() });
    await refundGuestBreakdown("iphash");
    expect(db.guestAiUsage.update).not.toHaveBeenCalled();
  });
});
