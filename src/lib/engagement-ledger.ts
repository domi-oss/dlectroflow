/**
 * #233 — the per-day engagement ledger's pure half: turning a set of engagement
 * days back into a streak.
 *
 * ── What this module is for ─────────────────────────────────────────────────
 *
 * `touchStreakOnEngagement` (src/lib/rewards.ts) can only ever INCREMENT.
 * `Streak` stores `current` and `lastActiveWorkday`, so "the streak is 7" is a
 * counter with no working behind it, and the question `#251` needed — *"would
 * this day still have counted without the item the user just deleted?"* — has no
 * answer. `EngagementDay` records the working, and this module reads it back.
 *
 * ── No `prisma` import, and that is a rule rather than a preference ─────────
 *
 * `CLAUDE.md` requires every file-parsing guard in this repo to be a pure module
 * with no `fs`, so its parsing can be exercised on synthetic input. The same
 * argument applies with more force here, because this is the code that decides
 * whether to take a badge away from somebody: the shapes that matter are a run
 * broken by ONE missed working day, a run that straddles the instant the ledger
 * started recording, and a working week that is not Monday-to-Friday. A real
 * database would take weeks of wall-clock time to produce them; a `Set<string>`
 * produces them in a line. `engagement-ledger.test.ts` drives every case here
 * with no database at all, and `rewards.ts` owns the reads.
 *
 * ── Why `ymd` and friends live here rather than in `rewards.ts` ─────────────
 *
 * They were private to `rewards.ts` and are now shared, because this module and
 * that one have to agree EXACTLY about what day it is — the ledger's `day` column
 * and `Streak.lastActiveWorkday` are compared as strings, so two derivations of
 * "today" that differed by an hour would make a streak silently unrecomputable.
 * This repo has already paid twice for two copies of one rule drifting apart
 * (`isBefore` and `parseCheckConstraintName` in the migration harness say so in
 * as many words), so there is one copy and `rewards.ts` imports it.
 */

/**
 * How far back the walk in {@link recomputeRun} will look before giving up.
 *
 * The walk terminates naturally at the first working day with no engagement, so
 * the only shape that needs a bound is a ledger with NO gap at all — every
 * working day present, back past the point where a run length stops being
 * meaningful. Ten years of calendar days: long enough that no real streak reaches
 * it, short enough that the loop is microseconds.
 *
 * Hitting it sets `truncated`, and callers must treat a truncated run as a FLOOR
 * rather than an answer. A silent cap would understate a run, and understating a
 * run is exactly what revokes a badge somebody still qualifies for.
 */
export const MAX_LEDGER_LOOKBACK_DAYS = 3660;

/** Local `YYYY-MM-DD`. The ledger's `day` column and `Streak.lastActiveWorkday`
 *  are both this, so they compare as strings. */
export function ymd(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
    d.getDate(),
  ).padStart(2, "0")}`;
}

/**
 * A `YYYY-MM-DD` back to LOCAL midnight — `ymd`'s inverse.
 *
 * Built field by field rather than with `new Date("2026-08-10")`, which the spec
 * requires to be parsed as **UTC** midnight: west of Greenwich that is the
 * previous local day, so the round trip through `ymd` would lose a day for every
 * user in the Americas. The three arguments are read back by the local getters
 * `ymd` uses, so the pair is each other's inverse in every timezone.
 */
export function parseYmd(day: string): Date {
  const [y, m, d] = day.split("-").map((n) => parseInt(n, 10));
  return new Date(y, m - 1, d, 0, 0, 0, 0);
}

/** ISO weekday, 1 = Monday … 7 = Sunday. */
export function isoWeekday(d: Date): number {
  const wd = d.getDay(); // 0=Sun..6=Sat
  return wd === 0 ? 7 : wd;
}

/** `Settings.workingDays`, a CSV of ISO weekdays. Anything outside 1-7 is
 *  dropped rather than defaulted, so a hand-edited row degrades to "fewer
 *  working days" instead of to a silently wrong week. */
export function parseWorkingDays(csv: string): number[] {
  return csv
    .split(",")
    .map((s) => parseInt(s.trim(), 10))
    .filter((n) => n >= 1 && n <= 7);
}

/** The streak, recomputed from the ledger. */
export interface LedgerRun {
  /** Consecutive working days with at least one engagement, ending at
   *  `lastActiveWorkday`. The same number `Streak.current` holds. */
  current: number;
  /** The most recent working day not in the future that carries an engagement,
   *  or `null` when the ledger holds none. */
  lastActiveWorkday: string | null;
  /** The first day of that run — what {@link runIsFullyLedgered} is asked
   *  about. */
  runStart: string | null;
  /** Set when the walk hit {@link MAX_LEDGER_LOOKBACK_DAYS}, which makes
   *  `current` a floor. Absent otherwise, so a caller that forgets to check it
   *  is not silently handed `false`. */
  truncated?: true;
}

/**
 * The run of consecutive WORKING days with engagement, ending at the latest such
 * day that is not in the future.
 *
 * ── This is a calendar walk, not a row count ────────────────────────────────
 *
 * Two engagement days a week apart are two runs of one, not a run of two, so the
 * only correct way to read the ledger is to step day by day and stop at the first
 * working day that is missing. Counting rows, or counting distinct days, gives
 * the right answer for an unbroken streak and the wrong one for every broken
 * streak — which is the only case revocation cares about.
 *
 * ── Non-working days are stepped OVER, not counted ──────────────────────────
 *
 * `touchStreakOnEngagement` has always skipped them ("non-working days don't
 * break it"), and it also never advances on one. Both halves are reproduced here,
 * or the recompute and the increment disagree about the same history: a row
 * recorded on a Saturday is in the ledger — it is a truthful log — and neither
 * extends a run nor ends one.
 *
 * ── Future days are ignored ─────────────────────────────────────────────────
 *
 * Production runs two replicas and a row can be written moments after local
 * midnight on one of them. A day after `today` must not become the run's end, or
 * the walk starts from a day nothing has happened on and reports a gap.
 *
 * @param engagementDays every `day` value the workspace has in `EngagementDay`
 * @param workingDays ISO weekdays from {@link parseWorkingDays}
 * @param today `ymd(new Date())` — passed in rather than read, so the caller's
 *              notion of now is the only one in play and every case is testable
 */
export function recomputeRun(
  engagementDays: ReadonlySet<string>,
  workingDays: readonly number[],
  today: string,
): LedgerRun {
  const none: LedgerRun = {
    current: 0,
    lastActiveWorkday: null,
    runStart: null,
  };
  if (workingDays.length === 0) return none;

  const isWorking = (day: string) =>
    workingDays.includes(isoWeekday(parseYmd(day)));

  // The run's end: the latest working day that is not in the future and carries
  // an engagement. Read off the set rather than by walking back from today,
  // because the gap between today and the last active day can be arbitrarily
  // large and is not interesting.
  let lastActiveWorkday: string | null = null;
  for (const day of engagementDays) {
    if (day > today) continue; // lexicographic === chronological for YYYY-MM-DD
    if (!isWorking(day)) continue;
    if (lastActiveWorkday === null || day > lastActiveWorkday) {
      lastActiveWorkday = day;
    }
  }
  if (lastActiveWorkday === null) return none;

  // Walk backwards from there. `cursor` moves one CALENDAR day at a time and only
  // working days are examined, which is what steps over a weekend.
  let current = 1;
  let runStart = lastActiveWorkday;
  const cursor = parseYmd(lastActiveWorkday);
  for (let step = 0; step < MAX_LEDGER_LOOKBACK_DAYS; step++) {
    cursor.setDate(cursor.getDate() - 1);
    const day = ymd(cursor);
    if (!workingDays.includes(isoWeekday(cursor))) continue; // skipped, not broken
    if (!engagementDays.has(day)) {
      return { current, lastActiveWorkday, runStart };
    }
    current += 1;
    runStart = day;
  }
  // Ran out of lookback with the run still unbroken: `current` is a floor.
  return { current, lastActiveWorkday, runStart, truncated: true };
}

/**
 * Whether a recomputed run is safe to act on — i.e. whether the ledger holds
 * EVERY engagement that could have contributed to it.
 *
 * ── The whole soundness argument, in one place ──────────────────────────────
 *
 * `Streak.ledgerFrom` is the instant from which `EngagementDay` records every
 * qualifying engagement for the workspace. Rows before it exist (the backfill
 * dates what it can from surviving `RewardEvent` and `BrainDumpItem` rows) but
 * they are not complete, because a reward row that was later reversed leaves no
 * trace of the engagement it recorded.
 *
 * So a recomputed run whose first day began BEFORE that instant may be shorter
 * than the real one — the ledger simply does not know about part of it. Acting on
 * it would revoke a badge on the strength of evidence that was never collected.
 * A run whose first day began at or after it cannot be short: the working day
 * before it is inside the covered span and holds no row, so it genuinely had no
 * engagement.
 *
 * That is why `ledgerFrom` is an instant and the comparison happens here, in JS:
 * `parseYmd` gives the run's first day at LOCAL midnight, which is the same
 * derivation `ymd` and `Streak.lastActiveWorkday` use. A `YYYY-MM-DD` column
 * would have needed the migration's SQL to agree with this process about which
 * timezone "today" is in, and nothing guarantees that.
 *
 * `null` — no run at all — is NOT trustworthy. "The ledger holds no engagement"
 * and "this workspace has never engaged" are different claims, and only the
 * second would justify zeroing a streak.
 */
export function runIsFullyLedgered(
  runStart: string | null,
  ledgerFrom: Date,
): boolean {
  if (runStart === null) return false;
  return parseYmd(runStart).getTime() >= ledgerFrom.getTime();
}
