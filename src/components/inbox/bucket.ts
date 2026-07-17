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
  /** Moved into Multi-step before having steps — shows a "Break into steps
   * now?" call-to-action there. Cleared by any move to another bucket. */
  breakdownRequestedAt: Date | null;
  stepsTotal: number;
  stepsDone: number;
  taskStatus: string | null;
  completedAt: Date | null;
  /** Set on the first schedule via any method (ICS or Google) — drives the
   *  "Scheduled ✓" row indicator. */
  scheduledAt: Date | null;
  steps: { id: string; order: number; text: string; done: boolean; estMinutes: number; subtaskEmoji: string | null; resumable: boolean }[];
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
  /** Completed items sorted by completedAt DESC, capped at 10. */
  completed: Item[];
  /** Count of items completed since local midnight. */
  completedTodayCount: number;
};

export const BUCKET_IDS = [
  "needsReview",
  "singleTask",
  "multiStep",
  "savedLater",
  "completed",
] as const;

export type BucketId = (typeof BUCKET_IDS)[number];

export function isBucketId(id: string): id is BucketId {
  return (BUCKET_IDS as readonly string[]).includes(id);
}

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

const isCompleted = (i: Item) => i.completedAt != null;

function startOfDayMs(now: number): number {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

export function bucketItems(items: Item[], now: number = Date.now()): Buckets {
  const isInbox = (i: Item) => i.status === BrainDumpStatus.Inbox;
  const isSavedForLater = (i: Item) =>
    i.snoozedUntil != null && toMs(i.snoozedUntil) > now;

  const needsReview = items
    .filter((i) => isInbox(i) && !isSavedForLater(i) && !isCompleted(i))
    // Freshest first — freshenedAt resets the clock, so a freshened item
    // outranks an item captured more recently.
    .sort((a, b) => freshnessKey(b) - freshnessKey(a));

  const savedLater = items.filter((i) => isInbox(i) && isSavedForLater(i) && !isCompleted(i));

  const triaged = items.filter(
    (i) => i.status === BrainDumpStatus.Triaged && !isFullyDone(i) && !isCompleted(i),
  );
  // A one-step task IS a single to-do (its step exists so ▶ Focus has a
  // target); only 2+ steps make it multi-step.
  const awaitsBreakdown = (i: Item) => i.stepsTotal === 0 && i.breakdownRequestedAt != null;
  const singleTask = triaged.filter((i) => i.stepsTotal <= 1 && !awaitsBreakdown(i));
  const multiStep = triaged.filter((i) => i.stepsTotal > 1 || awaitsBreakdown(i));

  const completedAll = items
    .filter(isCompleted)
    .sort((a, b) => toMs(b.completedAt!) - toMs(a.completedAt!));
  const completed = completedAll.slice(0, 10);
  const dayStart = startOfDayMs(now);
  const completedTodayCount = completedAll.filter((i) => toMs(i.completedAt!) >= dayStart).length;

  return { needsReview, singleTask, multiStep, savedLater, completed, completedTodayCount };
}

/**
 * Which bucket a single item currently lives in — mirrors bucketItems'
 * membership rules. Used by the drag/menu dispatcher to detect same-bucket
 * no-ops and completed-source reopen-first.
 */
export function bucketOfItem(i: Item, now: number = Date.now()): BucketId {
  if (isCompleted(i)) return "completed";
  if (i.status === BrainDumpStatus.Inbox) {
    return i.snoozedUntil != null && toMs(i.snoozedUntil) > now ? "savedLater" : "needsReview";
  }
  if (i.status === BrainDumpStatus.Triaged && !isFullyDone(i)) {
    const awaitsBreakdown = i.stepsTotal === 0 && i.breakdownRequestedAt != null;
    return i.stepsTotal > 1 || awaitsBreakdown ? "multiStep" : "singleTask";
  }
  // Fully-done-but-not-stamped or any other state: treat as review (safe default).
  return "needsReview";
}
