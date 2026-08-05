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

  // Focus deep-link note (#39): voice-aware prompt + absolute URL into /focus.
  // Built PER STEP (#104) — it used to be built once from steps[0] and reused for
  // every VEVENT, so a downloaded calendar sent all of a task's events to step
  // 1's timer. Guests have no other scheduling method, so this was their bug too.
  const settings = await getSettings(workspaceId);
  const voice: Voice = settings.voice === "playful" ? "playful" : "plain";
  const origin = publicOrigin();
  //
  // #44 — the notes are composed in above the prompt. The TASK's note goes on
  // EVERY event rather than only the first: it is context for the task, and a
  // calendar entry you open at step 3 needs it as much as one you open at step
  // 1. Each event additionally carries ITS OWN step's note. Both reach the file
  // through `esc()` like every other value — see the injection tests in this
  // action's colocated spec, which cover both grains.
  const steps = task.steps.map((s) => ({
    text: s.text,
    estMinutes: s.estMinutes,
    subtaskEmoji: s.subtaskEmoji,
    description: buildScheduleNote({
      origin,
      voice,
      stepId: s.id,
      taskNote: task.notes,
      stepNote: s.notes,
    }),
  }));
  // The stepless (fallback) event has no step to link to, so it keeps the
  // launcher URL — which is what `buildTaskIcs`'s shared `description` is for —
  // and no step note, because there is no step to have written one.
  const description = buildScheduleNote({
    origin,
    voice,
    stepId: null,
    taskNote: task.notes,
  });

  const ics = buildTaskIcs({
    title: task.title,
    parentEmoji: task.parentEmoji,
    steps,
    fallbackDurationMin: durationMin,
    description,
    // The owner asked for the time to be defended, and unlike the Reclaim path
    // an .ics can say so (#104).
    busy: true,
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
    revalidatePath("/");
    revalidatePath(`/tasks/${taskId}`);
  }

  return { ok: true, ics, icsFilename: icsFilename(task.title) };
}
