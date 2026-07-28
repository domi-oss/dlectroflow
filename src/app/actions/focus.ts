"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import { getLLM } from "@/lib/llm";
import { resolveUtilityModel } from "@/lib/models";
import { getValidAccessToken, patchGoogleTask } from "@/lib/google";
import {
  BadgeKey,
  FocusOutcome,
  RewardType,
  TaskStatus,
} from "@/lib/constants";
import { isGuestWorkspace } from "@/lib/workspace-kind";
import { awardBadge, logReward, rewardStepDone } from "@/lib/rewards";
import { currentWorkspaceId } from "@/lib/workspace";
import { remainingSecForSession } from "@/lib/focus-timer-clock";

/**
 * Start a focus session on a step. Returns the session id.
 *
 * #27 — resume-aware: any OPEN session already sitting on this step (paused,
 * or just abandoned mid-run by a closed tab) is retired first, as a
 * "gaveup"/abandoned close. Without this, re-entering a step left a *second*
 * (or third…) row permanently open — the setup screen offers a real "Resume"
 * CTA for a truly-paused session (see /focus/[stepId]/page.tsx +
 * `resumeFocus` below); beginFocus is only reached when the user picks
 * "Start fresh" (or there was nothing to resume), so it always means
 * "abandon whatever was open, start clean."
 */
export async function beginFocus(
  stepId: string,
  plannedMin: number,
): Promise<string | null> {
  const workspaceId = await currentWorkspaceId();
  const step = await prisma.step.findFirst({
    where: { id: stepId, task: { workspaceId } },
  });
  if (!step) return null;

  // Retire stale open session(s) before creating a fresh one. Actual elapsed
  // active time for an abandoned-never-paused session isn't known (it was
  // never explicitly paused/stamped), so this is a best-effort 0 — the point
  // is closing the row, not stats precision for a session the user walked
  // away from.
  await prisma.focusSession.updateMany({
    where: { stepId: step.id, workspaceId, endedAt: null },
    data: {
      endedAt: new Date(),
      outcome: FocusOutcome.GaveUp,
      durationMin: 0,
    },
  });

  const session = await prisma.focusSession.create({
    data: {
      stepId: step.id,
      taskId: step.taskId,
      plannedMin: Math.max(1, Math.round(plannedMin)),
      workspaceId,
    },
  });
  // First focus — awarded the first time a focus session begins (idempotent).
  await awardBadge(workspaceId, BadgeKey.FirstFocus);
  return session.id;
}

/**
 * Pause an in-progress focus session: stamps `pausedAt` and bakes the
 * caller's current adjusted total (`totalSec`, including any ±time taps made
 * before this pause) into `plannedMin`, so a resume — even after a reload or
 * from another device — restores the same total the user was looking at.
 * Idempotent: pausing an already-paused session is a no-op success (guards
 * against a double click / race).
 */
export async function pauseFocus(
  sessionId: string,
  opts: { totalSec: number },
): Promise<{ ok: boolean }> {
  const workspaceId = await currentWorkspaceId();
  const session = await prisma.focusSession.findFirst({
    where: { id: sessionId, workspaceId, endedAt: null },
  });
  if (!session) return { ok: false };
  if (session.pausedAt) return { ok: true };

  await prisma.focusSession.update({
    where: { id: sessionId },
    data: {
      pausedAt: new Date(),
      plannedMin: Math.max(1, Math.round(opts.totalSec / 60)),
    },
  });
  return { ok: true };
}

export type ResumeResult = {
  ok: boolean;
  remainingSec: number;
  totalSec: number;
  plannedMin: number;
};

const FAILED_RESUME: ResumeResult = {
  ok: false,
  remainingSec: 0,
  totalSec: 0,
  plannedMin: 0,
};

/**
 * Resume a paused focus session — REUSES the existing row (no new
 * FocusSession is created; this is the fix for the "double session" bug
 * where re-entering a step silently opened a second one). Folds the just-
 * ended pause interval into `accumulatedPausedMs`, clears `pausedAt`, and
 * returns the remaining time computed at that exact instant (so it matches
 * what the user saw right before pausing, modulo any earlier active time).
 */
export async function resumeFocus(sessionId: string): Promise<ResumeResult> {
  const workspaceId = await currentWorkspaceId();
  const session = await prisma.focusSession.findFirst({
    where: { id: sessionId, workspaceId, endedAt: null },
  });
  if (!session || !session.pausedAt) return FAILED_RESUME;

  const now = new Date();
  const accumulatedPausedMs =
    session.accumulatedPausedMs + (now.getTime() - session.pausedAt.getTime());

  await prisma.focusSession.update({
    where: { id: sessionId },
    data: { pausedAt: null, accumulatedPausedMs },
  });

  const remainingSec = remainingSecForSession(
    {
      plannedMin: session.plannedMin,
      startedAt: session.startedAt.getTime(),
      pausedAt: null,
      accumulatedPausedMs,
    },
    now.getTime(),
  );
  return {
    ok: true,
    remainingSec,
    totalSec: session.plannedMin * 60,
    plannedMin: session.plannedMin,
  };
}

async function closeSession(
  sessionId: string,
  workspaceId: string,
  outcome: string,
  durationMin: number,
  addedMin: number,
) {
  return prisma.focusSession.update({
    // #35 — `workspaceId` is in the FILTER, not just a parameter this helper
    // happens to receive. Every caller verifies ownership first, but a private
    // helper that ignores the scope it was handed is one careless call away
    // from closing somebody else's session (found by the scoping harness).
    where: { id: sessionId, workspaceId },
    data: {
      endedAt: new Date(),
      durationMin: Math.max(0, Math.round(durationMin)),
      addedMin: Math.max(0, Math.round(addedMin)),
      outcome,
    },
    include: { step: true },
  });
}

/** Mark a task and its linked inbox item(s) completed, and award the task-complete reward+badge. */
async function markTaskCompleted(workspaceId: string, taskId: string) {
  await prisma.task.update({
    // Scoped for the same reason as closeSession above: the helper is given a
    // workspaceId, so it must filter on it rather than trust its callers.
    where: { id: taskId, workspaceId },
    data: { status: TaskStatus.Done },
  });
  await prisma.brainDumpItem.updateMany({
    where: { taskId, workspaceId },
    data: { completedAt: new Date() },
  });
  await logReward(workspaceId, RewardType.TaskComplete);
  await awardBadge(workspaceId, BadgeKey.TaskComplete);
}

async function completeGoogleTaskForStep(step: {
  googleTaskId: string | null;
  googleTaskListId: string | null;
}): Promise<boolean> {
  if (!step.googleTaskId || !step.googleTaskListId) return false;
  const token = await getValidAccessToken();
  if (!token) return false;
  return patchGoogleTask(token, step.googleTaskListId, step.googleTaskId, {
    status: "completed",
  });
}

/** Complete a step directly (no focus session). Awards StepDone; finishes the task on the last step. */
export async function completeStep(stepId: string) {
  const workspaceId = await currentWorkspaceId();
  const step = await prisma.step.findFirst({
    where: { id: stepId, task: { workspaceId } },
    include: { task: { include: { steps: true } } },
  });
  if (!step || step.done) return;

  await completeGoogleTaskForStep(step);
  await prisma.step.update({ where: { id: stepId }, data: { done: true } });
  await rewardStepDone(workspaceId);

  const stillOpen = step.task.steps.filter((s) => s.id !== stepId && !s.done);
  if (stillOpen.length === 0) await markTaskCompleted(workspaceId, step.taskId);

  revalidatePath(`/tasks/${step.taskId}`);
  revalidatePath("/");
  revalidatePath("/dashboard");
}

/**
 * Rename a step's text from the TaskSteps inline "Edit step title" editor.
 * Workspace-scoped; trims and ignores empty/unchanged titles.
 */
export async function renameStep(stepId: string, title: string) {
  const workspaceId = await currentWorkspaceId();
  const step = await prisma.step.findFirst({
    where: { id: stepId, task: { workspaceId } },
  });
  if (!step) return;
  const trimmed = title.trim();
  if (!trimmed || trimmed === step.text) return;

  await prisma.step.update({ where: { id: stepId }, data: { text: trimmed } });
  revalidatePath(`/tasks/${step.taskId}`);
  revalidatePath("/");
}

/**
 * Update a step's time estimate from the TaskSteps inline "Edit time estimate"
 * editor. Workspace-scoped; rounds and clamps to 1..480 minutes.
 */
export async function updateStepEstimate(stepId: string, minutes: number) {
  const workspaceId = await currentWorkspaceId();
  const step = await prisma.step.findFirst({
    where: { id: stepId, task: { workspaceId } },
  });
  if (!step) return;
  const estMinutes = Math.min(480, Math.max(1, Math.round(minutes)));

  await prisma.step.update({ where: { id: stepId }, data: { estMinutes } });
  revalidatePath(`/tasks/${step.taskId}`);
  revalidatePath("/");
}

export type CompleteResult = {
  ok: boolean;
  nextStepId: string | null;
  points: number;
  googleSynced: boolean;
  streak: number | null;
  freshStart: boolean;
};

/** Finish a session as completed: mark the step done, complete its linked Google Task, log rewards. */
export async function completeFocus(
  sessionId: string,
  opts: { durationMin: number; addedMin: number },
): Promise<CompleteResult> {
  const workspaceId = await currentWorkspaceId();
  // Verify session ownership before closing
  const sessionCheck = await prisma.focusSession.findFirst({
    where: { id: sessionId, workspaceId },
  });
  if (!sessionCheck) {
    return {
      ok: false,
      nextStepId: null,
      points: 0,
      googleSynced: false,
      streak: null,
      freshStart: false,
    };
  }

  const session = await closeSession(
    sessionId,
    workspaceId,
    FocusOutcome.Completed,
    opts.durationMin,
    opts.addedMin,
  );
  const step = session.step;
  if (!step)
    return {
      ok: false,
      nextStepId: null,
      points: 0,
      googleSynced: false,
      streak: null,
      freshStart: false,
    };

  const googleSynced = await completeGoogleTaskForStep(step);

  // Guard step ownership before update
  const stepCheck = await prisma.step.findFirst({
    where: { id: step.id, task: { workspaceId } },
  });
  if (stepCheck) {
    await prisma.step.update({ where: { id: step.id }, data: { done: true } });
  }

  // Points + streak + badges (dashboard reads these).
  const streak = await rewardStepDone(workspaceId);
  await logReward(workspaceId, RewardType.SessionFinished);

  const next = await prisma.step.findFirst({
    where: {
      taskId: step.taskId,
      done: false,
      order: { gt: step.order },
      task: { workspaceId },
    },
    orderBy: { order: "asc" },
  });

  const openCount = await prisma.step.count({
    where: { taskId: step.taskId, done: false, task: { workspaceId } },
  });
  if (openCount === 0) {
    await markTaskCompleted(workspaceId, step.taskId);
    revalidatePath("/");
  }

  revalidatePath(`/tasks/${step.taskId}`);
  revalidatePath("/dashboard");
  return {
    ok: true,
    nextStepId: next?.id ?? null,
    points: 15,
    googleSynced,
    streak: streak?.current ?? null,
    freshStart: streak?.freshStart ?? false,
  };
}

/** Finish a session as given-up (no guilt, no step change). */
export async function giveUpFocus(
  sessionId: string,
  opts: { durationMin: number; addedMin: number },
) {
  const workspaceId = await currentWorkspaceId();
  const sessionCheck = await prisma.focusSession.findFirst({
    where: { id: sessionId, workspaceId },
  });
  if (!sessionCheck) return { ok: false };
  await closeSession(
    sessionId,
    workspaceId,
    FocusOutcome.GaveUp,
    opts.durationMin,
    opts.addedMin,
  );
  return { ok: true };
}

/** Finish as "not yet": requeue the step with a new estimate. */
export async function requeueFocus(
  sessionId: string,
  opts: { durationMin: number; addedMin: number; newEstMinutes: number },
) {
  const workspaceId = await currentWorkspaceId();
  const sessionCheck = await prisma.focusSession.findFirst({
    where: { id: sessionId, workspaceId },
  });
  if (!sessionCheck) return { ok: false };

  const session = await closeSession(
    sessionId,
    workspaceId,
    FocusOutcome.Requeued,
    opts.durationMin,
    opts.addedMin,
  );
  const step = session.step;
  if (!step) return { ok: false };

  // Guard step ownership before update
  const stepCheck = await prisma.step.findFirst({
    where: { id: step.id, task: { workspaceId } },
  });
  if (!stepCheck) return { ok: false };

  // Guard the stored history: corrupt/malformed JSON (or a non-array value)
  // must not break requeue — fall back to an empty history and carry on (#21 P5.4).
  let history: number[] = [];
  if (step.estimateHistory) {
    try {
      const parsed = JSON.parse(step.estimateHistory);
      if (Array.isArray(parsed)) history = parsed as number[];
    } catch {
      // history stays [] — fall back to empty on corrupt JSON
    }
  }
  history.push(step.estMinutes);
  const newEst = Math.max(1, Math.round(opts.newEstMinutes));

  await prisma.step.update({
    where: { id: step.id },
    data: { estMinutes: newEst, estimateHistory: JSON.stringify(history) },
  });

  // Best-effort: update the Google Task's duration syntax so Reclaim reschedules.
  if (step.googleTaskId && step.googleTaskListId) {
    const token = await getValidAccessToken();
    if (token) {
      const task = await prisma.task.findFirst({
        where: { id: step.taskId, workspaceId },
      });
      const emoji = task?.parentEmoji ? `${task.parentEmoji} ` : "";
      const sub = step.subtaskEmoji ? `${step.subtaskEmoji} ` : "";
      const title = `${emoji}${task?.title ?? ""}: ${step.order} of ${step.total} ${sub}${step.text} (duration:${newEst}m)`;
      await patchGoogleTask(token, step.googleTaskListId, step.googleTaskId, {
        title,
      });
    }
  }

  revalidatePath(`/tasks/${step.taskId}`);
  return { ok: true };
}

/** Ask Claude for a fresh, kinder estimate when a step wasn't finished in time. */
export async function proposeNewEstimate(stepId: string): Promise<number> {
  const workspaceId = await currentWorkspaceId();
  const step = await prisma.step.findFirst({
    where: { id: stepId, task: { workspaceId } },
  });
  if (!step) return 15;
  if (await isGuestWorkspace(workspaceId)) return step.estMinutes + 10;
  try {
    const { text } = await getLLM().generate({
      model: resolveUtilityModel(),
      maxTokens: 200,
      hints: { effort: "low" },
      messages: [
        {
          role: "user",
          content: `A focus step wasn't finished in its estimated time.
Step: "${step.text}"
Original estimate: ${step.estMinutes} minutes.
Suggest a realistic, kind new estimate (a bit more time, not punishing). Reply with ONLY a JSON object: {"minutes": <integer>}.`,
        },
      ],
    });
    const m = text.match(/\{[\s\S]*\}/);
    if (m) {
      const parsed = JSON.parse(m[0]) as { minutes?: number };
      if (typeof parsed.minutes === "number" && parsed.minutes > 0) {
        return Math.round(parsed.minutes);
      }
    }
  } catch {
    // fall through
  }
  return step.estMinutes + 10;
}

/** Live focus stats for today (server-local day). */
export async function focusStatsToday(): Promise<{
  focusMin: number;
  sessions: number;
}> {
  const workspaceId = await currentWorkspaceId();
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const sessions = await prisma.focusSession.findMany({
    where: { workspaceId, startedAt: { gte: start }, endedAt: { not: null } },
    select: { durationMin: true },
  });
  return {
    focusMin: sessions.reduce((n, s) => n + (s.durationMin ?? 0), 0),
    sessions: sessions.length,
  };
}
