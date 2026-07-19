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
  /** ms of the open FocusSession's startedAt; null when not resumable. Orders the resume hero. */
  resumeAt: number | null;
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
  /** Carried from the next incomplete step's open session; null when not paused. */
  resumeAt: number | null;
  /** 1-based position of this (next-incomplete) step among the task's ordered steps. */
  stepIndex: number;
  stepsDone: number;
  stepsTotal: number;
  /** The step AFTER this one (hero "next → …" peek); null when this is the last step. */
  nextStepText: string | null;
  nextStepEmoji: string | null;
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
      const sorted = [...task.steps].sort((a, b) => a.order - b.order);
      const nextPos = sorted.findIndex((s) => !s.done);
      if (nextPos === -1) return null;
      const next = sorted[nextPos];
      const peek = sorted[nextPos + 1] ?? null;
      const entry: FocusableStep = {
        stepId: next.id,
        stepText: next.text,
        subtaskEmoji: next.subtaskEmoji,
        estMinutes: next.estMinutes,
        taskId: task.id,
        taskTitle: task.title,
        resumable: next.resumable,
        resumeAt: next.resumeAt,
        stepIndex: nextPos + 1,
        stepsDone: sorted.filter((s) => s.done).length,
        stepsTotal: sorted.length,
        nextStepText: peek ? peek.text : null,
        nextStepEmoji: peek ? peek.subtaskEmoji : null,
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
