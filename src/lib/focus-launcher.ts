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

/** A single-task to-do row on the launcher — a BrainDumpItem, focus-launched via
 * ensureFocusStep(itemId). No step/session fields: the resume hero is drawn from
 * multi-step tasks only (see plan Task 2 decision). */
export type SingleFocusable = {
  itemId: string;
  text: string;
  estMinutes: number;
};

/** Everything the /focus launcher renders, derived purely (no React/DB). */
export type LauncherData = {
  /** Most-recently-active paused multi-step step, or null. */
  resumeHero: FocusableStep | null;
  singleTasks: SingleFocusable[];
  /** Multi-step next steps, hero excluded, resumable-first then newest task. */
  multiStep: FocusableStep[];
  meta: { minutesToClear: number };
};

/**
 * Derive the launcher view-model from the workspace's tasks + its single-task
 * to-dos (already bucketed by the caller). Multi-step lane = next incomplete
 * step of every 2+-step task; the resume hero is the most-recently-active paused
 * one of those, removed from the lane. minutesToClear is a rough "clear
 * everything" figure: Σ of each multi-step next step's estimate (hero included)
 * + Σ of the single-task estimates.
 */
export function focusLauncherData(
  tasks: FocusTask[],
  singleTasks: SingleFocusable[],
): LauncherData {
  const multiFull = focusableSteps(tasks).filter((e) => e.stepsTotal >= 2);

  const resumeHero =
    [...multiFull]
      .filter((e) => e.resumable)
      .sort((a, b) => (b.resumeAt ?? 0) - (a.resumeAt ?? 0))[0] ?? null;

  const multiStep = resumeHero
    ? multiFull.filter((e) => e.stepId !== resumeHero.stepId)
    : multiFull;

  const minutesToClear =
    multiFull.reduce((n, e) => n + e.estMinutes, 0) +
    singleTasks.reduce((n, s) => n + s.estMinutes, 0);

  return { resumeHero, singleTasks, multiStep, meta: { minutesToClear } };
}
