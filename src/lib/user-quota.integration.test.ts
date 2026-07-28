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

  // Owner decision on !175: uncapped RECORDS so the panel can show it, and never
  // refuses. These are the real-Postgres half of "meter but do not enforce" — the
  // half that would catch it if the implementation quietly became "enforce with a
  // large number", because Postgres is where such a bound would actually live.
  it("an uncapped account records every breakdown and is never refused", async () => {
    await seedUser({ aiPolicy: "uncapped", aiQuota: QUOTA });
    const N = QUOTA * 4; // four times the quota on the row

    const results = [];
    for (let i = 0; i < N; i++)
      results.push(await consumeUserBreakdown(USER_ID));

    // Not one refusal, and every single call was counted.
    expect(results.every((r) => r.blockedReason === null)).toBe(true);
    expect(results.every((r) => r.metered)).toBe(true);
    const row = await prisma.userAiUsage.findUnique({
      where: { userId: USER_ID },
    });
    expect(row?.count).toBe(N);
  });

  it("an uncapped account with aiQuota 0 is still never refused", async () => {
    // A CAPPED account with quota 0 is blocked outright. The same column must be
    // completely inert on an uncapped one.
    await seedUser({ aiPolicy: "uncapped", aiQuota: 0 });

    const first = await consumeUserBreakdown(USER_ID);
    const second = await consumeUserBreakdown(USER_ID);

    expect(first.blockedReason).toBeNull();
    expect(second.blockedReason).toBeNull();
    expect(
      (await prisma.userAiUsage.findUnique({ where: { userId: USER_ID } }))
        ?.count,
    ).toBe(2);
  });

  it("uncapped usage is reported by peekUserAiUsage, so the panel has a number", async () => {
    await seedUser({ aiPolicy: "uncapped", aiQuota: QUOTA });
    for (
      let i = 0;
      i < 7; // deliberately > QUOTA
      i++
    ) {
      await consumeUserBreakdown(USER_ID);
    }

    const usage = await peekUserAiUsage(USER_ID, QUOTA);

    expect(usage.used).toBe(7);
    expect(usage.windowStartedAt).not.toBeNull();
  });

  it("uncapped concurrency: every concurrent breakdown is counted, none refused", async () => {
    // The mirror of the capped race test above. There the invariant is "never
    // MORE than quota"; here it is "never FEWER than the number of calls" — a
    // lost increment would under-report the owner's spend.
    await seedUser({ aiPolicy: "uncapped", aiQuota: 1 });
    const N = 25;

    const results = await Promise.all(
      Array.from({ length: N }, () => consumeUserBreakdown(USER_ID)),
    );

    expect(results.filter((r) => r.blockedReason !== null)).toHaveLength(0);
    const row = await prisma.userAiUsage.findUnique({
      where: { userId: USER_ID },
    });
    expect(row?.count).toBe(N);
  });

  it("a CAPPED account still enforces — 'meter but do not enforce' did not leak across", async () => {
    // Regression guard for the refactor that introduced meterRecord: the two
    // modes share one body, so this asserts the enforced one still refuses.
    await seedUser({ aiPolicy: "capped", aiQuota: 2 });

    const a = await consumeUserBreakdown(USER_ID);
    const b = await consumeUserBreakdown(USER_ID);
    const c = await consumeUserBreakdown(USER_ID);

    expect([a.blockedReason, b.blockedReason, c.blockedReason]).toEqual([
      null,
      null,
      "quota",
    ]);
    expect(
      (await prisma.userAiUsage.findUnique({ where: { userId: USER_ID } }))
        ?.count,
    ).toBe(2);
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
