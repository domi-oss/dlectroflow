"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import { maybeAwardInboxZero } from "@/lib/rewards";
import {
  BrainDumpStatus,
  TaskSource,
  TaskStatus,
} from "@/lib/constants";
import { currentWorkspaceId } from "@/lib/workspace";

const INBOX_PATH = "/inbox";

export async function createBrainDumpItem(text: string) {
  const workspaceId = await currentWorkspaceId();
  const trimmed = text.trim();
  if (!trimmed) return;
  await prisma.brainDumpItem.create({ data: { text: trimmed, workspaceId } });
  revalidatePath(INBOX_PATH);
}

export async function triageBrainDumpItem(id: string) {
  const workspaceId = await currentWorkspaceId();
  const existing = await prisma.brainDumpItem.findFirst({ where: { id, workspaceId } });
  if (!existing) return;
  await prisma.brainDumpItem.update({
    where: { id },
    data: { status: BrainDumpStatus.Triaged, triagedAt: new Date() },
  });
  await maybeAwardInboxZero(workspaceId);
  revalidatePath(INBOX_PATH);
}

export async function snoozeBrainDumpItem(id: string, minutes: number) {
  const workspaceId = await currentWorkspaceId();
  const existing = await prisma.brainDumpItem.findFirst({ where: { id, workspaceId } });
  if (!existing) return;
  await prisma.brainDumpItem.update({
    where: { id },
    data: {
      snoozedUntil: new Date(Date.now() + minutes * 60_000),
      remindedAt: null,
    },
  });
  await maybeAwardInboxZero(workspaceId);
  revalidatePath(INBOX_PATH);
}

export async function deleteBrainDumpItem(id: string) {
  const workspaceId = await currentWorkspaceId();
  const existing = await prisma.brainDumpItem.findFirst({ where: { id, workspaceId } });
  if (!existing) return;
  await prisma.brainDumpItem.delete({ where: { id } });
  await maybeAwardInboxZero(workspaceId);
  revalidatePath(INBOX_PATH);
}

/** Mark an aging item as reminded so we don't re-notify (step 4). */
export async function markReminded(id: string) {
  const workspaceId = await currentWorkspaceId();
  const existing = await prisma.brainDumpItem.findFirst({ where: { id, workspaceId } });
  if (!existing) return;
  await prisma.brainDumpItem.update({
    where: { id },
    data: { remindedAt: new Date() },
  });
  revalidatePath(INBOX_PATH);
}

/**
 * "Keep as task" — promote an inbox item into a Task without breaking it down.
 * (Step 5 will add the conversational-breakdown launch.)
 */
export async function keepAsTask(id: string) {
  const workspaceId = await currentWorkspaceId();
  const item = await prisma.brainDumpItem.findFirst({ where: { id, workspaceId } });
  if (!item) return;
  const task = await prisma.task.create({
    data: {
      title: item.text,
      source: TaskSource.BrainDump,
      status: TaskStatus.Active,
      workspaceId,
    },
  });
  await prisma.brainDumpItem.update({
    where: { id },
    data: {
      status: BrainDumpStatus.Triaged,
      triagedAt: new Date(),
      taskId: task.id,
    },
  });
  await maybeAwardInboxZero(workspaceId);
  revalidatePath(INBOX_PATH);
  return task.id;
}
