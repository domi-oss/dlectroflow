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
 *
 * It also fails when the lock itself goes, and that is a change of mind from the
 * version first pushed. That one returned early when it could not find
 * `FOR UPDATE`, so that deliberately dropping the lock would retire the check
 * along with its premise. But it could not tell a deliberate removal from a
 * query it had simply failed to read, and it answered both by passing — which is
 * the same class of green-means-nothing-was-looked-at signal as the vacuous
 * proof above. `RAW_ROW_LOCK` below carries what that cost, measured.
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
      // #233 — the engagement ledger row is written FIRST inside this same
      // transaction, so `tx` has to carry it. That ordering is deliberate and is
      // asserted below: a ledger BEHIND the counter is the one direction that
      // could revoke a badge somebody still qualifies for.
      engagementDay: { create: vi.fn().mockResolvedValue({}) },
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
      // The non-working-day arm writes its ledger row outside the transaction,
      // because there is no streak change for it to be atomic with.
      engagementDay: { create: vi.fn().mockResolvedValue({}) },
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

import { EngagementKind } from "@/lib/constants";
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

  /**
   * #233 via `!352` review — the non-working-day arm STILL writes its ledger row.
   *
   * The early return above skips the streak, and the ledger write sits before it
   * precisely so that skipping one does not skip the other: the ledger is a log of
   * what happened, not a view of what counted, and `recomputeRun` is what applies
   * the working-day rule. A Saturday capture that went unrecorded would become a
   * hole in the ledger the moment somebody changed their working week to include
   * Saturdays — the day would read as a gap, shortening a run and revoking a badge
   * that was genuinely earned.
   *
   * Asserted here rather than in `engagement-ledger.integration.test.ts`, which
   * sets a seven-day working week on purpose so no assertion in it moves with the
   * calendar — meaning the non-working-day arm never executes there. Measured while
   * writing this: deleting the write left all 6705 tests green.
   */
  it("still records the ledger row on a NON-working day", async () => {
    const todayWd = (() => {
      const wd = new Date().getDay();
      return wd === 0 ? 7 : wd;
    })();
    getSettingsMock.mockResolvedValue({
      workingDays: [1, 2, 3, 4, 5, 6, 7].filter((d) => d !== todayWd).join(","),
    });

    const res = await touchStreakOnEngagement("ws", {
      kind: EngagementKind.Capture,
      itemId: "item-1",
    });

    // The streak did not move — the behaviour the test above pins…
    expect(res).toBeNull();
    expect(prismaMock.$transaction).not.toHaveBeenCalled();
    // …and the credit was logged anyway, on the client that is NOT the
    // transaction, because there is no streak change for it to be atomic with.
    expect(prismaMock.engagementDay.create).toHaveBeenCalledWith({
      data: {
        workspaceId: "ws",
        day: ymd(new Date()),
        kind: EngagementKind.Capture,
        itemId: "item-1",
      },
    });
    expect(txMock.engagementDay.create).not.toHaveBeenCalled();
  });

  /**
   * #233 via `!352` review — the ledger row is written FIRST inside the streak
   * transaction, and both halves of that are load-bearing.
   *
   * **Inside**, so the row and the counter cannot disagree. **First**, so the lock
   * order is `EngagementDay`-then-`Streak`, which is the order
   * `deleteBrainDumpItem` takes when its cascade removes rows and it then
   * recomputes. Inverting it in one writer is how a deadlock gets built: the insert
   * takes a `FOR KEY SHARE` on the `BrainDumpItem` its `itemId` points at, so a
   * version that took the `Streak` lock first would hold `Streak` while reaching
   * for a row a concurrent delete holds and is itself waiting on `Streak` for.
   *
   * The mock's own docblock claimed this was "asserted below" and nothing asserted
   * it — the assertion is here now. Ordering is read off
   * `invocationCallOrder` rather than inferred from a call count, because a count
   * cannot tell first from last.
   */
  it("writes the ledger row FIRST inside the transaction, before the row lock", async () => {
    txMock.streak.findUnique.mockResolvedValue({
      current: 3,
      lastActiveWorkday: daysAgo(1),
    });

    await touchStreakOnEngagement("ws", {
      kind: EngagementKind.StepDone,
      itemId: "item-1",
    });

    // On the transaction client, not the singleton — that is the "inside" half.
    expect(txMock.engagementDay.create).toHaveBeenCalledTimes(1);
    expect(prismaMock.engagementDay.create).not.toHaveBeenCalled();
    // …and before both the `SELECT … FOR UPDATE` and the counter write, which is
    // the "first" half. Non-zero controls: all three really were called, so an
    // ordering that held because a call never happened cannot pass this.
    expect(txMock.$queryRaw).toHaveBeenCalledTimes(1);
    expect(txMock.streak.update).toHaveBeenCalledTimes(1);
    const [ledger] = txMock.engagementDay.create.mock.invocationCallOrder;
    const [rowLock] = txMock.$queryRaw.mock.invocationCallOrder;
    const [counter] = txMock.streak.update.mock.invocationCallOrder;
    expect(ledger).toBeLessThan(rowLock);
    expect(rowLock).toBeLessThan(counter);
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

/**
 * `FOR UPDATE` inside the template literal that a `$queryRaw` tag opens.
 *
 * Self-scoping, and the reason this can be a plain string match rather than a
 * TypeScript parse: the lock has to sit in the *query text*, not anywhere in the
 * file. The two prose mentions in `touchStreakOnEngagement`'s comments would
 * satisfy a bare `/FOR UPDATE/`, and this repo has twice shipped a tool that
 * read a comment as code.
 *
 * `[^`]*` rather than the `[^\n]*` this shipped with (#233, Duo round 1). That
 * form only matched a lock on the same source line as the tag, so splitting the
 * template across lines for readability — an ordinary, reviewable change that
 * Prettier cannot do for you because it never reformats inside a template
 * literal — made the scan below read "no lock". Measured before the fix: with
 * the query wrapped onto four lines *and the proof file deleted*, this file
 * passed 13/13. Bounding the distance instead (`[\s\S]{0,200}`) keeps the same
 * shape of hole, just further away. The template's own delimiters are the
 * boundary the query actually has, so they are the boundary used.
 */
const RAW_ROW_LOCK = /\$queryRaw\s*`[^`]*FOR UPDATE[^`]*`/;

/**
 * Any raw query at all — used only to say *which* thing went missing when the
 * check below fails, since "the lock clause was dropped" and "the locking read
 * was replaced wholesale" want different answers from whoever reads the failure.
 */
const RAW_QUERY = /\$queryRaw/;

type RowLockScan = "locked" | "unlocked" | "no-raw-query";

/**
 * Read `rewards.ts` the way this check needs to see it.
 *
 * A local function rather than a `*-hygiene.ts` module, on purpose and for the
 * same reason the test stays in this file: the failure being guarded is a
 * sentence in *this* docblock drifting from its evidence, and a module is a
 * second thing that can be deleted separately. `CLAUDE.md` asks a file-parsing
 * guard to keep its parser out of `fs` so it can be shown to fail on synthetic
 * input — that is what this signature buys, and the `describe` below spends it.
 */
function scanRawRowLock(source: string): RowLockScan {
  if (RAW_ROW_LOCK.test(source)) return "locked";
  return RAW_QUERY.test(source) ? "unlocked" : "no-raw-query";
}

describe("scanRawRowLock — what counts as seeing the lock (#233)", () => {
  it("sees a lock written on one line, as `rewards.ts` writes it today", () => {
    expect(
      scanRawRowLock(
        'await tx.$queryRaw`SELECT 1 FROM "Streak" WHERE "workspaceId" = ${id} FOR UPDATE`;',
      ),
    ).toBe("locked");
  });

  it("sees a lock in a template split across lines", () => {
    // The regression Duo round 1 found. Nothing about this rewrite changes what
    // Postgres does, so a check that stops seeing the lock here is measuring
    // source formatting rather than behaviour.
    expect(
      scanRawRowLock(
        'await tx.$queryRaw`\n  SELECT 1 FROM "Streak"\n  WHERE "workspaceId" = ${id}\n  FOR UPDATE`;',
      ),
    ).toBe("locked");
  });

  it("does not read the comments that describe the lock as the lock", () => {
    // Both mentions in `touchStreakOnEngagement` are backticked prose of exactly
    // this shape, and they outlive the code they describe by design.
    expect(
      scanRawRowLock(
        "// the leading `SELECT … FOR UPDATE` serialises same-day callers\n" +
          "const streak = await tx.streak.findUnique({ where: { workspaceId } });",
      ),
    ).toBe("no-raw-query");
  });

  it("separates a dropped lock clause from a dropped locking read", () => {
    expect(scanRawRowLock('await tx.$queryRaw`SELECT 1 FROM "Streak"`;')).toBe(
      "unlocked",
    );
    expect(
      scanRawRowLock("const streak = await tx.streak.findUnique({});"),
    ).toBe("no-raw-query");
  });
});

describe("the row lock's real-DB proof, as a check rather than a citation (#233)", () => {
  it("still exists, still runs unmocked, and still measures its own overlap", () => {
    // Deliberately ONE test against the real tree, and plain string matching
    // rather than an AST walk. `#234` spent a module plus two adversarial review
    // rounds on a guard that, by its own measurement, never blocked a merge; the
    // cheap half is what is taken here — no module, no allowlist, no parse. The
    // synthetic `describe` above is not a second guard, it is the only way to
    // show this one failing, which is the thing #233 keeps being about.
    const lock = readFileSync(path.join("src", "lib", "rewards.ts"), "utf8");

    // A hard assertion, NOT the early return this shipped with (#233, Duo round
    // 1). The early return was written so that deliberately removing the lock
    // would retire this check with it rather than demand proof of something
    // gone — but it could not tell "removed on purpose" from "I could not see
    // it", and it answered both by silently passing. A guard that stops
    // guarding without saying so is worse than no guard, because the green tick
    // is then read as evidence.
    //
    // Failing instead costs one red test on a deliberate removal, and the
    // message says what to delete. It also fixes the direction the whole check
    // fails in: every way of mis-reading `rewards.ts` now ends in *more*
    // enforcement plus a message naming what was looked for, never in less.
    const scan = scanRawRowLock(lock);
    expect(
      scan,
      scan === "no-raw-query"
        ? "`rewards.ts` no longer issues a raw query, so the `SELECT … FOR UPDATE` that serialises `touchStreakOnEngagement` is gone (#233). Three places argue from that lock: this file's docblock, `rewards.integration.test.ts`, and #233's severity table, which calls `logReward` the only unguarded reward call. If the lock was replaced on purpose, retire them together with this test — not this test alone."
        : "`rewards.ts` still issues a raw query but it no longer takes `FOR UPDATE`, so `touchStreakOnEngagement`'s read-decide-write is back to the TOCTOU #21 P5.3 closed (#233). If that is deliberate, the citations in this file's docblock, in `rewards.integration.test.ts` and in #233's severity table go with it, and so does this test.",
    ).toBe("locked");

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
