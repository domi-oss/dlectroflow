/**
 * Unit tests for the broadened streak rule (Decision 1, #8 Phase 7) and the
 * streak/inbox badges:
 *  - touchStreakOnEngagement advances the streak at most once per working day
 *    (and not twice the same day), skips non-working days, and awards the
 *    streak badges (Full work week / Comeback / Beat best streak).
 *  - rewardStepDone routes the completion path through the same engagement fn.
 *  - maybeAwardInboxZero awards the once-ever Inbox-zero badge.
 *
 * The interactive-tx row lock itself is proven against a real DB in
 * rewards.integration.test.ts; here the tx is mocked to exercise the pure
 * once/day decision + badge fan-out.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

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
