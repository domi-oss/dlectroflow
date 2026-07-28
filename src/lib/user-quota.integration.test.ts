import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { prisma } from "@/lib/db";
import { consumeUserBreakdown, peekUserAiUsage } from "./user-quota";

// #35 Phase B — real-Postgres proof for the per-user cap.
//
// The unit tests drive the policy matrix through a fake store; these prove the
// two things mocks cannot: that concurrent breakdowns for ONE account never
// overshoot `aiQuota` (the same TOCTOU that #21 P5.1 fixed for guests, inherited
// through the shared sliding-window meter), and that the window genuinely slides
// from first use rather than resetting on a calendar boundary.

const USER_ID = "itest-user-quota";
const QUOTA = 5;

beforeAll(() => {
  process.env.USER_AI_WINDOW_HOURS = "24";
});

async function cleanup() {
  // UserAiUsage cascades from User, but delete it explicitly so a failed run
  // that left a usage row behind cannot skew the next one.
  await prisma.userAiUsage.deleteMany({ where: { userId: USER_ID } });
  await prisma.user.deleteMany({ where: { id: USER_ID } });
}

async function seedUser(over: { aiPolicy?: string; aiQuota?: number } = {}) {
  await prisma.user.create({
    data: {
      id: USER_ID,
      provider: "gitlab",
      providerSub: USER_ID,
      aiPolicy: over.aiPolicy ?? "capped",
      aiQuota: over.aiQuota ?? QUOTA,
    },
  });
}

beforeEach(cleanup);

afterAll(async () => {
  await cleanup();
  delete process.env.USER_AI_WINDOW_HOURS;
  await prisma.$disconnect();
});

describe("consumeUserBreakdown — per-user atomicity", () => {
  it("never exceeds aiQuota under a burst of concurrent breakdowns for one account", async () => {
    await seedUser();
    const N = 25;

    const results = await Promise.all(
      Array.from({ length: N }, () => consumeUserBreakdown(USER_ID)),
    );

    const metered = results.filter((r) => r.metered).length;
    const blocked = results.filter((r) => r.blockedReason !== null);

    expect(metered).toBe(QUOTA);
    expect(blocked).toHaveLength(N - QUOTA);
    expect(blocked.every((r) => r.blockedReason === "quota")).toBe(true);

    const row = await prisma.userAiUsage.findUnique({
      where: { userId: USER_ID },
    });
    expect(row?.count).toBe(QUOTA);
  });

  it("resets on expiry — a sliding window from first use, not a calendar month", async () => {
    await seedUser();
    // Spend the whole allowance, then age the window past its end.
    for (let i = 0; i < QUOTA; i++) await consumeUserBreakdown(USER_ID);
    expect((await consumeUserBreakdown(USER_ID)).blockedReason).toBe("quota");

    await prisma.userAiUsage.update({
      where: { userId: USER_ID },
      data: { windowStartedAt: new Date(Date.now() - 25 * 3600_000) },
    });

    const afterExpiry = await consumeUserBreakdown(USER_ID);

    expect(afterExpiry.blockedReason).toBeNull();
    expect(afterExpiry.metered).toBe(true);
    const row = await prisma.userAiUsage.findUnique({
      where: { userId: USER_ID },
    });
    // A RESET, not a continuation: the fresh window starts at one consumed unit.
    expect(row?.count).toBe(1);
    expect(row!.windowStartedAt.getTime()).toBeGreaterThan(Date.now() - 60_000);
  });

  it("peekUserAiUsage reports exactly what enforcement just counted", async () => {
    await seedUser();
    await consumeUserBreakdown(USER_ID);
    await consumeUserBreakdown(USER_ID);

    const usage = await peekUserAiUsage(USER_ID, QUOTA);

    expect(usage.used).toBe(2);
    expect(usage.remaining).toBe(QUOTA - 2);
    expect(usage.windowStartedAt).not.toBeNull();
    expect(
      usage.windowEndsAt!.getTime() - usage.windowStartedAt!.getTime(),
    ).toBe(24 * 3600_000);
  });

  it("an uncapped account writes NO usage row at all", async () => {
    await seedUser({ aiPolicy: "uncapped" });

    for (let i = 0; i < QUOTA + 3; i++) await consumeUserBreakdown(USER_ID);

    expect(
      await prisma.userAiUsage.findUnique({ where: { userId: USER_ID } }),
    ).toBeNull();
  });

  it("deleting the account cascades its usage row away", async () => {
    await seedUser();
    await consumeUserBreakdown(USER_ID);
    expect(
      await prisma.userAiUsage.findUnique({ where: { userId: USER_ID } }),
    ).not.toBeNull();

    await prisma.user.delete({ where: { id: USER_ID } });

    expect(
      await prisma.userAiUsage.findUnique({ where: { userId: USER_ID } }),
    ).toBeNull();
  });
});
