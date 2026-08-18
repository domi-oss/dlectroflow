/**
 * #269 — an `HH:mm` setting resolved against a day, in the READER'S local time.
 *
 * ## Why this is a shared module and not a private helper
 *
 * It was private to `src/components/dashboard/roundup-card.tsx`, where it decides
 * when the end-of-day round-up fires. The medication tracker needs the identical
 * comparison for a different column — a dose is *missed* once the local clock
 * passes `max(Settings.workdayEndTime, MedicationDose.dueAfter)` — and a second
 * caller is what turns "a helper" into a shared one. Two copies of this would be
 * `#117`'s failure in a place where the two copies could disagree about what
 * "17:00" means, which is the whole thing the function exists to pin down.
 *
 * ## Whose clock, and why the answer is the browser's
 *
 * `Settings.workdayEndTime` is a bare `"HH:mm"` with no timezone, so "has the
 * workday ended" is meaningless until you say *whose* 17:00. The repo has already
 * answered: the round-up card interprets it against `new Date()` inside a client
 * effect, so the stored string already means *17:00 where the user is*. The
 * production container runs UTC, so evaluating the same string server-side would
 * shift the owner's existing setting by an hour for half the year — same string,
 * same user, different behaviour depending on which module read it. Callers pass
 * a client-known instant and get a local answer.
 *
 * ## `now` is a parameter with a default
 *
 * The shape `bucketOfItem(i, now = Date.now())` established: the comparison is
 * pure and testable with no clock mocking, and a caller polling across midnight
 * passes a fresh instant per tick rather than one captured when its effect ran.
 */

/** The `HH:mm` this repo falls back to when a stored value is unusable. */
const FALLBACK_HOUR = 17;
const FALLBACK_MINUTE = 0;

/**
 * `hhmm` split into its two numbers, or `null` if it is unusable.
 *
 * ⚠️ **The ONE range rule, and the reason it is extracted.** Two callers need the
 * same answer to "is this value usable" — this module, to decide whether to fall
 * back, and `doseDeadline` (`src/lib/meds.ts`), to decide whether a `dueAfter`
 * counts as stated at all. A second copy of `\d{1,2}:\d{2}` plus the 0..23/0..59
 * bounds is the drift this file's own docblock argues against one section down,
 * and it would drift in the direction that matters: the copy that still accepted
 * `"25:00"` would be the one deciding a medication deadline.
 *
 * Returned as a parsed pair rather than a boolean so the predicate and the
 * resolver cannot disagree about what they parsed, only about what to do with it.
 */
function parseHhmm(hhmm: string): { hour: number; minute: number } | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm);
  if (!m) return null;
  const hour = Number(m[1]);
  const minute = Number(m[2]);
  // Shape and range are two ways for one input to be wrong, so they share an
  // answer. `"24:00"` is refused here too — see `targetTimeToday`'s docblock for
  // why that is a decision rather than an oversight.
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
  return { hour, minute };
}

/**
 * Is `hhmm` a time this repo can use, as opposed to one it would fall back for?
 *
 * Exported for callers that must treat an unusable value as **absent** rather
 * than as the fallback. `doseDeadline` is the case that earned it: it composes
 * `max(workdayEndTime, dueAfter)`, and feeding a fallback into a `max` is not the
 * same thing as falling back — it silently takes the LATER of the two, so an
 * unusable `dueAfter` moved a medication's deadline to 17:00 even for a workspace
 * whose own workday ends at 09:00. Asking this first is what lets that caller say
 * "no time was stated" and mean it.
 */
export function isUsableHhmm(hhmm: string): boolean {
  return parseHhmm(hhmm) !== null;
}

/**
 * `hhmm` applied to `now`'s calendar day, as epoch milliseconds.
 *
 * An unusable value degrades to 17:00 rather than throwing or producing `NaN`,
 * which is the posture `Settings.typeface` documents for an out-of-set value and
 * the behaviour `roundup-card.tsx` already had: a hand-edited row should make the
 * round-up fire at the default time, not stop the card rendering. `NaN` would be
 * worse than either, because every comparison against it is false — a dose would
 * silently never be missed.
 *
 * ## "Unusable" means out of RANGE as well as the wrong shape
 *
 * ⚠️ Duo review of `!364`, grounded and reproduced. A shape check alone accepts
 * `"25:00"` and `"12:99"` — one-to-two digits then two digits — and
 * `setHours(25, 0)` neither throws nor gives `NaN`: it **normalises into the next
 * day**. Measured on the unfixed code, `"25:00"` produced Tue 18 Aug 01:00 from a
 * Monday. So the fallback this docblock promises was unreachable for exactly the
 * inputs it exists for, and the failure was a silent day shift rather than a
 * visible error.
 *
 * That matters most on the surface it was extracted for. `doseDeadline` calls
 * this on `MedicationDose.dueAfter`, a column with **no CHECK constraint by
 * design**, and a deadline pushed into tomorrow means a dose that can never read
 * as *missed* today — on a health record, and in the direction nobody notices.
 *
 * **One rejection path, not two.** Shape and range are two ways for the same
 * input to be wrong, so they share an answer; a second fallback for range would
 * be a second thing to keep in step with this one.
 *
 * ## `"24:00"` is REFUSED, and that is a decision rather than an accident
 *
 * ISO 8601 does allow `24:00` as an end-of-day designator, and it is a fairly
 * natural way to type "midnight". It is refused here anyway, for two reasons that
 * point the same way:
 *
 *  * The two readings disagree. As `00:00` **tomorrow** it is the day-roll bug
 *    with a nicer name. As `23:59:59.999` **today** it is a value the reader
 *    never typed, invented on their behalf.
 *  * A deadline is compared with `>=`, so an end-of-day deadline means the dose
 *    is only ever missable in the last millisecond of its own day — which is
 *    indistinguishable from "never missed" and is the wrong direction to fail on
 *    a medication record.
 *
 * Falling back to 17:00 lands it on `Settings.workdayEndTime`'s own default, so
 * the reader gets the documented default rather than a silently different day.
 *
 * ⚠️ **This section used to claim that made an unusable `dueAfter` behave like a
 * dose with no stated time, because `max(workdayEndTime, dueAfter)` "collapses to
 * `workdayEndTime`". That was only ever true for a workspace whose end time is
 * 17:00 or later** — Duo review round 4 of `!364`, grounded and reproduced. The
 * fallback is a value, and feeding a value into a `max` is not the same thing as
 * declining to state one: at `workdayEndTime: "09:00"` the `max` took 17:00 and
 * bought the dose eight extra hours before it could read as *missed*, measured as
 * `expected 1786982400000 to be 1786953600000`.
 *
 * The composition was fixed rather than this paragraph narrowed, because the
 * behaviour was wrong and not merely undocumented — `doseDeadline` now asks
 * {@link isUsableHhmm} first and treats an unusable `dueAfter` as absent. **So
 * this fallback is correct for `workdayEndTime` and must not be relied on for
 * `dueAfter`**, and the difference is which of the two the value is a default
 * FOR: 17:00 is `Settings.workdayEndTime`'s schema default, and it is not any
 * kind of default for `MedicationDose.dueAfter`, whose absent value is `null`.
 *
 * A caller composing this into a comparison rather than using it as an answer
 * needs {@link isUsableHhmm}; that is the whole reason the predicate is exported.
 *
 * `now` is not mutated: the setter runs on a copy, because a caller polling on an
 * interval hands the same `Date` to several readers.
 */
export function targetTimeToday(hhmm: string, now: Date = new Date()): number {
  const parsed = parseHhmm(hhmm);
  const h = parsed ? parsed.hour : FALLBACK_HOUR;
  const min = parsed ? parsed.minute : FALLBACK_MINUTE;
  const d = new Date(now.getTime());
  d.setHours(h, min, 0, 0);
  return d.getTime();
}
