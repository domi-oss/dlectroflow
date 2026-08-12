/**
 * Unit tests for the broadened streak rule (Decision 1, #8 Phase 7) and the
 * streak/inbox badges:
 *  - touchStreakOnEngagement advances the streak at most once per working day
 *    (and not twice the same day), skips non-working days, and awards the
 *    streak badges (Full work week / Comeback / Beat best streak).
 *  - rewardStepDone routes the completion path through the same engagement fn.
 *  - maybeAwardInboxZero awards the once-ever Inbox-zero badge.
 *
 * Here the tx is mocked to exercise the pure once/day decision + badge fan-out,
 * which is all this file ever covered. The interactive-tx row lock itself is
 * proven against a real database in `rewards.integration.test.ts`, and the guard
 * at the foot of this file is what keeps that citation honest.
 *
 * ## ⚠️ Two corrections, and the second withdraws the first (#233)
 *
 * This docblock said the lock was proven in `rewards.integration.test.ts`.
 * `d07857b` replaced that with "NOT proven against a real DB anywhere … citing
 * `rewards.integration.test.ts`, a file that does not exist". **The original
 * sentence was right and the correction was wrong.** The file existed and did
 * exactly what was claimed; `783a6bf` (`!330`, #251) had deleted all 113 lines
 * of it hours earlier without its commit body mentioning the deletion, and the
 * check that concluded "no such file" ran inside that branch's worktree. A tree
 * is only evidence about the commit you are standing on.
 *
 * The lasting lesson is not about this file. `inbox-view.tsx` uses the same
 * sentence to argue the residual two-tab race is already defended, listing three
 * defences as equivalent, and #233's severity table uses it to argue `logReward`
 * is the only unguarded reward call. A named proof file reads as stronger
 * evidence than a described mechanism, which is exactly why nobody follows the
 * reference — so the citation went unchecked while it was true, and then went
 * unchecked while it was false, and both times it was load-bearing.
 *
 * So the citation is no longer prose alone. The `it` at the foot of this file
 * fails if the proof file is deleted, stops importing the real module, or stops
 * measuring the overlap its own assertions rest on. It lives HERE, in the file
 * that makes the claim, rather than in a hygiene module of its own: the failure
 * being guarded is a sentence drifting from its evidence, and a check kept
 * anywhere else is a second thing that can be deleted separately.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

const { prismaMock, txMock, getSettingsMock, getStreakMock } = vi.hoisted(
  () => {
    const txMock = {
      $queryRaw: vi.fn().mockResolvedValue([]),
      streak: { findUnique: vi.fn(), update: vi.fn().mockResolvedValue({}) },
      streakRecord: { create: vi.fn().mockResolvedValue({}) },
    };
    const prismaMock = {
      badge: {
        findUnique: vi.fn().mockResolvedValue(null),
        // #158: the award inserts with ON CONFLICT DO NOTHING and reads the
        // count, so a duplicate is a resolved `{ count: 0 }`, never a rejection.
        createMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      streakRecord: {
        aggregate: vi.fn().mockResolvedValue({ _max: { length: null } }),
      },
      rewardEvent: {
        create: vi.fn().mockResolvedValue({}),
        count: vi.fn().mockResolvedValue(0),
      },
      brainDumpItem: { count: vi.fn().mockResolvedValue(0) },
      $transaction: vi.fn(),
    };
    prismaMock.$transaction.mockImplementation((arg: unknown) =>
      typeof arg === "function"
        ? (arg as (tx: unknown) => unknown)(txMock)
        : Promise.all(arg as Promise<unknown>[]),
    );
    return {
      prismaMock,
      txMock,
      getSettingsMock: vi
        .fn()
        .mockResolvedValue({ workingDays: "1,2,3,4,5,6,7" }),
      getStreakMock: vi.fn().mockResolvedValue({}),
    };
  },
);

vi.mock("@/lib/db", () => ({
  prisma: prismaMock,
  getSettings: getSettingsMock,
  getStreak: getStreakMock,
}));

import {
  touchStreakOnEngagement,
  rewardStepDone,
  maybeAwardInboxZero,
} from "./rewards";

function ymd(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
    d.getDate(),
  ).padStart(2, "0")}`;
}
const daysAgo = (n: number) => {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return ymd(d);
};

function createdBadgeKeys(): string[] {
  return prismaMock.badge.createMany.mock.calls.map(
    (c) => (c[0] as { data: { key: string } }).data.key,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  getSettingsMock.mockResolvedValue({ workingDays: "1,2,3,4,5,6,7" });
  getStreakMock.mockResolvedValue({});
  prismaMock.badge.findUnique.mockResolvedValue(null);
  prismaMock.badge.createMany.mockResolvedValue({ count: 1 });
  prismaMock.streakRecord.aggregate.mockResolvedValue({
    _max: { length: null },
  });
  prismaMock.rewardEvent.count.mockResolvedValue(0);
  prismaMock.brainDumpItem.count.mockResolvedValue(0);
});

describe("touchStreakOnEngagement — once per working day", () => {
  it("advances the streak once when the previous working day was active", async () => {
    txMock.streak.findUnique.mockResolvedValue({
      current: 3,
      lastActiveWorkday: daysAgo(1),
    });
    const res = await touchStreakOnEngagement("ws");
    expect(res).toEqual({ current: 4, freshStart: false, continued: true });
    expect(txMock.streak.update).toHaveBeenCalledTimes(1);
    expect(txMock.streak.update.mock.calls[0][0].data).toEqual({
      current: 4,
      lastActiveWorkday: ymd(new Date()),
    });
  });

  it("does NOT advance twice the same day (already active today)", async () => {
    txMock.streak.findUnique.mockResolvedValue({
      current: 4,
      lastActiveWorkday: ymd(new Date()),
    });
    const res = await touchStreakOnEngagement("ws");
    expect(res).toEqual({ current: 4, freshStart: false, continued: false });
    expect(txMock.streak.update).not.toHaveBeenCalled();
  });

  it("skips non-working days (returns null, no transaction)", async () => {
    const todayWd = (() => {
      const wd = new Date().getDay();
      return wd === 0 ? 7 : wd;
    })();
    getSettingsMock.mockResolvedValue({
      workingDays: [1, 2, 3, 4, 5, 6, 7].filter((d) => d !== todayWd).join(","),
    });
    const res = await touchStreakOnEngagement("ws");
    expect(res).toBeNull();
    expect(prismaMock.$transaction).not.toHaveBeenCalled();
  });

  it("awards Full work week (streak_5) when the streak reaches 5", async () => {
    txMock.streak.findUnique.mockResolvedValue({
      current: 4,
      lastActiveWorkday: daysAgo(1),
    });
    await touchStreakOnEngagement("ws");
    expect(createdBadgeKeys()).toContain("streak_5");
  });

  it("awards Comeback on a fresh start after a gap (prior streak had ended)", async () => {
    txMock.streak.findUnique.mockResolvedValue({
      current: 3,
      lastActiveWorkday: daysAgo(3),
    });
    prismaMock.streakRecord.aggregate.mockResolvedValue({
      _max: { length: 3 },
    });
    const res = await touchStreakOnEngagement("ws");
    expect(res).toEqual({ current: 1, freshStart: true, continued: false });
    expect(txMock.streakRecord.create).toHaveBeenCalledTimes(1); // ended streak filed
    expect(createdBadgeKeys()).toContain("comeback");
    expect(createdBadgeKeys()).not.toContain("streak_5"); // only 1 day so far
  });

  it("does NOT award Comeback on a normal first-ever engagement (no prior streak)", async () => {
    txMock.streak.findUnique.mockResolvedValue({
      current: 0,
      lastActiveWorkday: null,
    });
    const res = await touchStreakOnEngagement("ws");
    expect(res).toEqual({ current: 1, freshStart: false, continued: false });
    expect(createdBadgeKeys()).not.toContain("comeback");
  });

  it("awards Beat best streak when the current run passes the recorded best", async () => {
    txMock.streak.findUnique.mockResolvedValue({
      current: 3,
      lastActiveWorkday: daysAgo(1),
    });
    prismaMock.streakRecord.aggregate.mockResolvedValue({
      _max: { length: 2 },
    });
    await touchStreakOnEngagement("ws");
    expect(createdBadgeKeys()).toContain("beat_best_streak");
  });

  it("is idempotent for streak badges (already held → no duplicate create)", async () => {
    txMock.streak.findUnique.mockResolvedValue({
      current: 4,
      lastActiveWorkday: daysAgo(1),
    });
    prismaMock.badge.findUnique.mockResolvedValue({ id: "b1" }); // already earned
    await touchStreakOnEngagement("ws");
    expect(prismaMock.badge.createMany).not.toHaveBeenCalled();
  });
});

describe("rewardStepDone — completion routes through the engagement streak", () => {
  it("logs step_done and advances the streak via the shared engagement fn", async () => {
    txMock.streak.findUnique.mockResolvedValue({
      current: 2,
      lastActiveWorkday: daysAgo(1),
    });
    const res = await rewardStepDone("ws");
    expect(prismaMock.rewardEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ type: "step_done" }),
      }),
    );
    expect(txMock.streak.update).toHaveBeenCalledTimes(1);
    expect(res).toEqual({ current: 3, freshStart: false, continued: true });
  });
});

describe("maybeAwardInboxZero — Inbox-zero badge", () => {
  it("awards the inbox_zero badge (once ever) when the queue is empty", async () => {
    prismaMock.brainDumpItem.count.mockResolvedValue(0);
    await maybeAwardInboxZero("ws");
    expect(createdBadgeKeys()).toContain("inbox_zero");
  });

  it("does not award when items still need review", async () => {
    prismaMock.brainDumpItem.count.mockResolvedValue(2);
    await maybeAwardInboxZero("ws");
    expect(prismaMock.badge.createMany).not.toHaveBeenCalled();
  });

  it("is idempotent — already-held badge is not re-created", async () => {
    prismaMock.brainDumpItem.count.mockResolvedValue(0);
    prismaMock.badge.findUnique.mockResolvedValue({ id: "b1" });
    await maybeAwardInboxZero("ws");
    expect(prismaMock.badge.createMany).not.toHaveBeenCalled();
  });
});

describe("the row lock's real-DB proof, as a check rather than a citation (#233)", () => {
  it("still exists, still runs unmocked, and still measures its own overlap", () => {
    // Deliberately ONE test and no parser module. `#234` spent a module plus two
    // adversarial review rounds on a guard that, by its own measurement, never
    // blocked a merge; the cheap half of this is four string assertions, and the
    // cheap half is what is taken.
    const lock = readFileSync(path.join("src", "lib", "rewards.ts"), "utf8");

    // Self-scoping, and the reason this can be a plain string match. It looks
    // for `FOR UPDATE` on a `$queryRaw` line, not anywhere in the file — the two
    // prose mentions in `touchStreakOnEngagement`'s comments would otherwise
    // satisfy it, and this repo has twice shipped a tool that read a comment as
    // code. If the lock is ever removed on purpose the premise goes with it and
    // this retires itself, instead of demanding proof of something gone.
    if (!/\$queryRaw[^\n]*FOR UPDATE/.test(lock)) return;

    const proof = path.join("src", "lib", "rewards.integration.test.ts");
    // The deletion this guard exists for. `783a6bf` removed 113 lines of
    // real-Postgres concurrency coverage and nothing in a suite full of hygiene
    // tests noticed, because every one of them looks at source files rather than
    // at whether a proof is still there.
    expect(existsSync(proof)).toBe(true);

    const source = readFileSync(proof, "utf8");
    // The real module, not a stub of it. Four `*.integration.test.ts` files name
    // `touchStreakOnCompletion` and `vi.fn()` it, which is why "an integration
    // test mentions it" is not evidence that anything ran.
    expect(source).toMatch(/from "\.\/rewards"/);
    expect(source).not.toMatch(/touchStreak\w*: vi\.fn/);
    // And that it still measures the overlap its assertions rest on. A proof
    // whose two callers stop racing goes on passing, silently — which is what
    // the restored file did on a cold pool before #233 arranged the
    // interleaving. Deleting the proof is not the only way to lose it.
    expect(source).toMatch(/maxLiveTx/);
  });
});
