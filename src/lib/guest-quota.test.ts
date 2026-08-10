import { describe, it, expect, vi, beforeEach } from "vitest";

const db = vi.hoisted(() => ({
  // #158: both inserts are `createMany({ skipDuplicates: true })` now, so a
  // duplicate resolves with `count: 0` instead of rejecting with P2002.
  // `create` is still mocked so a silent regression back to it is visible.
  guestAiUsage: {
    findUnique: vi.fn(),
    updateMany: vi.fn(),
    create: vi.fn(),
    createMany: vi.fn(),
    update: vi.fn(),
  },
  guestDailyActivity: {
    findUnique: vi.fn(),
    count: vi.fn(),
    create: vi.fn(),
    createMany: vi.fn(),
  },
}));

vi.mock("@/lib/db", () => ({ prisma: db }));

import {
  clientIpHash,
  consumeGuestBreakdown,
  peekGuestAllowance,
  refundGuestBreakdown,
} from "./guest-quota";

beforeEach(() => {
  vi.clearAllMocks();
  process.env.GUEST_IP_HASH_SALT = "test-salt";
  process.env.GUEST_AI_QUOTA_PER_WINDOW = "5";
  process.env.GUEST_AI_WINDOW_HOURS = "24";
  process.env.GUEST_GLOBAL_DAILY_GUEST_CAP = "10";
});

describe("clientIpHash", () => {
  // Item 9 (#21 P5 batch B): the client IP is derived from the RIGHT-MOST
  // x-forwarded-for hop (the value appended by the trusted ingress), NOT the
  // left-most (client-supplied, spoofable). Determinism + 64-hex format + a
  // single stable IP per request are preserved.
  it("hashes the right-most x-forwarded-for hop deterministically", () => {
    const h = new Headers({ "x-forwarded-for": "1.2.3.4, 5.6.7.8" });
    const a = clientIpHash(h);
    const b = clientIpHash(new Headers({ "x-forwarded-for": "5.6.7.8" }));
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });
  it("ignores a spoofed left-most XFF entry (uses the trusted right-most hop)", () => {
    // A client forging the left-most segment must not change the quota key.
    const spoofed = clientIpHash(
      new Headers({ "x-forwarded-for": "6.6.6.6, 5.6.7.8" }),
    );
    const real = clientIpHash(new Headers({ "x-forwarded-for": "5.6.7.8" }));
    expect(spoofed).toBe(real);
    // ...and it is NOT the attacker-controlled left-most value.
    const attackerControlled = clientIpHash(
      new Headers({ "x-forwarded-for": "6.6.6.6" }),
    );
    expect(spoofed).not.toBe(attackerControlled);
  });
  it("tolerates surrounding whitespace / trailing empty segments", () => {
    const a = clientIpHash(
      new Headers({ "x-forwarded-for": " 1.1.1.1 , 5.6.7.8 , " }),
    );
    const b = clientIpHash(new Headers({ "x-forwarded-for": "5.6.7.8" }));
    expect(a).toBe(b);
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
  it("allows and increments (atomically) when under quota and under global cap", async () => {
    db.guestDailyActivity.findUnique.mockResolvedValue(null);
    db.guestDailyActivity.count.mockResolvedValue(3);
    db.guestDailyActivity.createMany.mockResolvedValue({ count: 1 });
    // pre-check read (active window, under quota)
    db.guestAiUsage.findUnique.mockResolvedValueOnce({
      count: 1,
      windowStartedAt: new Date(),
    });
    db.guestAiUsage.updateMany
      .mockResolvedValueOnce({ count: 0 }) // reset: window not expired → 0
      .mockResolvedValueOnce({ count: 1 }); // guarded increment applied
    // remaining re-read after increment
    db.guestAiUsage.findUnique.mockResolvedValueOnce({
      count: 2,
      windowStartedAt: new Date(),
    });
    const r = await consumeGuestBreakdown("iphash");
    expect(r.allowed).toBe(true);
    expect(r.remaining).toBe(3); // 5 - 2
    expect(db.guestAiUsage.updateMany).toHaveBeenCalledTimes(2);
    expect(db.guestAiUsage.createMany).not.toHaveBeenCalled();
  });
  it("blocks with reason=quota when the per-IP window is exhausted (no metered write)", async () => {
    db.guestAiUsage.findUnique.mockResolvedValue({
      count: 5,
      windowStartedAt: new Date(),
    });
    const r = await consumeGuestBreakdown("iphash");
    expect(r.allowed).toBe(false);
    expect(r.reason).toBe("quota");
    // exhausted guest is blocked before any global-cap reservation or write
    expect(db.guestDailyActivity.createMany).not.toHaveBeenCalled();
    expect(db.guestAiUsage.updateMany).not.toHaveBeenCalled();
  });
  it("blocks a NEW guest with reason=global_cap when the day is full", async () => {
    db.guestDailyActivity.findUnique.mockResolvedValue(null); // not counted today
    db.guestDailyActivity.count.mockResolvedValue(10); // cap reached
    db.guestAiUsage.findUnique.mockResolvedValue({
      count: 0,
      windowStartedAt: new Date(),
    });
    const r = await consumeGuestBreakdown("iphash");
    expect(r.allowed).toBe(false);
    expect(r.reason).toBe("global_cap");
    expect(db.guestAiUsage.updateMany).not.toHaveBeenCalled();
  });
  it("window-expiry reset: allows when window is older than 24h and resets count", async () => {
    const expiredStart = new Date(Date.now() - 25 * 3600_000);
    db.guestAiUsage.findUnique.mockResolvedValue({
      count: 5,
      windowStartedAt: expiredStart,
    });
    db.guestDailyActivity.findUnique.mockResolvedValue({
      day: "x",
      ipHash: "iphash",
    }); // already counted today
    db.guestAiUsage.updateMany.mockResolvedValueOnce({ count: 1 }); // reset matched the expired row
    const r = await consumeGuestBreakdown("iphash");
    expect(r.allowed).toBe(true);
    expect(r.remaining).toBe(4); // fresh window: 5 - 1
    expect(db.guestAiUsage.updateMany).toHaveBeenCalledTimes(1); // reset only
  });
  it("first use: no row yet → creates the window", async () => {
    db.guestDailyActivity.findUnique.mockResolvedValue(null);
    db.guestDailyActivity.count.mockResolvedValue(0);
    db.guestDailyActivity.createMany.mockResolvedValue({ count: 1 });
    db.guestAiUsage.findUnique
      .mockResolvedValueOnce(null) // pre-check: no row
      .mockResolvedValueOnce(null); // step-3 guard: still no row
    db.guestAiUsage.updateMany
      .mockResolvedValueOnce({ count: 0 }) // reset: nothing
      .mockResolvedValueOnce({ count: 0 }); // increment: no row
    db.guestAiUsage.createMany.mockResolvedValueOnce({ count: 1 });
    const r = await consumeGuestBreakdown("iphash");
    expect(r.allowed).toBe(true);
    expect(r.remaining).toBe(4); // 5 - 1
    expect(db.guestAiUsage.createMany).toHaveBeenCalledTimes(1);
  });
  it("create race: guard sees no row, insert is skipped → retries the guarded increment", async () => {
    db.guestDailyActivity.findUnique.mockResolvedValue(null);
    db.guestDailyActivity.count.mockResolvedValue(0);
    db.guestDailyActivity.createMany.mockResolvedValue({ count: 1 });
    db.guestAiUsage.findUnique
      .mockResolvedValueOnce(null) // pre-check
      .mockResolvedValueOnce(null) // step-3 guard: row not visible yet
      .mockResolvedValueOnce({ count: 3, windowStartedAt: new Date() }); // remaining re-read
    db.guestAiUsage.updateMany
      .mockResolvedValueOnce({ count: 0 }) // reset
      .mockResolvedValueOnce({ count: 0 }) // first increment (no row)
      .mockResolvedValueOnce({ count: 1 }); // retry increment (row appeared)
    // ON CONFLICT DO NOTHING inserted nothing — resolved, never rejected, so
    // nothing reached Prisma's error log (#158).
    db.guestAiUsage.createMany.mockResolvedValueOnce({ count: 0 });
    const r = await consumeGuestBreakdown("iphash");
    expect(r.allowed).toBe(true);
    expect(r.remaining).toBe(2); // 5 - 3
  });
  it("exhausted active window (race): guard sees the row → blocks quota, no wasteful create", async () => {
    // pre-check passes (4 < 5) but the last slot is taken before we increment.
    db.guestDailyActivity.findUnique.mockResolvedValue({
      day: "x",
      ipHash: "iphash",
    }); // counted today
    db.guestAiUsage.findUnique
      .mockResolvedValueOnce({ count: 4, windowStartedAt: new Date() }) // pre-check: 4 < 5
      .mockResolvedValueOnce({ count: 5, windowStartedAt: new Date() }); // step-3 guard: now full
    db.guestAiUsage.updateMany
      .mockResolvedValueOnce({ count: 0 }) // reset: active window
      .mockResolvedValueOnce({ count: 0 }) // increment: last slot already taken
      .mockResolvedValueOnce({ count: 0 }); // retry increment: still full
    const r = await consumeGuestBreakdown("iphash");
    expect(r.allowed).toBe(false);
    expect(r.reason).toBe("quota");
    expect(db.guestAiUsage.createMany).not.toHaveBeenCalled(); // no create on the exhausted path
  });
});

describe("peekGuestAllowance", () => {
  it("returns full quota when no row exists and never writes", async () => {
    db.guestAiUsage.findUnique.mockResolvedValue(null);
    const result = await peekGuestAllowance("iphash");
    expect(result.remaining).toBe(5);
    expect(db.guestAiUsage.updateMany).not.toHaveBeenCalled();
    expect(db.guestAiUsage.createMany).not.toHaveBeenCalled();
    expect(db.guestAiUsage.update).not.toHaveBeenCalled();
  });
});

describe("refundGuestBreakdown", () => {
  it("decrements count when row exists with count > 0", async () => {
    db.guestAiUsage.findUnique.mockResolvedValue({
      ipHash: "iphash",
      count: 3,
      windowStartedAt: new Date(),
    });
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
    db.guestAiUsage.findUnique.mockResolvedValue({
      ipHash: "iphash",
      count: 0,
      windowStartedAt: new Date(),
    });
    await refundGuestBreakdown("iphash");
    expect(db.guestAiUsage.update).not.toHaveBeenCalled();
  });
});
