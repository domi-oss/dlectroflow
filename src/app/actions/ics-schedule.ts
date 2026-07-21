"use server";

import { revalidatePath } from "next/cache";
import { prisma, getSettings } from "@/lib/db";
import { buildTaskIcs, icsFilename } from "@/lib/ics";
import { currentWorkspaceId } from "@/lib/workspace";
import { awardFirstSchedule } from "@/lib/scheduling/award";
import { SchedulingMethod } from "@/lib/scheduling/types";
import { buildScheduleNote } from "@/lib/scheduling/note";
import { publicOrigin } from "@/lib/origin";
import type { Voice } from "@/lib/strings";

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
  const durationMin = Number.isFinite(raw)
    ? Math.min(480, Math.max(1, raw))
    : DEFAULT_ICS_DURATION_MIN;

  // Focus deep-link note (#39): voice-aware prompt + absolute URL into /focus for
  // this task's first step (else the launcher). Embedded in every VEVENT so tapping
  // the calendar event drops the user straight into focusing.
  const settings = await getSettings(workspaceId);
  const voice: Voice = settings.voice === "playful" ? "playful" : "plain";
  const description = buildScheduleNote({
    origin: publicOrigin(),
    voice,
    stepId: task.steps[0]?.id ?? null,
  });

  const ics = buildTaskIcs({
    title: task.title,
    parentEmoji: task.parentEmoji,
    steps: task.steps.map((s) => ({
      text: s.text,
      estMinutes: s.estMinutes,
      subtaskEmoji: s.subtaskEmoji,
    })),
    fallbackDurationMin: durationMin,
    description,
  });

  // Mark + reward once (idempotent on scheduledAt). Re-downloads skip both.
  // The marker stamp stays here (each write site owns it — scheduleSingleTask
  // folds it into another update); the shared helper owns the best-effort reward.
  if (task.scheduledAt == null) {
    await prisma.task.update({
      where: { id: task.id },
      data: { scheduledAt: new Date(), scheduledVia: SchedulingMethod.Ics },
    });
    // Pass the captured pre-write state (false inside this guard, but robust to
    // the guard being removed) rather than a hardcoded literal — matches
    // awardFirstSchedule's contract + scheduleSingleTask's pattern (#34).
    await awardFirstSchedule(workspaceId, task.scheduledAt != null);
    revalidatePath("/inbox");
    revalidatePath(`/tasks/${taskId}`);
  }

  return { ok: true, ics, icsFilename: icsFilename(task.title) };
}
