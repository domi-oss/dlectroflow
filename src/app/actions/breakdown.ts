"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import {
  BrainDumpStatus,
  TaskSource,
  TaskStatus,
  RewardType,
  BadgeKey,
} from "@/lib/constants";
import { logReward, awardBadge, touchStreakOnEngagement } from "@/lib/rewards";
import type { Proposal } from "@/lib/breakdown";
import { currentWorkspaceId } from "@/lib/workspace";
import { brainDumpItemToTaskData } from "@/lib/braindump-to-task";

/**
 * Launch a breakdown from a brain-dump item: create (or reuse) its Task and
 * triage the item. Returns the task id to navigate to.
 */
export async function startBreakdown(itemId: string): Promise<string | null> {
  const workspaceId = await currentWorkspaceId();
  const item = await prisma.brainDumpItem.findFirst({
    where: { id: itemId, workspaceId },
  });
  if (!item) return null;
  if (item.taskId) return item.taskId;

  // #179 — the ONE conversion, so the note and the schedule intent cross with
  // the item. This path is the one a breakdown reads from, which makes a dropped
  // note here a worse failure than elsewhere: the AI would plan the task without
  // the detail that most often makes the steps sensible.
  const task = await prisma.task.create({
    data: brainDumpItemToTaskData(item, workspaceId),
  });
  await prisma.brainDumpItem.update({
    where: { id: itemId },
    data: {
      status: BrainDumpStatus.Triaged,
      triagedAt: new Date(),
      taskId: task.id,
    },
  });
  revalidatePath("/");
  return task.id;
}

/** Create a standalone task (not from the inbox) and return its id. */
export async function createTask(title: string): Promise<string | null> {
  const workspaceId = await currentWorkspaceId();
  const trimmed = title.trim();
  if (!trimmed) return null;
  const task = await prisma.task.create({
    data: {
      title: trimmed,
      source: TaskSource.Manual,
      status: TaskStatus.Active,
      workspaceId,
    },
  });
  return task.id;
}

/**
 * Eject a persisted step back into the inbox as its own "needs review" item
 * (a bigger task to re-triage), remove it from its task, and renumber the
 * remaining steps so order/total stay contiguous. Workspace-scoped + IDOR-safe
 * (findFirst gated on `task.workspaceId`, so another workspace's step id
 * resolves to null and is a no-op). Returns the task id and how many steps
 * remain (0 ⇒ the task is now empty, which the caller resolves via the re-plan
 * / keep-as-todo chooser).
 */
export async function ejectStepToInbox(
  stepId: string,
): Promise<{ taskId: string; remaining: number } | null> {
  const workspaceId = await currentWorkspaceId();
  const step = await prisma.step.findFirst({
    where: { id: stepId, task: { workspaceId } },
  });
  if (!step) return null;
  const { taskId } = step;

  await prisma.brainDumpItem.create({
    data: { text: step.text, workspaceId, status: BrainDumpStatus.Inbox },
  });
  await prisma.step.delete({ where: { id: stepId } });

  const remaining = await prisma.step.findMany({
    where: { taskId },
    orderBy: { order: "asc" },
  });
  const total = remaining.length;
  if (total > 0) {
    await prisma.$transaction(
      remaining.map((s, i) =>
        prisma.step.update({
          where: { id: s.id },
          data: { order: i + 1, total },
        }),
      ),
    );
  }

  revalidatePath(`/tasks/${taskId}`);
  revalidatePath("/");
  return { taskId, remaining: total };
}

/**
 * Persist a confirmed breakdown: set the parent emoji and replace the task's
 * steps with the proposal. (Scheduling is wired via the Google Tasks / calendar
 * export routes.)
 */
export async function confirmBreakdown(taskId: string, proposal: Proposal) {
  const workspaceId = await currentWorkspaceId();
  const steps = (proposal.steps ?? []).filter((s) => s.text?.trim());
  const total = steps.length;
  if (total === 0) return;

  const existingTask = await prisma.task.findFirst({
    where: { id: taskId, workspaceId },
  });
  if (!existingTask) return;

  await prisma.$transaction([
    prisma.task.update({
      where: { id: taskId },
      data: {
        parentEmoji: proposal.parentEmoji || null,
        status: TaskStatus.Active,
      },
    }),
    prisma.step.deleteMany({ where: { taskId } }),
    prisma.step.createMany({
      data: steps.map((s, i) => ({
        taskId,
        text: s.text.trim(),
        order: i + 1,
        total,
        estMinutes: Math.max(1, Math.round(s.estMinutes || 15)),
        subtaskEmoji: s.subtaskEmoji || null,
      })),
    }),
  ]);

  await logReward(workspaceId, RewardType.BreakdownConfirmed);
  await awardBadge(workspaceId, BadgeKey.FirstBreakdown);
  // A breakdown-confirm is a qualifying engagement (Decision 1) — advances the
  // streak at most once per working day.
  await touchStreakOnEngagement(workspaceId);

  revalidatePath(`/tasks/${taskId}`);
  revalidatePath("/");
}
