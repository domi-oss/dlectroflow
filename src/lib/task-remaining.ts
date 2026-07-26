// #27 follow-up — "effective remaining" work per step, and the task total
// that's the sum of it. Pure, no React/DOM/Prisma — pages compute each
// step's `openRemainingSec` once at render time (via
// `openSessionRemainingSec` in focus-timer-clock.ts) and feed the plain
// numbers in here, so this stays trivially unit-testable and reusable across
// every list surface (Inbox rows, Library rows, the Focus launcher's resume
// hero) without duplicating the "done / in-progress / not-started" logic.
//
// Lists render this as a SNAPSHOT taken at render time — no live ticking.
// The live countdown stays exclusive to the focus page itself.

import type { Item } from "@/components/inbox/bucket";

export type StepRemainingInput = {
  done: boolean;
  estMinutes: number;
  /** Remaining seconds of this step's open FocusSession as of render time
   * (see `openSessionRemainingSec`); null/undefined when it has none. */
  openRemainingSec?: number | null;
};

/**
 * A single step's EFFECTIVE remaining time, in minutes:
 *   - 0 once the step is done — no work left, regardless of estimate or any
 *     (stale) open session;
 *   - the open session's persisted remaining, rounded to minutes, when the
 *     step has one (paused OR actively running elsewhere) — this is what
 *     makes progress on a mid-flight step shrink the total, not just a full
 *     completion;
 *   - the step's full estimate otherwise (not started).
 */
export function effectiveRemainingMin(step: StepRemainingInput): number {
  if (step.done) return 0;
  if (step.openRemainingSec != null) {
    return Math.max(0, Math.round(step.openRemainingSec / 60));
  }
  return Math.max(0, step.estMinutes);
}

/** Task total = remaining work: Σ effective-remaining across its steps. It
 * shrinks as steps are paused mid-way or completed, rather than only ever
 * reflecting the original full estimate. */
export function taskRemainingMin(steps: StepRemainingInput[]): number {
  return steps.reduce((n, s) => n + effectiveRemainingMin(s), 0);
}

/** Convenience over an Item's steps — the shape Inbox/Library rows share. */
export function itemRemainingMin(item: Pick<Item, "steps">): number {
  return taskRemainingMin(item.steps);
}

/**
 * The remaining minutes of the ONE not-done step with an open FocusSession
 * (paused or actively running), or null when nothing is in progress. At most
 * one step should ever have an open session at a time (enforced server-side —
 * see `beginFocus`'s stale-session cleanup, !139); a done step's own
 * (necessarily stale) session is never reported as active.
 */
export function activeStepRemainingMin(
  item: Pick<Item, "steps">,
): number | null {
  const active = item.steps.find((s) => !s.done && s.openRemainingSec != null);
  return active ? Math.max(0, Math.round(active.openRemainingSec! / 60)) : null;
}
