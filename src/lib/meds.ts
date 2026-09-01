import { MedsDoseState } from "@/lib/constants";
// #233 moved these out of `rewards.ts` when the engagement ledger needed them, so
// "what day is it" has ONE derivation shared by the streak and by this module.
// Two derivations differing by an hour would let a dose read as missed on a day
// the streak thinks has not started.
import { isoWeekday, parseWorkingDays, ymd } from "@/lib/engagement-ledger";
import { isUsableHhmm, targetTimeToday } from "@/lib/target-time";

/**
 * #269 — the medication tracker's read model.
 *
 * ## Four states, three stored shapes, and no job
 *
 * | State | How it is represented |
 * | --- | --- |
 * | **Unknown** | no `MedsDoseLog` row |
 * | **Taken** / **Skipped** | a row carrying that `state` |
 * | **Missed** | **derived** — no row, *and* the dose's deadline has passed |
 *
 * `Unknown` and `Missed` are the **same stored shape**; the only thing separating
 * them is what time it is when you look. Nothing writes anything in between, and
 * that is the design's central simplification rather than a shortcut:
 *
 *  1. **Nothing can be missed by the tracker failing to run.** A nightly backfill
 *     that does not fire leaves yesterday reading "not recorded yet" forever. A
 *     derivation cannot fail to fire, because it *is* the read. `bucketOfItem`
 *     (`src/components/inbox/bucket.ts`) derives *Saved for later* the same way.
 *  2. **It is pure, so it is testable without a clock.** `now` is a parameter
 *     with a default, the shape `bucketOfItem(i, now = Date.now())` set.
 *  3. **Correcting the record needs no special case.** Tapping *Taken* at 19:00
 *     on a dose the strip shows as missed just writes the row; there is no
 *     "un-miss" transition, because `Missed` was never a stored value.
 *
 * ⚠️ **The doctrine's known limit is inherited too.** `#260` records that a
 * derived state is cheap and *inexpressive* — it collapses two meanings onto one
 * absence. It does not bite here, and the reason is structural rather than lucky:
 * the third meaning a dose could need — *"today is not a day this applies to"* —
 * is answered by {@link medicationAppliesOn} **before** the derivation runs. A
 * future fourth meaning (a paused medication) gets a column, not a sentinel, and
 * specifically **not** a far-future date: `#260`'s warning is that a year-9999
 * sentinel is indistinguishable from a real timestamp in every query.
 *
 * ## Whose clock — the one question the derivation cannot leave open
 *
 * The reader's. See {@link targetTimeToday}: the container is UTC and
 * `workdayEndTime` is a bare `HH:mm`, so comparing server-side would shift the
 * owner's existing setting by an hour for half the year. **Do not compute `Missed`
 * on the server and send a boolean** — it is stale the moment the clock crosses,
 * and wrong all summer. Callers render from a client-known `now` and re-derive on
 * a tick.
 *
 * A cost stated rather than hidden: `Streak` computes working days on the SERVER
 * (`isoWeekday(new Date())` in `rewards.ts`), so the two features can disagree
 * about which day it is for a reader several hours off UTC. That inconsistency
 * exists today, this module does not widen it, and closing it is not in this
 * slice.
 *
 * ## No AI, ever
 *
 * Nothing in this module or anything downstream of it composes a prompt. `/terms`
 * tells readers not to rely on an AI suggestion for "medication or dosing", and
 * the cheapest way to keep that promise absolutely is for no medication row to
 * reach one. Declined, not deferred.
 */

/**
 * What the UI renders per dose. A superset of {@link MedsDoseState}: two of these
 * are stored and two are computed from the absence of a row.
 */
export const DerivedDoseState = {
  /** No row yet, and the deadline has not passed. */
  Unknown: "unknown",
  Taken: MedsDoseState.Taken,
  Skipped: MedsDoseState.Skipped,
  /** No row, and the deadline HAS passed. Never stored. */
  Missed: "missed",
} as const;
export type DerivedDoseState =
  (typeof DerivedDoseState)[keyof typeof DerivedDoseState];

/** One dose of a medication, as this module needs to see it. */
export type MedsDoseInput = {
  id: string;
  /** "after breakfast" — meal-relative, because the owner's regimen is. */
  label: string;
  quantity: number;
  /** Optional `HH:mm`. Read by the banner and by {@link doseDeadline}, and by
   *  nothing else: it schedules nothing and is not a reminder time. */
  dueAfter: string | null;
  order: number;
};

/** One medication and its ordered doses. */
export type MedsMedicationInput = {
  id: string;
  name: string;
  /** `null` inherits `Settings.workingDays`, which is what makes the owner's
   *  weekday-only regimen the zero-config default. */
  days: string | null;
  active: boolean;
  order: number;
  doses: readonly MedsDoseInput[];
};

/** The two `Settings` columns the derivation reads. */
export type MedsSettingsInput = {
  workdayEndTime: string;
  workingDays: string;
};

/** A row that exists for today, reduced to the two fields that decide a state. */
export type MedsDoseLogInput = {
  medicationDoseId: string;
  state: MedsDoseState;
};

/** One rendered chip: everything an accessible name needs, and the state. */
export type DerivedDose = {
  doseId: string;
  medicationId: string;
  medicationName: string;
  label: string;
  quantity: number;
  dueAfter: string | null;
  state: DerivedDoseState;
};

/**
 * The instant a dose becomes **missed** if no row exists — `max(workdayEndTime,
 * dueAfter)`, in the reader's local time.
 *
 * ⚠️ **`workdayEndTime` alone is the wrong rule, and it is the version that looks
 * right.** It marks a 21:00 dose missed four hours before it is due, which is
 * worse than useless: it teaches the reader that the strip lies. The defect only
 * appears for a regimen nobody has entered yet, which is exactly the kind that
 * ships — so the deadline is a defined term here rather than a field name inlined
 * at each call site.
 *
 * The `max` costs the owner's own regimen nothing: breakfast and lunch are both
 * well before 17:00, so their deadline is 17:00 either way.
 *
 * ⚠️ **An UNUSABLE `dueAfter` is treated as no `dueAfter` at all**, which is a
 * behaviour change from `!364`'s earlier commits and the point of the guard below.
 */
export function doseDeadline(
  dueAfter: string | null,
  workdayEndTime: string,
  now: Date,
): number {
  const workdayEnd = targetTimeToday(workdayEndTime, now);
  /**
   * ⚠️ **`isUsableHhmm` FIRST, because a fallback fed into a `max` is not a
   * fallback.** Duo review round 4 of `!364`, grounded and reproduced.
   *
   * `targetTimeToday` degrades an unusable time to 17:00 rather than to `NaN`, and
   * that is right for `workdayEndTime` — 17:00 is that column's own schema
   * default. It is not right *here*. Passing the degraded value into
   * `Math.max(workdayEnd, …)` does not fall back, it takes the LATER of the two,
   * and 17:00 is not any kind of default for `MedicationDose.dueAfter`, whose
   * absent value is `null`.
   *
   * So for a workspace that set an earlier `workdayEndTime` the two diverged: at
   * `"09:00"` a dose with `dueAfter: null` was due by 09:00 while the same
   * medication with `dueAfter: "25:00"` was not late until 17:00 — eight extra
   * hours, bought by a value nobody could have meant, and in the direction nobody
   * notices. It is a smaller instance of the day-shift defect this function was
   * already fixed for: a deadline later than it should be means a dose that reads
   * as fine when it is not, on a health record.
   *
   * Every earlier spec missed it by passing `"17:00"`, the default, which makes
   * `max(17:00, 17:00)` correct by coincidence of the fixture. The specs now pin
   * the equivalence against a CUSTOMISED end time, which is the input that tells
   * "collapses to `workdayEndTime`" apart from "happens to agree with it".
   *
   * Fixed here rather than in `targetTimeToday` because that function has exactly
   * one other use — `workdayEnd` above — and the fallback is correct for it. The
   * range rule itself is NOT duplicated: `isUsableHhmm` and `targetTimeToday`
   * share one private parse in `target-time.ts`, so the predicate cannot come to
   * disagree with the resolver about what `"24:00"` is.
   */
  if (dueAfter == null || !isUsableHhmm(dueAfter)) return workdayEnd;
  return Math.max(workdayEnd, targetTimeToday(dueAfter, now));
}

/**
 * Does this medication apply on `now`'s day?
 *
 * `days` null delegates to `Settings.workingDays` — the repo's nullable-inherits
 * convention (`Settings.focusTimerStyle`, `Settings.breakdownModel`), where null
 * means "ask somewhere else" rather than "unset".
 *
 * **Empty or malformed CSV fails CLOSED.** `parseWorkingDays` filters to 1..7, so
 * `""`, `"   "` and `"0,8"` all yield `[]` and no day matches — no dose is due and
 * nothing is ever missed. That is the right answer for a value nobody can have
 * meant, and it is pinned by a test rather than relied on as a coincidence.
 */
export function medicationAppliesOn(
  days: string | null,
  workingDays: string,
  now: Date,
): boolean {
  return parseWorkingDays(days ?? workingDays).includes(isoWeekday(now));
}

/**
 * How far the client's local date may sit from the server's UTC date.
 *
 * The client sends its own local day because the server cannot know the reader's
 * timezone — `MedsDoseLog.date` is a calendar fact in their time, not the
 * container's. That must not quietly become a backfill API: a caller posting an
 * arbitrary date could fabricate a history v2 will later visualise as fact.
 *
 * ⚠️ **It lives HERE, in a pure module, and NOT in the server action — that is a
 * security boundary, not tidiness.**
 *
 * `"use server"` exports are POST endpoints. Next's own docs for this version:
 * *"the route is reachable to anyone who can send the same POST. Treat every
 * action as an untrusted entry point."* So every argument of an action is an
 * untrusted input, and this predicate's `now` was briefly one of them — meaning
 * a caller could supply BOTH the date and the clock it is judged against and
 * make any date plausible. The action now always passes its own `new Date()`
 * and accepts no clock at all.
 *
 * Injectability is free in a pure function and is an INPUT SURFACE on an action.
 * That is why `deriveTodayDoses` and `targetTimeToday` take a `now` and
 * `logMedsDose` must not: the precedent was real, the analogy was not.
 *
 * Real UTC offsets span UTC-12 to UTC+14, so a genuine local date is at most one
 * day either side of the server's. One day is therefore the tightest bound that
 * refuses nothing legitimate — narrower and the reader in Auckland at 09:00 or in
 * Honolulu at 22:00 is told their own today is invalid.
 */
export const MAX_DATE_DRIFT_DAYS = 1;

/**
 * Is `date` a canonical `YYYY-MM-DD` naming a day the reader could plausibly be
 * on right now?
 *
 * ⚠️ **Validated by ROUND-TRIP rather than by a pattern, and that is deliberate.**
 * The obvious `/^\d{4}-\d{2}-\d{2}$/` is linear and perfectly safe, and
 * `gitlab-advanced-sast` reports it anyway as CWE-185 "Incorrect regular
 * expression" — measured on this exact line in pipeline 3471. Dismissing it would
 * work once: the fingerprint includes the LINE NUMBER, so the same statement
 * comes back as a new finding every time an unrelated edit moves it down the
 * file. `src/lib/pick-one.ts` records what that costs — one `Math.random` in
 * `focus-timer.tsx` dismissed five separate times at five different lines. There
 * is no regex to flag if there is no regex.
 *
 * The round trip is also the STRICTER check. It accepts exactly the canonical
 * rendering and nothing else, so `"2026-8-1"`, `"2026-08-1"`, `"+002026-08-17"`
 * and a 32nd of a month are all refused — the last by `Date.UTC`'s silent
 * roll-over showing up as a different string, which a pattern would have let
 * through.
 *
 * Both sides are built field by field against UTC, so the comparison is a pure
 * day count that does not itself depend on the container's timezone.
 *
 * ## The two-digit year, and why there is no extra guard for it
 *
 * ⚠️ Duo review round 5 of `!364`. `Date.UTC(y, …)` inherits `Date`'s legacy
 * remap: `y` in `0..99` becomes `1900 + y`, so `"0050-08-17"` computes `asked`
 * from 1950 and the year is never checked *as a year*. That observation is
 * correct. Two conclusions drawn from it are not, and both were checked rather
 * than argued:
 *
 *  1. **The drift bound is not what refuses it — the round trip is, structurally.**
 *     A remapped year always renders as `19xx`, and no string whose `Number` is
 *     under 100 is spelled `19xx`, so the rendering can never equal the input.
 *     Measured across the class: eleven inputs, **zero** survive the round trip.
 *     `meds.test.ts` pins it against a **1950 clock**, which makes the drift check
 *     accept 1950 and so removes it from the argument entirely. The protection
 *     therefore does not weaken if this predicate is reused over a wider range.
 *  2. **"Require exactly four digits" would not fix the case it was suggested
 *     for.** `"0050"` *is* exactly four digits and still remaps. A guard shaped
 *     like that would read as though it closed this and would not — the precise
 *     failure the finding is about, arriving through the remedy.
 *
 * So no second rejection path was added. The round trip is a total canonical-form
 * check and everything else masked by it is masked the same way — `"2026-8-1"`,
 * `"+002026-08-17"`, a hex day, a trailing space, a 32nd of a month. Adding a
 * partial year check beside it would give a future reader two rules to keep in
 * step and an invitation to drop the round trip as redundant, which is what
 * actually reopens all of the above. What was missing was the *proof*, not the
 * code: it is now in `meds.test.ts` as two specs, one of them a control that
 * `"0100-08-17"` and `"0500-08-17"` — canonical four-digit years outside the remap
 * range — are still accepted.
 */
export function isPlausibleLocalDate(date: string, now: Date): boolean {
  const parts = date.split("-");
  if (parts.length !== 3) return false;
  const [y, m, d] = parts.map(Number);
  if (!Number.isInteger(y) || !Number.isInteger(m) || !Number.isInteger(d)) {
    return false;
  }
  const asked = Date.UTC(y, m - 1, d);
  // Out of the range `Date` can hold. Guarded before `toISOString`, which throws
  // a RangeError on an invalid date rather than returning anything.
  if (!Number.isFinite(asked)) return false;
  if (new Date(asked).toISOString().slice(0, 10) !== date) return false;

  const serverDay = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate(),
  );
  return Math.abs(asked - serverDay) / 86_400_000 <= MAX_DATE_DRIFT_DAYS;
}

/**
 * Today's doses, in render order, each carrying its derived state.
 *
 * `logs` must already be the rows for `now`'s local day — the caller reads them by
 * `(workspaceId, date)`, which is what the unique index is for. Passing another
 * day's rows would mislabel every chip, so {@link todayKey} is exported beside
 * this to keep both sides using one derivation of the date.
 *
 * `now` is a `Date` rather than the epoch number `bucketOfItem` takes, because
 * this needs calendar fields (the weekday, and the day `HH:mm` is applied to) and
 * not just an ordering. The injected-with-a-default shape is the part that
 * matters.
 */
export function deriveTodayDoses(input: {
  medications?: readonly MedsMedicationInput[];
  settings?: MedsSettingsInput;
  logs?: readonly MedsDoseLogInput[];
  now?: Date;
}): DerivedDose[] {
  const {
    medications = [],
    settings = { workdayEndTime: "17:00", workingDays: "1,2,3,4,5" },
    logs = [],
    now = new Date(),
  } = input;

  const stateByDose = new Map(logs.map((l) => [l.medicationDoseId, l.state]));
  const out: DerivedDose[] = [];

  // Sorted rather than trusted: two reads of the same data must render in the
  // same order, and the `id` tie-break is what makes that true when two rows
  // share an `order` — the shape `splitShoppingList` uses for the same reason.
  const meds = [...medications].sort(
    (a, b) => a.order - b.order || a.id.localeCompare(b.id),
  );

  for (const med of meds) {
    if (!med.active) continue;
    if (!medicationAppliesOn(med.days, settings.workingDays, now)) continue;

    const doses = [...med.doses].sort(
      (a, b) => a.order - b.order || a.id.localeCompare(b.id),
    );
    for (const dose of doses) {
      const stored = stateByDose.get(dose.id);
      const state: DerivedDoseState =
        stored ??
        (now.getTime() >=
        doseDeadline(dose.dueAfter, settings.workdayEndTime, now)
          ? DerivedDoseState.Missed
          : DerivedDoseState.Unknown);
      out.push({
        doseId: dose.id,
        medicationId: med.id,
        medicationName: med.name,
        label: dose.label,
        quantity: dose.quantity,
        dueAfter: dose.dueAfter,
        state,
      });
    }
  }
  return out;
}

/** Is this dose one no row exists for — whether or not its deadline has passed? */
export function isUnrecorded(dose: DerivedDose): boolean {
  return (
    dose.state === DerivedDoseState.Unknown ||
    dose.state === DerivedDoseState.Missed
  );
}

/**
 * The dose both nav modes act on: the first with no row.
 *
 * A **missed** dose is still unrecorded and is still offered, deliberately —
 * tapping *Taken* at 19:00 on a dose the strip shows as missed is the correction
 * path, and there is no repair transition to write because `Missed` was never
 * stored.
 */
export function nextUnrecordedDose(
  doses: readonly DerivedDose[],
): DerivedDose | null {
  return doses.find(isUnrecorded) ?? null;
}

/**
 * The `YYYY-MM-DD` key a log row is written under, in the reader's local time.
 *
 * Re-exported from `engagement-ledger.ts` rather than re-implemented: `ymd` there
 * is already the repo's one local-date derivation, and a second one differing by a
 * timezone would put a dose on the wrong day of the history v2 cannot backfill.
 */
export { ymd as todayKey };
