/**
 * Pure timer arithmetic for the focus timer (MR ②). No React/DOM — the client
 * component drives its state through these so the math is unit-tested in
 * isolation. See the spec, Design B (symmetric ±time, "±Xm" net note).
 */

/** The countdown can never be pushed to/under this by a −time tap. */
export const MIN_REMAINING_SEC = 60;

/** Format whole seconds as `m:ss` (seconds zero-padded); negatives floor to 0:00. */
export function mmss(totalSec: number): string {
  const s = Math.max(0, Math.floor(totalSec));
  const m = Math.floor(s / 60);
  const sec = s % 60;
  return `${m}:${sec.toString().padStart(2, "0")}`;
}

/**
 * Apply a signed time delta (seconds) to the clock. Positive grows total +
 * remaining equally; negative shrinks both, but remaining is clamped to a 60s
 * floor and total only shrinks by the amount actually applied (so elapsed time
 * is preserved and the timer can't be pushed to time-up by a −time tap).
 */
export function applyTimeDelta(
  clock: { totalSec: number; remainingSec: number },
  deltaSec: number,
): { totalSec: number; remainingSec: number } {
  const newRemaining = Math.max(MIN_REMAINING_SEC, clock.remainingSec + deltaSec);
  const applied = newRemaining - clock.remainingSec;
  return { totalSec: clock.totalSec + applied, remainingSec: newRemaining };
}

/** Signed net minutes added vs the planned duration (drives the "±Xm" note). */
export function netAddedMin(totalSec: number, plannedSec: number): number {
  return Math.round((totalSec - plannedSec) / 60);
}

/** Depletion fraction remaining/total in [0,1]; 0 when total is 0. */
export function timerFraction(remainingSec: number, totalSec: number): number {
  return totalSec > 0 ? remainingSec / totalSec : 0;
}
