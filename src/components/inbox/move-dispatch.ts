// Pure drop/move dispatch — no React, no server actions — so drag and the
// "Move to…" menu can share one non-invertible mapping (mirrors the !28
// More/Fewer regression lesson). The destination bucket defines the outcome.

import type { BucketId } from "./bucket";

export type BucketAction =
  | "moveToReview"
  | "triage"
  | "requestBreakdown"
  | "snooze"
  | "complete";

/** Destination bucket → the action its drop performs. */
export const ACTION_FOR_BUCKET: Record<BucketId, BucketAction> = {
  needsReview: "moveToReview",
  singleTask: "triage",
  multiStep: "requestBreakdown",
  savedLater: "snooze",
  completed: "complete",
};

export type DropPlan =
  | { kind: "noop" }
  | { kind: "apply"; target: BucketId; action: BucketAction; reopenFirst: boolean };

/**
 * Resolve a source→target move into a plan.
 * - same bucket → noop (Phase B does not reorder within a bucket)
 * - completed source → reopen the item first, then apply the target action
 * - multiStep target → moves immediately; the item sits in Multi-step with a
 *   "Break into steps now?" call-to-action (requestBreakdown) instead of a
 *   blocking prompt. Undo = drag it back out.
 */
export function dropPlan(source: BucketId, target: BucketId): DropPlan {
  if (source === target) return { kind: "noop" };
  return {
    kind: "apply",
    target,
    action: ACTION_FOR_BUCKET[target],
    reopenFirst: source === "completed",
  };
}
