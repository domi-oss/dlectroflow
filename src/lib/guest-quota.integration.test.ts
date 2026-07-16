import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { prisma } from "@/lib/db";
import { consumeGuestBreakdown } from "./guest-quota";

// Real-DB proof for issue #21 P5.1: many concurrent consumeGuestBreakdown calls
// for a single IP must never record more than `quota` consumes in the rolling
// window. The old read→check→upsert was a TOCTOU that mocks can't expose — only
// genuine concurrency against Postgres demonstrates the atomic guard.

const IP = "test-iphash-quota-race";
const QUOTA = 5;

function utcDay(d = new Date()): string {
  return d.toISOString().slice(0, 10);
}

beforeAll(() => {
  process.env.GUEST_AI_QUOTA_PER_WINDOW = String(QUOTA);
  process.env.GUEST_AI_WINDOW_HOURS = "24";
  process.env.GUEST_GLOBAL_DAILY_GUEST_CAP = "1000"; // high → don't gate this test
  process.env.GUEST_IP_HASH_SALT = "test-salt";
});

async function cleanup() {
  await prisma.guestAiUsage.deleteMany({ where: { ipHash: IP } });
  await prisma.guestDailyActivity.deleteMany({ where: { ipHash: IP } });
}

beforeEach(cleanup);

afterAll(async () => {
  await cleanup();
  await prisma.$disconnect();
});

describe("consumeGuestBreakdown — per-IP atomicity (#21 P5.1)", () => {
  it("never exceeds quota under a burst of concurrent calls for one IP", async () => {
    const N = 25;
    const results = await Promise.all(
      Array.from({ length: N }, () => consumeGuestBreakdown(IP)),
    );

    const allowed = results.filter((r) => r.allowed).length;
    const blocked = results.filter((r) => !r.allowed);

    // Exactly `quota` calls may succeed — no overshoot from the race.
    expect(allowed).toBe(QUOTA);
    // Every rejection is a per-IP quota block (global cap is set high).
    expect(blocked.every((r) => r.reason === "quota")).toBe(true);

    // The persisted counter matches: never more than `quota`.
    const row = await prisma.guestAiUsage.findUnique({ where: { ipHash: IP } });
    expect(row?.count).toBe(QUOTA);

    // The guest was counted exactly once against the global distinct-guest tally.
    const dailyRows = await prisma.guestDailyActivity.count({
      where: { day: utcDay(), ipHash: IP },
    });
    expect(dailyRows).toBe(1);
  });

  it("a second burst after the window is exhausted stays blocked (no overshoot)", async () => {
    // Prime an already-exhausted active window.
    await prisma.guestAiUsage.create({
      data: { ipHash: IP, count: QUOTA, windowStartedAt: new Date() },
    });
    const results = await Promise.all(
      Array.from({ length: 10 }, () => consumeGuestBreakdown(IP)),
    );
    expect(results.every((r) => !r.allowed && r.reason === "quota")).toBe(true);
    const row = await prisma.guestAiUsage.findUnique({ where: { ipHash: IP } });
    expect(row?.count).toBe(QUOTA); // unchanged — no increment past quota
  });
});
