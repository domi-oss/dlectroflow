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
import { logReward, awardBadge } from "@/lib/rewards";
import type { Proposal } from "@/lib/breakdown";
import { currentWorkspaceId } from "@/lib/workspace";

/**
 * Launch a breakdown from a brain-dump item: create (or reuse) its Task and
 * triage the item. Returns the task id to navigate to.
 */
export async function startBreakdown(itemId: string): Promise<string | null> {
  const workspaceId = await currentWorkspaceId();
  const item = await prisma.brainDumpItem.findFirst({ where: { id: itemId, workspaceId } });
  if (!item) return null;
  if (item.taskId) return item.taskId;

  const task = await prisma.task.create({
    data: {
      title: item.text,
      source: TaskSource.BrainDump,
      status: TaskStatus.Active,
      workspaceId,
    },
  });
  await prisma.brainDumpItem.update({
    where: { id: itemId },
    data: {
      status: BrainDumpStatus.Triaged,
      triagedAt: new Date(),
      taskId: task.id,
    },
  });
  revalidatePath("/inbox");
  return task.id;
}

/** Create a standalone task (not from the inbox) and return its id. */
export async function createTask(title: string): Promise<string | null> {
  const workspaceId = await currentWorkspaceId();
  const trimmed = title.trim();
  if (!trimmed) return null;
  const task = await prisma.task.create({
    data: { title: trimmed, source: TaskSource.Manual, status: TaskStatus.Active, workspaceId },
  });
  return task.id;
}

/**
 * Persist a confirmed breakdown: set the parent emoji and replace the task's
 * steps with the proposal. (Reclaim scheduling is wired in step 6.)
 */
export async function confirmBreakdown(taskId: string, proposal: Proposal) {
  const workspaceId = await currentWorkspaceId();
  const steps = (proposal.steps ?? []).filter((s) => s.text?.trim());
  const total = steps.length;
  if (total === 0) return;

  const existingTask = await prisma.task.findFirst({ where: { id: taskId, workspaceId } });
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

  revalidatePath(`/tasks/${taskId}`);
  revalidatePath("/inbox");
}
