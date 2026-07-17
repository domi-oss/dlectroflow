"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import { buildTaskIcs, icsFilename } from "@/lib/ics";
import { RewardType, BadgeKey } from "@/lib/constants";
import { logReward, awardBadge } from "@/lib/rewards";
import { currentWorkspaceId } from "@/lib/workspace";

const DEFAULT_ICS_DURATION_MIN = 25;

export type IcsScheduleResult =
  | { ok: true; ics: string; icsFilename: string }
  | { ok: false; reason: "not_found" | "error"; message?: string };

/**
 * Build a task's .ics and schedule it via download — workspace-scoped and
 * guest-allowed (NO owner gate). First schedule (any method) stamps the
 * provider-agnostic marker and awards Scheduled + FirstSchedule once;
 * re-downloads return the file without re-awarding. The reward is best-effort:
 * a logging failure must never fail scheduling.
 */
export async function scheduleViaIcs(
  taskId: string,
  opts?: { durationMin?: number },
): Promise<IcsScheduleResult> {
  const workspaceId = await currentWorkspaceId();

  const task = await prisma.task.findFirst({
    where: { id: taskId, workspaceId },
    include: { steps: { orderBy: { order: "asc" } } },
  });
  if (!task) return { ok: false, reason: "not_found" };

  // Stepless tasks synthesize one event of this length; clamp to the same
  // 1..480 bound the Google single-task path enforces.
  const raw = Math.round(opts?.durationMin ?? DEFAULT_ICS_DURATION_MIN);
  const durationMin =
    Number.isFinite(raw) ? Math.min(480, Math.max(1, raw)) : DEFAULT_ICS_DURATION_MIN;

  const ics = buildTaskIcs({
    title: task.title,
    parentEmoji: task.parentEmoji,
    steps: task.steps.map((s) => ({
      text: s.text,
      estMinutes: s.estMinutes,
      subtaskEmoji: s.subtaskEmoji,
    })),
    fallbackDurationMin: durationMin,
  });

  // Mark + reward once (idempotent on scheduledAt). Re-downloads skip both.
  if (task.scheduledAt == null) {
    await prisma.task.update({
      where: { id: task.id },
      data: { scheduledAt: new Date(), scheduledVia: "ics" },
    });
    try {
      await logReward(workspaceId, RewardType.Scheduled);
      await awardBadge(workspaceId, BadgeKey.FirstSchedule);
    } catch {
      // Reward is a bonus; the .ics is the product. Never fail scheduling.
    }
    revalidatePath("/inbox");
    revalidatePath(`/tasks/${taskId}`);
  }

  return { ok: true, ics, icsFilename: icsFilename(task.title) };
}
