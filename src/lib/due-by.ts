/**
 * #187 — "due Thu 13 Aug", for a row that has a deadline.
 *
 * Pure module — no React, no DOM, no Prisma — like `focus-launcher.ts` and
 * `focus-next.ts` beside it, so the two decisions worth arguing about (which
 * calendar day, and whether that day has passed) are unit-testable without a
 * renderer.
 *
 * It deliberately returns PARTS rather than a finished sentence. The visible
 * wording is voice-aware (`t()`) and the overdue counterpart is a separate
 * element from the date, so composing the string here would either duplicate the
 * string table or force the component to take the sentence apart again.
 */
import { formatShortDay, toZonedDateInput } from "@/lib/scheduling/hours";

export type DueBy = {
  /** `"Thu 13 Aug"` — weekday-first, month by name. */
  dayText: string;
  /** `"2026-08-13"` in the scheduling zone: the `<time dateTime>` value. */
  isoDate: string;
  /** The due DAY is strictly before today's — see the note on the comparison. */
  overdue: boolean;
};

/** Milliseconds for a Date or an ISO string; `null` for anything unreadable. */
function instantOf(value: Date | string | null | undefined): Date | null {
  if (value == null) return null;
  const d = typeof value === "string" ? new Date(value) : value;
  return Number.isFinite(d.getTime()) ? d : null;
}

/**
 * The due-by a launcher row shows, or `null` when it has no deadline to show.
 *
 * `null` covers "no deadline" AND "a deadline this code cannot read", and the
 * caller renders nothing for either: an empty slot on every row is noise on a
 * screen tuned for quiet, and an "Invalid Date" is worse than silence.
 *
 * **Overdue is a comparison of DAYS, not of instants.** The Schedule menu asks
 * for a day (`<input type="date">`) and `fromZonedDateInput` keeps whatever time
 * of day the previous value carried, so the hour on a deadline is an artefact
 * rather than a choice. Comparing instants would flip a to-do due *today* into
 * "Overdue" at some arbitrary minute past midnight, and would flip it while the
 * user was looking at it.
 *
 * `now` is passed in rather than read here: the /focus page stamps the clock
 * once per request and hands it down (the rule #105 established for the inbox),
 * so the server's markup and the browser's hydration are rendered from the same
 * instant.
 *
 * `timeZone` is likewise passed by the page. `schedulingTimeZone()` reads a
 * server-only env var, which is `undefined` in the browser bundle — so relying
 * on its default inside a client component would silently format in
 * Europe/London for a self-hoster who set another zone, and disagree with the
 * server's own markup.
 */
export function dueByLabel(
  dueAt: Date | string | null | undefined,
  now: number,
  timeZone?: string,
): DueBy | null {
  const due = instantOf(dueAt);
  if (!due) return null;

  // Both sides through the same YYYY-MM-DD projection, which sorts
  // lexicographically — so "is this day before that day" needs no arithmetic
  // and no second notion of when a day starts.
  const isoDate = toZonedDateInput(due, timeZone);
  const today = toZonedDateInput(new Date(now), timeZone);

  return {
    dayText: formatShortDay(due, timeZone),
    isoDate,
    overdue: isoDate < today,
  };
}
