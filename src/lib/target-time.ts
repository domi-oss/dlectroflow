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

/** The `HH:mm` this repo falls back to when a stored value is unparseable. */
const FALLBACK_HOUR = 17;
const FALLBACK_MINUTE = 0;

/**
 * `hhmm` applied to `now`'s calendar day, as epoch milliseconds.
 *
 * A malformed value degrades to 17:00 rather than throwing or producing `NaN`,
 * which is the posture `Settings.typeface` documents for an out-of-set value and
 * the behaviour `roundup-card.tsx` already had: a hand-edited row should make the
 * round-up fire at the default time, not stop the card rendering. `NaN` would be
 * worse than either, because every comparison against it is false — a dose would
 * silently never be missed.
 *
 * `now` is not mutated: the setter runs on a copy, because a caller polling on an
 * interval hands the same `Date` to several readers.
 */
export function targetTimeToday(hhmm: string, now: Date = new Date()): number {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm);
  const h = m ? Number(m[1]) : FALLBACK_HOUR;
  const min = m ? Number(m[2]) : FALLBACK_MINUTE;
  const d = new Date(now.getTime());
  d.setHours(h, min, 0, 0);
  return d.getTime();
}
