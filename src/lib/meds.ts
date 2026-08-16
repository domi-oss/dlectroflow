import { MedsDoseState } from "@/lib/constants";
// #233 moved these out of `rewards.ts` when the engagement ledger needed them, so
// "what day is it" has ONE derivation shared by the streak and by this module.
// Two derivations differing by an hour would let a dose read as missed on a day
// the streak thinks has not started.
import { isoWeekday, parseWorkingDays, ymd } from "@/lib/engagement-ledger";
import { targetTimeToday } from "@/lib/target-time";

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
 */
export function doseDeadline(
  dueAfter: string | null,
  workdayEndTime: string,
  now: Date,
): number {
  const workdayEnd = targetTimeToday(workdayEndTime, now);
  if (dueAfter == null) return workdayEnd;
  // A malformed `dueAfter` resolves to 17:00 rather than NaN (see
  // `targetTimeToday`), so `Math.max` cannot be poisoned into never comparing
  // true — which would make the dose silently un-missable.
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
