"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import { getAnthropic, BREAKDOWN_MODEL } from "@/lib/anthropic";
import { getValidAccessToken, patchGoogleTask } from "@/lib/google";
import { FocusOutcome, RewardType, BadgeKey, isGuestWorkspace } from "@/lib/constants";
import { logReward, touchStreakOnCompletion, awardBadge } from "@/lib/rewards";
import { currentWorkspaceId } from "@/lib/workspace";

/** Start a focus session on a step. Returns the session id. */
export async function beginFocus(
  stepId: string,
  plannedMin: number,
): Promise<string | null> {
  const workspaceId = await currentWorkspaceId();
  const step = await prisma.step.findFirst({ where: { id: stepId, task: { workspaceId } } });
  if (!step) return null;
  const session = await prisma.focusSession.create({
    data: {
      stepId: step.id,
      taskId: step.taskId,
      plannedMin: Math.max(1, Math.round(plannedMin)),
      workspaceId,
    },
  });
  return session.id;
}

async function closeSession(
  sessionId: string,
  workspaceId: string,
  outcome: string,
  durationMin: number,
  addedMin: number,
) {
  return prisma.focusSession.update({
    where: { id: sessionId },
    data: {
      endedAt: new Date(),
      durationMin: Math.max(0, Math.round(durationMin)),
      addedMin: Math.max(0, Math.round(addedMin)),
      outcome,
    },
    include: { step: true },
  });
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

export type CompleteResult = {
  ok: boolean;
  nextStepId: string | null;
  points: number;
  reclaimSynced: boolean;
  streak: number | null;
  freshStart: boolean;
};

/** Finish a session as completed: mark the step done, sync Reclaim, log rewards. */
export async function completeFocus(
  sessionId: string,
  opts: { durationMin: number; addedMin: number },
): Promise<CompleteResult> {
  const workspaceId = await currentWorkspaceId();
  // Verify session ownership before closing
  const sessionCheck = await prisma.focusSession.findFirst({ where: { id: sessionId, workspaceId } });
  if (!sessionCheck) {
    return {
      ok: false,
      nextStepId: null,
      points: 0,
      reclaimSynced: false,
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
      reclaimSynced: false,
      streak: null,
      freshStart: false,
    };

  const reclaimSynced = await completeGoogleTaskForStep(step);

  // Guard step ownership before update
  const stepCheck = await prisma.step.findFirst({ where: { id: step.id, task: { workspaceId } } });
  if (stepCheck) {
    await prisma.step.update({ where: { id: step.id }, data: { done: true } });
  }

  await prisma.focusSession.update({
    where: { id: sessionId },
    data: { reclaimSynced },
  });

  // Points + streak + badges (dashboard reads these in step 8).
  await logReward(workspaceId, RewardType.StepDone);
  await logReward(workspaceId, RewardType.SessionFinished);
  const streak = await touchStreakOnCompletion(workspaceId);

  const dayStart = new Date();
  dayStart.setHours(0, 0, 0, 0);
  const stepsToday = await prisma.rewardEvent.count({
    where: { workspaceId, type: RewardType.StepDone, createdAt: { gte: dayStart } },
  });
  if (stepsToday >= 10) await awardBadge(workspaceId, BadgeKey.TenStepsDay);

  const next = await prisma.step.findFirst({
    where: { taskId: step.taskId, done: false, order: { gt: step.order }, task: { workspaceId } },
    orderBy: { order: "asc" },
  });

  revalidatePath(`/tasks/${step.taskId}`);
  revalidatePath("/dashboard");
  return {
    ok: true,
    nextStepId: next?.id ?? null,
    points: 15,
    reclaimSynced,
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
  const sessionCheck = await prisma.focusSession.findFirst({ where: { id: sessionId, workspaceId } });
  if (!sessionCheck) return { ok: false };
  await closeSession(sessionId, workspaceId, FocusOutcome.GaveUp, opts.durationMin, opts.addedMin);
  return { ok: true };
}

/** Finish as "not yet": requeue the step with a new estimate. */
export async function requeueFocus(
  sessionId: string,
  opts: { durationMin: number; addedMin: number; newEstMinutes: number },
) {
  const workspaceId = await currentWorkspaceId();
  const sessionCheck = await prisma.focusSession.findFirst({ where: { id: sessionId, workspaceId } });
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
  const stepCheck = await prisma.step.findFirst({ where: { id: step.id, task: { workspaceId } } });
  if (!stepCheck) return { ok: false };

  const history: number[] = step.estimateHistory
    ? (JSON.parse(step.estimateHistory) as number[])
    : [];
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
      const task = await prisma.task.findFirst({ where: { id: step.taskId, workspaceId } });
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
  const step = await prisma.step.findFirst({ where: { id: stepId, task: { workspaceId } } });
  if (!step) return 15;
  if (isGuestWorkspace(workspaceId)) return step.estMinutes + 10;
  try {
    const anthropic = getAnthropic();
    const resp = await anthropic.messages.create({
      model: BREAKDOWN_MODEL,
      max_tokens: 200,
      output_config: { effort: "low" },
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
    const text = resp.content
      .filter((b) => b.type === "text")
      .map((b) => (b.type === "text" ? b.text : ""))
      .join("");
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
