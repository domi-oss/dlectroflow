// #142 — the default "what comes next" order for the focus queue.
//
// Pure module — no React, no DOM, no Prisma — so it is unit-testable in a plain
// node env, like `focus-launcher.ts` and `bucket.ts` next to it. The caller
// loads the candidates and maps them onto {@link FocusOrdered}; this decides
// which one is next.
//
// **Soonest due, then soonest scheduled**, and deliberately nothing else. Two
// omissions are the point:
//
//  1. There is **no tiebreak of its own**. `Array.prototype.sort` is stable, so
//     rows this comparator cannot separate keep the order the caller loaded them
//     in. Inventing a third key here would quietly contradict whatever order the
//     /focus launcher is already displaying, and the surface that owns that
//     order is #143 — Drag-to-reorder /focus as a manual override.
//  2. It **never writes anything**. A reorder — automatic or manual — is a
//     reading of the queue, not an edit of it. Steps sync to Google Tasks and
//     Reclaim reschedules from there, so a sort that wrote times back would push
//     changes into Google and contend with Reclaim for ownership of the
//     calendar. It would also destroy the one thing worth expressing: "do this
//     next, but it is still due Friday".

/** The two clocks the default order reads, plus nothing. */
export type FocusOrdered = {
  /** When the work is DUE. `Task.scheduleDueAt` — what the owner asked for. */
  dueAt: Date | string | null;
  /** When it is booked in. `Task.scheduledAt` — what the calendar says. */
  scheduledAt: Date | string | null;
};

/**
 * Milliseconds, or `null` for "no usable date".
 *
 * An unparseable string collapses to `null` rather than `NaN`: every comparison
 * against NaN is false, so a subtraction-based comparator scatters junk data
 * unpredictably and can float it to the head of the queue. "I could not read
 * this date" and "there is no date" want the same answer — sort last.
 */
function timeOf(value: Date | string | null | undefined): number | null {
  if (value == null) return null;
  const ms = (typeof value === "string" ? new Date(value) : value).getTime();
  return Number.isFinite(ms) ? ms : null;
}

/** Ascending, with "no date" always after every date. */
function compareNullableTime(
  a: Date | string | null,
  b: Date | string | null,
): number {
  const x = timeOf(a);
  const y = timeOf(b);
  if (x === y) return 0;
  // Undated is not "due now" — it is "no claim on when", which loses to
  // anything that does make one.
  if (x === null) return 1;
  if (y === null) return -1;
  return x - y;
}

/** Comparator for `Array.prototype.sort`: soonest due, then soonest scheduled. */
export function compareFocusOrder(a: FocusOrdered, b: FocusOrdered): number {
  const byDue = compareNullableTime(a.dueAt, b.dueAt);
  if (byDue !== 0) return byDue;
  return compareNullableTime(a.scheduledAt, b.scheduledAt);
}

/**
 * The head of the effective order, or `null` when the queue is empty — which
 * callers must handle, because "nothing left" is a real state in this flow and
 * not an error.
 *
 * Copies before sorting: the caller's array is frequently the list it is also
 * rendering.
 */
export function nextInFocusOrder<T extends FocusOrdered>(
  candidates: readonly T[],
): T | null {
  if (candidates.length === 0) return null;
  return [...candidates].sort(compareFocusOrder)[0] ?? null;
}

/**
 * #142 — what the finished-step screen offers, as one exhaustive decision.
 *
 * Kept out of the component and out of JSX because it is seven branches over
 * four inputs, and a chain of `&&`s in a render is where "you finished, and
 * that's all we have to say" comes back. The component renders an ending; it
 * does not work out which one.
 */
export type FocusEnding =
  /** More steps in this task — the countdown, ungated. */
  | { kind: "advance-step" }
  /** A single-task to-do finished with hyper focus mode on — chain, countdown. */
  | { kind: "advance-single" }
  /** A whole task finished, another multi-step task is waiting — offer it. */
  | { kind: "offer-task" }
  /** A whole task finished, hyper focus already on — offer the next to-do. */
  | { kind: "offer-single" }
  /** The multi-step queue is empty and to-dos remain — offer the mode. */
  | { kind: "offer-hyper" }
  /** A single-task to-do finished with the mode off — back to /focus. */
  | { kind: "back-to-focus" }
  /** Nothing at all — the dashboard, where the day's evidence is. */
  | { kind: "nothing-left" };

export function chooseEnding(input: {
  /** Another incomplete step exists in the task just worked on. */
  hasNextStep: boolean;
  /** What the rest of the queue has, in effective order — see nextInFocusOrder. */
  nextUpKind: "step" | "single" | null;
  /** The thing just finished was a single-task to-do, not one step of a task. */
  isSingleTask: boolean;
  hyperFocus: boolean;
}): FocusEnding {
  const { hasNextStep, nextUpKind, isSingleTask, hyperFocus } = input;

  // Inside a task, the sequence is what you already agreed to when you broke it
  // down. Deliberately NOT gated behind hyper focus mode, which governs
  // single-task chaining only.
  if (hasNextStep) return { kind: "advance-step" };

  if (nextUpKind === null) return { kind: "nothing-left" };

  if (isSingleTask) {
    // The mode's entire job, and its entire scope.
    if (nextUpKind === "single" && hyperFocus)
      return { kind: "advance-single" };
    // A single-task to-do finished while a multi-step task is waiting: offer it
    // rather than dropping the user on the launcher to find it themselves.
    if (nextUpKind === "step") return { kind: "offer-task" };
    return { kind: "back-to-focus" };
  }

  // A WHOLE multi-step task just finished. Nothing here auto-advances, whatever
  // the mode says: that finish is a bigger deal than finishing a step and
  // deserves a real pause — it simply must not be a dead end.
  if (nextUpKind === "step") return { kind: "offer-task" };
  return hyperFocus ? { kind: "offer-single" } : { kind: "offer-hyper" };
}
