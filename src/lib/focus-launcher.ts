// Pure focus-launcher selection — no React, no DOM, no DB — so it is
// unit-testable in a plain node env. Given this workspace's tasks (with steps),
// it derives ONE focusable entry per in-progress task: the task's next
// incomplete step. The /focus launcher page renders these and links each into
// the existing /focus/[stepId] timer.

/** A step as loaded by the focus page's Prisma query. `resumable` = the step
 * has an unfinished FocusSession (started, never ended) — the "paused" state,
 * mirroring the inbox's per-step `resumable` mapping. */
export type FocusStep = {
  id: string;
  order: number;
  text: string;
  done: boolean;
  estMinutes: number;
  subtaskEmoji: string | null;
  resumable: boolean;
};

export type FocusTask = {
  id: string;
  title: string;
  /** Task recency key (no `updatedAt` on Task; createdAt is the only clock). */
  createdAt: Date | string;
  steps: FocusStep[];
};

/** One row on the /focus launcher — the next incomplete step of an in-progress
 * task, flattened for rendering + linking to /focus/[stepId]. */
export type FocusableStep = {
  stepId: string;
  stepText: string;
  subtaskEmoji: string | null;
  estMinutes: number;
  taskId: string;
  taskTitle: string;
  /** The next incomplete step is paused (has an open FocusSession). Drives the
   * "paused" badge AND the resumable-first ordering. */
  resumable: boolean;
};

const toMs = (d: Date | string): number =>
  (typeof d === "string" ? new Date(d) : d).getTime();

/**
 * Derive the launcher's focusable steps from a workspace's tasks.
 *
 * - One entry per task = its **next incomplete step** (first not-done by
 *   `order`). Tasks with no incomplete step (fully done / no steps) are omitted.
 * - Ordering: **resumable (paused) first**, then by **task recency** (newest
 *   `createdAt` first) — matching the design spec.
 */
export function focusableSteps(tasks: FocusTask[]): FocusableStep[] {
  const entries = tasks
    .map((task) => {
      const next = [...task.steps]
        .sort((a, b) => a.order - b.order)
        .find((s) => !s.done);
      if (!next) return null;
      const entry: FocusableStep = {
        stepId: next.id,
        stepText: next.text,
        subtaskEmoji: next.subtaskEmoji,
        estMinutes: next.estMinutes,
        taskId: task.id,
        taskTitle: task.title,
        resumable: next.resumable,
      };
      return { entry, createdAt: toMs(task.createdAt) };
    })
    .filter((e): e is { entry: FocusableStep; createdAt: number } => e !== null);

  entries.sort((a, b) => {
    // Resumable (paused) first.
    if (a.entry.resumable !== b.entry.resumable) return a.entry.resumable ? -1 : 1;
    // Then newest task first.
    return b.createdAt - a.createdAt;
  });

  return entries.map((e) => e.entry);
}
