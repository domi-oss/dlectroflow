/**
 * Pure timer arithmetic for the focus timer (MR ②). No React/DOM — the client
 * component drives its state through these so the math is unit-tested in
 * isolation. See the spec, Design B (symmetric ±time, "±Xm" net note).
 */

/** The countdown can never be pushed to/under this by a −time tap. */
export const MIN_REMAINING_SEC = 60;

/**
 * #66 — the setup screen's duration chips (a Pomodoro-ish ladder). Deliberately
 * four: one tap, no free-type field to second-guess.
 *
 * #138 — was 5/10/15/25. From production use: 25m was the LARGEST offer, which
 * is shorter than a lot of real sessions, so anything longer had to be reached
 * by repeatedly tapping the in-timer +5. The ladder now spans the range people
 * actually pick, and the in-timer ±5 goes back to being a nudge rather than the
 * only way to express an hour.
 *
 * The same four minutes are the "keep going for" offers on the time-up screen
 * (#138): the question there — "how much longer?" — has the same useful answers
 * as "how long to start?", and two ladders that agree are one thing to learn.
 */
export const DURATION_PRESET_MIN = [15, 30, 45, 60] as const;

/**
 * The duration to fall back on when an estimate is unusable.
 *
 * #138 — this used to be the positional `DURATION_PRESET_MIN[1]`, which the new
 * ladder would have silently changed from 10m to 30m. Having no usable estimate
 * is the weakest possible reason to commit someone to half an hour, so it is the
 * *shortest* offer.
 *
 * Derived with `Math.min` rather than `DURATION_PRESET_MIN[0]` (Duo review):
 * index 0 is only the smallest while the array happens to stay sorted, so the
 * positional form leaves a reordered ladder to be caught by a test after the
 * fact. This way the definition IS the invariant.
 */
export const DEFAULT_DURATION_MIN = Math.min(...DURATION_PRESET_MIN);

/**
 * #66 — the whole-minute duration a raw estimate means. Nothing in the schema
 * bounds Step.estMinutes / FocusSession.plannedMin to >= 1 (they're plain Ints,
 * no CHECK), so a 0/negative row is possible; NaN only via a bad caller. The
 * setup screen seeds its plannedMin through this AND builds its chips from it,
 * so the seeded value is always one of the chips on offer — otherwise a 0m
 * estimate would preselect nothing and Start would open a 0-minute session.
 */
export function normalizeEstMin(estMin: number): number {
  if (!Number.isFinite(estMin)) return DEFAULT_DURATION_MIN;
  return Math.max(1, Math.round(estMin));
}

/**
 * The duration chips to offer for a step estimated at `estMin`: the presets,
 * plus a chip for the estimate itself when it isn't one of them — otherwise a
 * 7m step would show a ring reading 7m with no chip able to express it, and a
 * user who tapped 15m could never get back. Ascending, whole minutes, floored
 * at 1m so bad/legacy data (0, negative, fractional) can't produce a 0m chip.
 */
export function durationChoices(estMin: number): number[] {
  const choices = new Set<number>(DURATION_PRESET_MIN);
  if (Number.isFinite(estMin)) choices.add(normalizeEstMin(estMin));
  return [...choices].sort((a, b) => a - b);
}

/** Format whole seconds as `m:ss` (seconds zero-padded); negatives floor to 0:00. */
export function mmss(totalSec: number): string {
  const s = Math.max(0, Math.floor(totalSec));
  const m = Math.floor(s / 60);
  const sec = s % 60;
  return `${m}:${sec.toString().padStart(2, "0")}`;
}

/**
 * Apply a signed time delta (seconds) to the clock. `totalSec` and
 * `remainingSec` always move by the SAME amount, so elapsed time (total −
 * remaining) is preserved whatever the delta.
 *
 * - Positive: both grow by exactly `deltaSec`.
 * - Negative: both shrink, but a removal can only consume the time sitting
 *   ABOVE `MIN_REMAINING_SEC` — so remaining lands at the floor at worst and a
 *   −time tap can't push the timer to time-up. Ask to remove more than that and
 *   the surplus is dropped, not applied.
 * - Negative at or below the floor: nothing is available to remove, so the
 *   clock is returned unchanged.
 *
 * #151 — that last case used to be the bug, and the reason this comment is
 * written as three cases rather than one sentence about a clamp. The old
 * implementation clamped remaining with `Math.max(MIN_REMAINING_SEC, …)` and
 * then credited whatever the clamp moved to `totalSec`. Below the floor the
 * clamp LIFTS remaining, so the credit was positive and a *subtraction* grew
 * the clock: {600, 30} with −5m returned {630, 60}, the exact opposite of what
 * the comment here used to promise. The same lift also over-applied positive
 * deltas below the floor ({600, 30} +10s returned {630, 60}, not {610, 40}).
 *
 * Capping the removal instead of clamping the result fixes both, because the
 * floor is expressed as a limit on what may be *removed* rather than as a
 * target the result is dragged to. Both of the options weighed in #151 — "no-op
 * below the floor" and Duo's `Math.max(0, …)` cap — collapse to this same
 * arithmetic: the cap is zero exactly when remaining is already at or under the
 * floor, which IS the no-op.
 *
 * Unreachable from the UI either way — `atFloor` in `focus-timer.tsx` disables
 * the only control that sends a negative delta — but this is exported, so it
 * has to be right on its own terms rather than because a caller happens to
 * guard it.
 */
export function applyTimeDelta(
  clock: { totalSec: number; remainingSec: number },
  deltaSec: number,
): { totalSec: number; remainingSec: number } {
  // A NaN/Infinity delta would otherwise propagate into both fields and blank
  // the rendered clock, with no clue where it came from. Same "unusable input
  // means no change" fallback as normalizeEstMin above.
  if (!Number.isFinite(deltaSec)) {
    return { totalSec: clock.totalSec, remainingSec: clock.remainingSec };
  }
  // How much of `remainingSec` a removal is allowed to eat. Clamped at 0 so a
  // clock already under the floor yields no room rather than negative room.
  const removableSec = Math.max(0, clock.remainingSec - MIN_REMAINING_SEC);
  const appliedSec =
    deltaSec >= 0 ? deltaSec : -Math.min(-deltaSec, removableSec);
  return {
    totalSec: clock.totalSec + appliedSec,
    remainingSec: clock.remainingSec + appliedSec,
  };
}

/** Signed net minutes added vs the planned duration (drives the "±Xm" note). */
export function netAddedMin(totalSec: number, plannedSec: number): number {
  return Math.round((totalSec - plannedSec) / 60);
}

/** Depletion fraction remaining/total in [0,1]; 0 when total is 0. */
export function timerFraction(remainingSec: number, totalSec: number): number {
  return totalSec > 0 ? remainingSec / totalSec : 0;
}

/**
 * #27 — true pause/resume. The persisted clock for a `FocusSession`: `pausedAt`
 * (ms epoch) is set while the session is paused, null while running/never
 * paused; `accumulatedPausedMs` is the running total of every prior pause
 * interval's duration. Mirrors `prisma/schema.prisma`'s `FocusSession` fields
 * 1:1 so callers can pass a row straight through (after `.getTime()`).
 */
export type PausedSessionClock = {
  plannedMin: number;
  startedAt: number;
  pausedAt: number | null;
  accumulatedPausedMs: number;
};

/**
 * Remaining seconds for a session's clock as of `nowMs`. While paused, the
 * clock is frozen at the pause instant (elapsed time is measured up to
 * `pausedAt`, not the live `nowMs`) — a session sitting paused for hours or
 * days doesn't silently drain in the background. On resume,
 * `accumulatedPausedMs` grows by the pause's duration and `pausedAt` clears,
 * so the very next call with the same `nowMs` returns the same remaining
 * value the user saw right before resuming — the countdown then continues
 * from there. Supports any number of pause/resume cycles (accumulatedPausedMs
 * simply keeps summing). Floors at 0, never negative.
 */
export function remainingSecForSession(
  clock: PausedSessionClock,
  nowMs: number,
): number {
  const effectiveNow = clock.pausedAt ?? nowMs;
  const elapsedMs = effectiveNow - clock.startedAt - clock.accumulatedPausedMs;
  const plannedSec = clock.plannedMin * 60;
  return Math.max(0, plannedSec - Math.floor(elapsedMs / 1000));
}

/** A step's open (`endedAt: null`) FocusSession, as read straight off Prisma —
 * paused or actively running. Mirrors `PausedSessionClock` but with real
 * `Date`s, so server-component pages can pass a fetched row through without
 * hand-converting each field at every call site. */
export type OpenFocusSessionRow = {
  startedAt: Date;
  pausedAt: Date | null;
  accumulatedPausedMs: number;
  plannedMin: number;
};

/**
 * Remaining seconds of a step's open FocusSession as of `nowMs` — a
 * server-rendered SNAPSHOT (no live ticking; the caller re-renders to refresh
 * it, e.g. on the next page load). `null` in, `null` out: a step with no open
 * session has no "remaining" to report. For a currently-PAUSED session this
 * is frozen at the pause instant (`remainingSecForSession`'s behavior); for
 * an actively-RUNNING one (pausedAt null — e.g. left open on another device),
 * it's simply "what the remaining time is right now" — the sensible
 * snapshot-at-render answer, same formula either way.
 */
export function openSessionRemainingSec(
  session: OpenFocusSessionRow | null | undefined,
  nowMs: number,
): number | null {
  if (!session) return null;
  return remainingSecForSession(
    {
      plannedMin: session.plannedMin,
      startedAt: session.startedAt.getTime(),
      pausedAt: session.pausedAt ? session.pausedAt.getTime() : null,
      accumulatedPausedMs: session.accumulatedPausedMs,
    },
    nowMs,
  );
}
