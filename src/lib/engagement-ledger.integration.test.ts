/**
 * #233 — the engagement ledger against real Postgres, and the streak-badge
 * revocation `#251` recorded as impossible without it.
 *
 * ## Why this file needs a database
 *
 * Every claim here is a property of Postgres rather than of the code shape:
 *
 *  * **The cascade IS the mechanism.** `EngagementDay.itemId` carries
 *    `ON DELETE CASCADE`, so deleting a to-do withdraws the credits it supplied.
 *    A mock cannot show a foreign key firing, and the whole design rests on it —
 *    if that clause were `SET NULL` instead, every assertion about revocation
 *    would invert and nothing else in the suite would notice.
 *  * **"Which days lost their last credit"** is a set difference across two reads
 *    either side of a delete, inside one transaction.
 *  * **The `SELECT … FOR UPDATE` on `Streak`** is the same lock
 *    `touchStreakOnEngagement` takes, and the two run in the same order
 *    (`EngagementDay` then `Streak`) precisely so they cannot deadlock.
 *
 * The pure recompute — a run broken by one missed working day, a weekend stepped
 * over, a working week that is not Mon-Fri — is in `engagement-ledger.test.ts`,
 * where those shapes cost a line each instead of weeks of wall-clock time.
 *
 * ## The working week is set to all seven days
 *
 * Deliberately, so "N consecutive working days" is "N consecutive calendar days"
 * and no assertion here depends on which weekday the suite happens to run on. A
 * test whose expectations move with the calendar is one that passes for the wrong
 * reason four days in five; the weekend logic is the pure module's job.
 */

import {
  describe,
  it,
  expect,
  vi,
  beforeAll,
  afterAll,
  beforeEach,
} from "vitest";
import { PrismaClient } from "@prisma/client";
import { BadgeKey, EngagementKind } from "@/lib/constants";
import { ymd } from "@/lib/engagement-ledger";

const WS = vi.hoisted(() => "test-233-ledger-ws");
/** A second workspace, only ever the negative control for scoping. */
const OTHER = vi.hoisted(() => "test-233-ledger-other");

vi.mock("@/lib/workspace", () => ({
  currentWorkspaceId: vi.fn().mockResolvedValue(WS),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/rewards", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/rewards")>();
  return {
    ...actual,
    // The one pre-existing side effect of a delete, stubbed so it cannot bank an
    // `inbox_zero` row into the middle of an assertion — the same stub
    // `delete-completed-item.integration.test.ts` installs, and for the same
    // reason. Everything the ledger uses stays real.
    maybeAwardInboxZero: vi.fn().mockResolvedValue(undefined),
  };
});

// Dedicated client, so this file's setup and `$disconnect()` cannot tear the
// connection out from under the singleton the code under test uses.
const prisma = new PrismaClient();

/** `n` days before today, as the local `YYYY-MM-DD` the ledger stores. */
function dayAgo(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return ymd(d);
}

/** Local midnight `n` days ago, for dating a `Badge.earnedAt` or a `ledgerFrom`. */
function midnightAgo(n: number): Date {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - n);
  return d;
}

async function wipe() {
  for (const ws of [WS, OTHER]) {
    // `EngagementDay` first: it references `BrainDumpItem`, and the point of this
    // file is that the reference is real.
    await prisma.engagementDay.deleteMany({ where: { workspaceId: ws } });
    await prisma.step.deleteMany({ where: { task: { workspaceId: ws } } });
    await prisma.brainDumpItem.deleteMany({ where: { workspaceId: ws } });
    await prisma.task.deleteMany({ where: { workspaceId: ws } });
    await prisma.rewardEvent.deleteMany({ where: { workspaceId: ws } });
    await prisma.badge.deleteMany({ where: { workspaceId: ws } });
    await prisma.streakRecord.deleteMany({ where: { workspaceId: ws } });
    await prisma.streak.deleteMany({ where: { workspaceId: ws } });
    await prisma.settings.deleteMany({ where: { workspaceId: ws } });
    await prisma.workspace.deleteMany({ where: { id: ws } });
  }
}

/**
 * A workspace with a seven-day working week and a streak of `current` ending
 * today, whose ledger coverage began `ledgerFromDaysAgo` days ago at midnight.
 */
async function seedWorkspace(
  ws: string,
  opts: { current: number; ledgerFromDaysAgo: number },
) {
  await prisma.workspace.create({ data: { id: ws, kind: "user" } });
  await prisma.settings.create({
    data: {
      workspaceId: ws,
      workingDays: "1,2,3,4,5,6,7",
      updatedAt: new Date(),
    },
  });
  await prisma.streak.create({
    data: {
      workspaceId: ws,
      current: opts.current,
      lastActiveWorkday: dayAgo(0),
      ledgerFrom: midnightAgo(opts.ledgerFromDaysAgo),
    },
  });
}

/**
 * One inbox item, plus one ledger credit per day in `days` attributed to it.
 *
 * Attributed, because that is what makes the credit withdrawable — an
 * unattributed row is permanent by design and would make every revocation
 * assertion below vacuously fail.
 */
async function itemCrediting(
  ws: string,
  id: string,
  days: readonly string[],
): Promise<string> {
  await prisma.brainDumpItem.create({
    data: { id, workspaceId: ws, text: `item ${id}` },
  });
  for (const day of days) {
    await prisma.engagementDay.create({
      data: {
        workspaceId: ws,
        day,
        kind: EngagementKind.TaskComplete,
        itemId: id,
      },
    });
  }
  return id;
}

const badgeKeys = async (ws: string) =>
  (
    await prisma.badge.findMany({
      where: { workspaceId: ws },
      orderBy: { key: "asc" },
    })
  )
    .map((b) => b.key)
    .sort();

beforeAll(wipe);
afterAll(async () => {
  await wipe();
  await prisma.$disconnect();
});
beforeEach(async () => {
  vi.clearAllMocks();
  await wipe();
});

describe("the ledger records every engagement, not just the day's first (#233)", () => {
  it("writes a row per engagement even after the streak has already advanced today", async () => {
    // THE TRAP this design walks into if the write is placed after the
    // `lastActiveWorkday === today` early return: the day would be credited by
    // whichever item happened to be first, and every later engagement that day
    // would be unrecorded — so deleting that one item would empty a day three
    // other to-dos were also holding up.
    await seedWorkspace(WS, { current: 0, ledgerFromDaysAgo: 30 });
    await prisma.streak.update({
      where: { workspaceId: WS },
      data: { current: 0, lastActiveWorkday: null },
    });
    await prisma.brainDumpItem.create({
      data: { id: "first", workspaceId: WS, text: "first" },
    });
    await prisma.brainDumpItem.create({
      data: { id: "second", workspaceId: WS, text: "second" },
    });

    const { touchStreakOnEngagement } = await import("@/lib/rewards");
    const one = await touchStreakOnEngagement(WS, {
      kind: EngagementKind.Capture,
      itemId: "first",
    });
    const two = await touchStreakOnEngagement(WS, {
      kind: EngagementKind.Capture,
      itemId: "second",
    });

    // The streak advanced exactly once — the behaviour that has always been there.
    expect(one?.current).toBe(1);
    expect(two?.continued).toBe(false);
    expect(
      (await prisma.streak.findUnique({ where: { workspaceId: WS } }))?.current,
    ).toBe(1);

    // …and the LEDGER holds both, attributed to their own items.
    const rows = await prisma.engagementDay.findMany({
      where: { workspaceId: WS },
      orderBy: { itemId: "asc" },
      select: { day: true, kind: true, itemId: true },
    });
    expect(rows).toEqual([
      { day: dayAgo(0), kind: EngagementKind.Capture, itemId: "first" },
      { day: dayAgo(0), kind: EngagementKind.Capture, itemId: "second" },
    ]);
  });

  it("cascades a credit away with the item it was attributed to, and only that one", async () => {
    // The foreign key IS the mechanism. If this clause were `SET NULL` the row
    // would survive as a permanent credit and no revocation could ever fire.
    await seedWorkspace(WS, { current: 2, ledgerFromDaysAgo: 30 });
    await itemCrediting(WS, "goes", [dayAgo(1), dayAgo(0)]);
    await itemCrediting(WS, "stays", [dayAgo(0)]);
    expect(
      await prisma.engagementDay.count({ where: { workspaceId: WS } }),
    ).toBe(3);

    await prisma.brainDumpItem.delete({ where: { id: "goes" } });

    const left = await prisma.engagementDay.findMany({
      where: { workspaceId: WS },
      select: { day: true, itemId: true },
    });
    expect(left).toEqual([{ day: dayAgo(0), itemId: "stays" }]);
  });
});

describe("streak-badge revocation on delete (#233, closing #251's residual)", () => {
  /**
   * The reachable case, end to end through the real server action.
   *
   * A five-day run whose last day was held up by one to-do. Deleting that to-do
   * empties today, the run recomputes to four, and `streak_5` no longer qualifies.
   */
  it("revokes streak_5 and lowers the counter when a delete empties the run's last day", async () => {
    await seedWorkspace(WS, { current: 5, ledgerFromDaysAgo: 10 });
    // Days 4..1 are held up by an item that is NOT being deleted, so only today
    // loses its credit — that is what makes the expected answer 4 and not 0.
    await itemCrediting(WS, "keeper", [
      dayAgo(4),
      dayAgo(3),
      dayAgo(2),
      dayAgo(1),
    ]);
    const doomed = await itemCrediting(WS, "doomed", [dayAgo(0)]);
    await prisma.badge.create({
      data: {
        workspaceId: WS,
        key: BadgeKey.Streak5,
        earnedAt: midnightAgo(0),
      },
    });

    const { deleteBrainDumpItem } = await import("@/app/actions/braindump");
    await deleteBrainDumpItem(doomed);

    expect(await badgeKeys(WS)).toEqual([]);
    const streak = await prisma.streak.findUnique({
      where: { workspaceId: WS },
    });
    expect(streak?.current).toBe(4);
    expect(streak?.lastActiveWorkday).toBe(dayAgo(1));
  });

  it("KEEPS streak_5 when the day still holds another item's credit", async () => {
    // The gate that stops this being "any delete re-checks every badge". The
    // reversal may well have taken points back; the streak did not move, so
    // nothing about it can be un-qualified.
    await seedWorkspace(WS, { current: 5, ledgerFromDaysAgo: 10 });
    await itemCrediting(WS, "keeper", [
      dayAgo(4),
      dayAgo(3),
      dayAgo(2),
      dayAgo(1),
      dayAgo(0),
    ]);
    const doomed = await itemCrediting(WS, "doomed", [dayAgo(0)]);
    await prisma.badge.create({
      data: {
        workspaceId: WS,
        key: BadgeKey.Streak5,
        earnedAt: midnightAgo(0),
      },
    });

    const { deleteBrainDumpItem } = await import("@/app/actions/braindump");
    await deleteBrainDumpItem(doomed);

    expect(await badgeKeys(WS)).toEqual([BadgeKey.Streak5]);
    expect(
      (await prisma.streak.findUnique({ where: { workspaceId: WS } }))?.current,
    ).toBe(5);
  });

  it("KEEPS streak_5 when the run began before the ledger started recording", async () => {
    // ⚠️ THE SOUNDNESS GATE, and the assertion that says this MR did not simply
    // start revoking things. Coverage began two days ago; the run reaches back
    // five, so the ledger cannot know what supplied days 4 and 3 and the
    // recomputed length is a FLOOR. Acting on it would take a badge off somebody
    // who earned it. This is also the answer for every workspace on the day the
    // backfill runs, which is stated in the MR rather than discovered later.
    await seedWorkspace(WS, { current: 5, ledgerFromDaysAgo: 2 });
    await itemCrediting(WS, "keeper", [
      dayAgo(4),
      dayAgo(3),
      dayAgo(2),
      dayAgo(1),
    ]);
    const doomed = await itemCrediting(WS, "doomed", [dayAgo(0)]);
    await prisma.badge.create({
      data: {
        workspaceId: WS,
        key: BadgeKey.Streak5,
        earnedAt: midnightAgo(0),
      },
    });

    const { deleteBrainDumpItem } = await import("@/app/actions/braindump");
    await deleteBrainDumpItem(doomed);

    expect(await badgeKeys(WS)).toEqual([BadgeKey.Streak5]);
    // …and the counter is left alone too, not quietly corrected on evidence the
    // same call just refused to trust.
    expect(
      (await prisma.streak.findUnique({ where: { workspaceId: WS } }))?.current,
    ).toBe(5);
  });

  it("KEEPS a streak_5 an EARLIER run earned, even when this run drops below five", async () => {
    // `earnedAt` predates the current run, so a previous run is what earned the
    // badge — and that run's length lives in `StreakRecord`, which this cannot
    // recompute. Same `earnedAt` gate `revokeUnqualifiedBadges` already applies to
    // `ten_steps_day`, and for the same reason: it is what makes the answer a
    // reversal rather than a guess.
    await seedWorkspace(WS, { current: 2, ledgerFromDaysAgo: 10 });
    await itemCrediting(WS, "keeper", [dayAgo(1)]);
    const doomed = await itemCrediting(WS, "doomed", [dayAgo(0)]);
    await prisma.badge.create({
      data: {
        workspaceId: WS,
        key: BadgeKey.Streak5,
        earnedAt: midnightAgo(9),
      },
    });

    const { deleteBrainDumpItem } = await import("@/app/actions/braindump");
    await deleteBrainDumpItem(doomed);

    expect(await badgeKeys(WS)).toEqual([BadgeKey.Streak5]);
    // The counter still comes down: it is a fact about the current run, and the
    // recompute for THAT is trusted. Only the badge needed the extra gate.
    expect(
      (await prisma.streak.findUnique({ where: { workspaceId: WS } }))?.current,
    ).toBe(1);
  });

  it("revokes beat_best_streak when the recomputed run no longer beats the best record", async () => {
    // Award condition is `best > 0 && current > best`. Both sides are re-read: the
    // records are untouched by a delete and the run is recomputed, so this is
    // directly recheckable rather than inferred.
    await seedWorkspace(WS, { current: 4, ledgerFromDaysAgo: 10 });
    await prisma.streakRecord.create({
      data: {
        workspaceId: WS,
        length: 3,
        startedAt: midnightAgo(8),
        endedAt: midnightAgo(6),
      },
    });
    await itemCrediting(WS, "keeper", [dayAgo(2), dayAgo(1)]);
    const doomed = await itemCrediting(WS, "doomed", [dayAgo(0)]);
    await prisma.badge.create({
      data: {
        workspaceId: WS,
        key: BadgeKey.BeatBestStreak,
        earnedAt: midnightAgo(0),
      },
    });

    const { deleteBrainDumpItem } = await import("@/app/actions/braindump");
    await deleteBrainDumpItem(doomed);

    // Run falls from 4 to 2, which no longer exceeds the filed best of 3.
    expect(
      (await prisma.streak.findUnique({ where: { workspaceId: WS } }))?.current,
    ).toBe(2);
    expect(await badgeKeys(WS)).toEqual([]);
  });

  it("keeps beat_best_streak after a NATURAL reset has filed the run that earned it", async () => {
    // ⚠️ The reachable shape, and the one where the arithmetic alone gets it wrong.
    //
    // Beat your best with a run of 6, then miss a day. The reset files
    // `StreakRecord(6)`, so `best` becomes 6 and `current` becomes 1 — and
    // `current <= best` is now true, permanently, for a badge that is perfectly
    // well earned. Every user who beats their best and then takes a day off lands
    // here, so a delete on any later day would revoke it on arithmetic alone.
    //
    // Gate 4 is what saves it: `earnedAt` predates the CURRENT run's first day,
    // because the badge was earned by the run that has since been filed. This is
    // the `beat_best_streak` twin of the `streak_5` case above, and it is asserted
    // separately because the two badges reach gate 4 through different conditions.
    await seedWorkspace(WS, { current: 2, ledgerFromDaysAgo: 20 });
    await prisma.streakRecord.create({
      data: {
        workspaceId: WS,
        length: 6,
        startedAt: midnightAgo(12),
        endedAt: midnightAgo(6),
      },
    });
    await itemCrediting(WS, "keeper", [dayAgo(1)]);
    const doomed = await itemCrediting(WS, "doomed", [dayAgo(0)]);
    await prisma.badge.create({
      data: {
        workspaceId: WS,
        key: BadgeKey.BeatBestStreak,
        // Earned during the run that is now filed as the 6-day record.
        earnedAt: midnightAgo(6),
      },
    });

    const { deleteBrainDumpItem } = await import("@/app/actions/braindump");
    await deleteBrainDumpItem(doomed);

    // The counter still comes down — that is a fact about the current run and the
    // recompute for it is trusted…
    expect(
      (await prisma.streak.findUnique({ where: { workspaceId: WS } }))?.current,
    ).toBe(1);
    // …and `current (1) <= best (6)` is true, yet the badge stays.
    expect(await badgeKeys(WS)).toEqual([BadgeKey.BeatBestStreak]);
  });

  it("keeps beat_best_streak while the recomputed run STILL beats the best record", async () => {
    // The control for the case above. Without it, a rule that revoked
    // unconditionally would look identical.
    await seedWorkspace(WS, { current: 5, ledgerFromDaysAgo: 10 });
    await prisma.streakRecord.create({
      data: {
        workspaceId: WS,
        length: 3,
        startedAt: midnightAgo(8),
        endedAt: midnightAgo(6),
      },
    });
    await itemCrediting(WS, "keeper", [
      dayAgo(4),
      dayAgo(3),
      dayAgo(2),
      dayAgo(1),
    ]);
    const doomed = await itemCrediting(WS, "doomed", [dayAgo(0)]);
    await prisma.badge.create({
      data: {
        workspaceId: WS,
        key: BadgeKey.BeatBestStreak,
        earnedAt: midnightAgo(0),
      },
    });

    const { deleteBrainDumpItem } = await import("@/app/actions/braindump");
    await deleteBrainDumpItem(doomed);

    expect(
      (await prisma.streak.findUnique({ where: { workspaceId: WS } }))?.current,
    ).toBe(4);
    expect(await badgeKeys(WS)).toEqual([BadgeKey.BeatBestStreak]);
  });

  it("never revokes comeback, on a delete that DOES revoke its neighbour", async () => {
    // `comeback` records that a streak ended and another began, and the
    // `StreakRecord` row that is the trace of that event survives every delete.
    // Documented as a decision about what the badge MEANS rather than a limit of
    // the schema.
    //
    // ⚠️ THIS TEST'S FIRST VERSION PASSED FOR THE WRONG REASON, and the way it did
    // is worth recording. It collapsed the run to nothing, which made
    // `run.runStart` null, which made `runIsFullyLedgered` refuse to act at all —
    // so NO badge was revoked and the assertion held whatever the rule for
    // `comeback` was. Adding `comeback` to the revocation set left it green.
    //
    // So the shape is: a run that is trustworthy and that DOES lose a badge in the
    // same call. `streak_5` going is the non-zero control that proves the
    // revocation path was reached and had this workspace's `Badge` rows in hand;
    // `comeback` surviving is then a fact about the rule rather than about the
    // gate upstream of it.
    await seedWorkspace(WS, { current: 5, ledgerFromDaysAgo: 10 });
    await prisma.streakRecord.create({
      data: {
        workspaceId: WS,
        length: 4,
        startedAt: midnightAgo(8),
        endedAt: midnightAgo(6),
      },
    });
    await itemCrediting(WS, "keeper", [dayAgo(2), dayAgo(1)]);
    const doomed = await itemCrediting(WS, "doomed", [dayAgo(0)]);
    for (const key of [BadgeKey.Comeback, BadgeKey.Streak5]) {
      await prisma.badge.create({
        data: { workspaceId: WS, key, earnedAt: midnightAgo(0) },
      });
    }

    const { deleteBrainDumpItem } = await import("@/app/actions/braindump");
    await deleteBrainDumpItem(doomed);

    // The run is trustworthy and really did shorten, so the path ran…
    expect(
      (await prisma.streak.findUnique({ where: { workspaceId: WS } }))?.current,
    ).toBe(2);
    // …`streak_5` went, which is the control…
    // …and `comeback` stayed, which is the claim.
    expect(await badgeKeys(WS)).toEqual([BadgeKey.Comeback]);
  });

  it("revokes on an UNTRIAGED delete, where no points are reversed at all", async () => {
    // The case that would be invisible if `engagementDaysOfItem` were gated on
    // `tookCompletion`. A capture is a qualifying engagement, so deleting the
    // untriaged item that was a day's only engagement empties that day while the
    // reward reversal takes nothing back — the two gates genuinely come apart.
    await seedWorkspace(WS, { current: 5, ledgerFromDaysAgo: 10 });
    await itemCrediting(WS, "keeper", [
      dayAgo(4),
      dayAgo(3),
      dayAgo(2),
      dayAgo(1),
    ]);
    await prisma.brainDumpItem.create({
      data: { id: "capture", workspaceId: WS, text: "just a thought" },
    });
    await prisma.engagementDay.create({
      data: {
        workspaceId: WS,
        day: dayAgo(0),
        kind: EngagementKind.Capture,
        itemId: "capture",
      },
    });
    await prisma.badge.create({
      data: {
        workspaceId: WS,
        key: BadgeKey.Streak5,
        earnedAt: midnightAgo(0),
      },
    });

    const { deleteBrainDumpItem } = await import("@/app/actions/braindump");
    await deleteBrainDumpItem("capture");

    // Nothing was banked, so nothing was reversed…
    expect(await prisma.rewardEvent.count({ where: { workspaceId: WS } })).toBe(
      0,
    );
    // …and the badge still went, because the DAY went.
    expect(await badgeKeys(WS)).toEqual([]);
    expect(
      (await prisma.streak.findUnique({ where: { workspaceId: WS } }))?.current,
    ).toBe(4);
  });

  it("touches no other workspace's ledger, streak or badges", async () => {
    // Read against a non-zero in the same run: workspace B ends the test holding
    // exactly what it started with, while A's own badge really did go.
    await seedWorkspace(WS, { current: 5, ledgerFromDaysAgo: 10 });
    await seedWorkspace(OTHER, { current: 5, ledgerFromDaysAgo: 10 });
    await itemCrediting(WS, "keeper", [
      dayAgo(4),
      dayAgo(3),
      dayAgo(2),
      dayAgo(1),
    ]);
    const doomed = await itemCrediting(WS, "doomed", [dayAgo(0)]);
    await itemCrediting(OTHER, "other-item", [dayAgo(1), dayAgo(0)]);
    for (const ws of [WS, OTHER]) {
      await prisma.badge.create({
        data: {
          workspaceId: ws,
          key: BadgeKey.Streak5,
          earnedAt: midnightAgo(0),
        },
      });
    }

    const { deleteBrainDumpItem } = await import("@/app/actions/braindump");
    await deleteBrainDumpItem(doomed);

    expect(await badgeKeys(WS)).toEqual([]); // the non-zero control
    expect(await badgeKeys(OTHER)).toEqual([BadgeKey.Streak5]);
    expect(
      (await prisma.streak.findUnique({ where: { workspaceId: OTHER } }))
        ?.current,
    ).toBe(5);
    expect(
      await prisma.engagementDay.count({ where: { workspaceId: OTHER } }),
    ).toBe(2);
  });

  it("rolls the revocation back with the delete when the transaction fails", async () => {
    // The revocation runs on `tx`, not on `prisma` — a badge deleted by an
    // independent commit would survive a rollback that put the to-do back, which
    // is the bug wearing the fix's clothes. Forced by making the Google sync's
    // read throw AFTER the transaction body has done its work… which it cannot,
    // so this drives the primitive directly inside a transaction that then aborts.
    await seedWorkspace(WS, { current: 5, ledgerFromDaysAgo: 10 });
    await itemCrediting(WS, "keeper", [
      dayAgo(4),
      dayAgo(3),
      dayAgo(2),
      dayAgo(1),
    ]);
    await prisma.badge.create({
      data: {
        workspaceId: WS,
        key: BadgeKey.Streak5,
        earnedAt: midnightAgo(0),
      },
    });

    const { revokeUnqualifiedStreakBadges } = await import("@/lib/rewards");
    const BOOM = "forced rollback";
    await expect(
      prisma.$transaction(async (tx) => {
        const revoked = await revokeUnqualifiedStreakBadges(
          WS,
          [dayAgo(0)],
          tx,
        );
        expect(revoked).toEqual([BadgeKey.Streak5]);
        throw new Error(BOOM);
      }),
    ).rejects.toThrow(BOOM);

    // Both writes are back: the badge and the counter.
    expect(await badgeKeys(WS)).toEqual([BadgeKey.Streak5]);
    expect(
      (await prisma.streak.findUnique({ where: { workspaceId: WS } }))?.current,
    ).toBe(5);
  });
});

describe("the recompute never RAISES a streak (#233)", () => {
  it("leaves a counter that is lower than the ledger alone", async () => {
    // Reachable when a ledger row landed and the counter's own transaction then
    // failed. A delete may take a streak day away and must never grant one, so
    // the update is gated on `run.current < streak.current` — repairing the other
    // direction is not a delete's business.
    await seedWorkspace(WS, { current: 1, ledgerFromDaysAgo: 10 });
    await itemCrediting(WS, "keeper", [dayAgo(3), dayAgo(2), dayAgo(1)]);
    const doomed = await itemCrediting(WS, "doomed", [dayAgo(0)]);

    const { deleteBrainDumpItem } = await import("@/app/actions/braindump");
    await deleteBrainDumpItem(doomed);

    // The ledger says the run is 3; the stored counter said 1. It stays 1.
    expect(
      (await prisma.streak.findUnique({ where: { workspaceId: WS } }))?.current,
    ).toBe(1);
  });
});
