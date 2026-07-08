import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/db");

import { clientIpHash, consumeGuestBreakdown } from "./guest-quota";
import { prisma } from "@/lib/db";

const db = {
  guestAiUsage: { findUnique: vi.fn(), upsert: vi.fn(), update: vi.fn() },
  guestDailyActivity: { findUnique: vi.fn(), count: vi.fn(), create: vi.fn() },
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(prisma as any).guestAiUsage = db.guestAiUsage;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(prisma as any).guestDailyActivity = db.guestDailyActivity;

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
});
