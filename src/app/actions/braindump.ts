"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import {
  BrainDumpStatus,
  TaskSource,
  TaskStatus,
} from "@/lib/constants";

const INBOX_PATH = "/inbox";

export async function createBrainDumpItem(text: string) {
  const trimmed = text.trim();
  if (!trimmed) return;
  await prisma.brainDumpItem.create({ data: { text: trimmed } });
  revalidatePath(INBOX_PATH);
}

export async function triageBrainDumpItem(id: string) {
  await prisma.brainDumpItem.update({
    where: { id },
    data: { status: BrainDumpStatus.Triaged, triagedAt: new Date() },
  });
  revalidatePath(INBOX_PATH);
}

export async function snoozeBrainDumpItem(id: string, minutes: number) {
  await prisma.brainDumpItem.update({
    where: { id },
    data: {
      snoozedUntil: new Date(Date.now() + minutes * 60_000),
      remindedAt: null,
    },
  });
  revalidatePath(INBOX_PATH);
}

export async function deleteBrainDumpItem(id: string) {
  await prisma.brainDumpItem.delete({ where: { id } });
  revalidatePath(INBOX_PATH);
}

/**
 * "Keep as task" — promote an inbox item into a Task without breaking it down.
 * (Step 5 will add the conversational-breakdown launch.)
 */
export async function keepAsTask(id: string) {
  const item = await prisma.brainDumpItem.findUnique({ where: { id } });
  if (!item) return;
  const task = await prisma.task.create({
    data: {
      title: item.text,
      source: TaskSource.BrainDump,
      status: TaskStatus.Active,
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
  revalidatePath(INBOX_PATH);
  return task.id;
}
