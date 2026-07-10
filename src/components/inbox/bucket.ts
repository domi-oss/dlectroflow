// Pure inbox bucketing — no React, no DOM — so it is unit-testable in a plain
// node env. The InboxView IA (Task 7) renders these buckets in order:
//   Needs review → To do (Single-task + Multi-step) → Saved for later.

import { BrainDumpStatus, TaskStatus } from "@/lib/constants";

export type Item = {
  id: string;
  text: string;
  createdAt: Date;
  status: string;
  triagedAt: Date | null;
  remindedAt: Date | null;
  snoozedUntil: Date | null;
  taskId: string | null;
  freshenedAt: Date | null;
  promptDismissedAt: Date | null;
  stepsTotal: number;
  stepsDone: number;
  taskStatus: string | null;
};

export type Buckets = {
  /** Unsorted inbox items NOT saved-for-later. Freshest / newest first. */
  needsReview: Item[];
  /** Triaged to-dos with no breakdown steps (0 steps). */
  singleTask: Item[];
  /** Triaged to-dos with steps that are not yet fully done. */
  multiStep: Item[];
  /** Inbox items snoozed into the future. Freshness is PAUSED here. */
  savedLater: Item[];
};

const toMs = (d: Date | string): number =>
  (typeof d === "string" ? new Date(d) : d).getTime();

/**
 * Freshness clock for Needs-review sorting: newest of createdAt / freshenedAt.
 * Mirrors `freshnessAgeMs` in aging.ts (age = now − max(createdAt, freshenedAt))
 * so a freshened item both shows a "recent" pill AND sorts to the top.
 */
const freshnessKey = (i: Item): number =>
  i.freshenedAt ? Math.max(toMs(i.createdAt), toMs(i.freshenedAt)) : toMs(i.createdAt);

/** Design decision 3: a to-do is fully done when the task is done OR every step is done. */
function isFullyDone(i: Item): boolean {
  return (
    i.taskStatus === TaskStatus.Done ||
    (i.stepsTotal > 0 && i.stepsDone === i.stepsTotal)
  );
}

export function bucketItems(items: Item[], now: number = Date.now()): Buckets {
  const isInbox = (i: Item) => i.status === BrainDumpStatus.Inbox;
  const isSavedForLater = (i: Item) =>
    i.snoozedUntil != null && toMs(i.snoozedUntil) > now;

  const needsReview = items
    .filter((i) => isInbox(i) && !isSavedForLater(i))
    // Freshest first — freshenedAt resets the clock, so a freshened item
    // outranks an item captured more recently.
    .sort((a, b) => freshnessKey(b) - freshnessKey(a));

  const savedLater = items.filter((i) => isInbox(i) && isSavedForLater(i));

  const triaged = items.filter(
    (i) => i.status === BrainDumpStatus.Triaged && !isFullyDone(i),
  );
  const singleTask = triaged.filter((i) => i.stepsTotal === 0);
  const multiStep = triaged.filter((i) => i.stepsTotal > 0);

  return { needsReview, singleTask, multiStep, savedLater };
}
