"use server";

import { revalidatePath } from "next/cache";
import { prisma, getSettings } from "@/lib/db";
import {
  getValidAccessToken,
  googleConfigured,
  findReclaimList,
  listTaskLists,
  upsertGoogleTask,
  getGoogleStatus,
  disconnectGoogle,
} from "@/lib/google";
import { TaskSource, TaskStatus } from "@/lib/constants";
import { currentWorkspaceId, isOwnerRequest } from "@/lib/workspace";
import { awardFirstSchedule } from "@/lib/scheduling/award";
import { SchedulingMethod } from "@/lib/scheduling/types";
import type { ScheduleUnit } from "@/lib/scheduling/types";
import { defaultIntentFor } from "@/lib/scheduling/intent";
import { deriveWindows } from "@/lib/scheduling/windows";
import { pickEncoder } from "@/lib/scheduling/encoder";
import { publicOrigin } from "@/lib/origin";
import type { Voice } from "@/lib/strings";

export type GoogleScheduleResult =
  | { ok: true; scheduled: number; listTitle: string }
  | {
      ok: false;
      reason:
        | "not_configured"
        | "not_connected"
        | "reconnect_required"
        | "no_reclaim_list"
        | "no_steps"
        | "error";
      message?: string;
    };

/**
 * Push a task's steps into the Reclaim-synced Google Tasks list. Reclaim then
 * auto-syncs + schedules them. Sidesteps the MCP write gate entirely.
 */
export async function pushStepsToGoogleTasks(
  taskId: string,
): Promise<GoogleScheduleResult> {
  const workspaceId = await currentWorkspaceId();
  // #35 Phase A: an explicit role check replaces the workspace-id comparison.
  // Google is still a single instance-level connection until Phase C makes it
  // per user, so it stays owner-only rather than any-signed-in-member.
  if (!(await isOwnerRequest())) throw new Error("owner only");

  if (!googleConfigured()) return { ok: false, reason: "not_configured" };
  const token = await getValidAccessToken();
  if (!token) {
    const status = await getGoogleStatus();
    return {
      ok: false,
      reason: status.needsReconnect ? "reconnect_required" : "not_connected",
    };
  }

  const task = await prisma.task.findFirst({
    where: { id: taskId, workspaceId },
    include: { steps: { orderBy: { order: "asc" } } },
  });
  if (!task || task.steps.length === 0)
    return { ok: false, reason: "no_steps" };

  try {
    const list = await findReclaimList(token);
    if (!list) {
      const names = (await listTaskLists(token)).map((l) => l.title).join(", ");
      return {
        ok: false,
        reason: "no_reclaim_list",
        message: `Couldn't find the "🗓 Reclaim" Google Tasks list. Available: ${names || "none"}. Reclaim only syncs from that list — create it in Google Tasks, or set GOOGLE_TASKS_LIST_NAME if you use a different scheduler.`,
      };
    }

    const settings = await getSettings(workspaceId);
    const voice: Voice = settings.voice === "playful" ? "playful" : "plain";
    const origin = publicOrigin();
    const encode = pickEncoder(list.title);

    const units: ScheduleUnit[] = task.steps.map((s) => ({
      id: s.id,
      order: s.order,
      total: task.steps.length,
      text: s.text,
      emoji: s.subtaskEmoji,
      estMinutes: s.estMinutes,
      dueAt: null,
    }));
    const intent = defaultIntentFor(units);
    const { windows } = deriveWindows(intent);
    const byUnit = new Map(windows.map((w) => [w.unitId, w]));

    let scheduled = 0;
    for (const unit of intent.units) {
      const window = byUnit.get(unit.id);
      if (!window) continue;
      const encoded = encode({
        unit,
        window,
        intent,
        taskTitle: task.title,
        parentEmoji: task.parentEmoji ?? "🗂️",
        origin,
        voice,
      });
      const step = task.steps.find((s) => s.id === unit.id)!;
      const { id } = await upsertGoogleTask(
        token,
        list.id,
        step.googleTaskId,
        encoded,
      );
      // Guard step ownership before update (unchanged from before).
      const stepCheck = await prisma.step.findFirst({
        where: { id: unit.id, task: { workspaceId } },
      });
      if (stepCheck) {
        await prisma.step.update({
          where: { id: unit.id },
          data: { googleTaskId: id, googleTaskListId: list.id },
        });
      }
      scheduled++;
    }

    // Provider-agnostic marker + reward once (mirrors scheduleViaIcs so ICS and
    // Google share one "already scheduled" signal). The steps are already pushed
    // + committed above, so a reward failure must not return { ok: false } and
    // prompt a retry (which would duplicate the Google tasks) — the shared
    // helper keeps rewards best-effort (#34).
    if (task.scheduledAt == null) {
      await prisma.task.update({
        where: { id: task.id },
        data: {
          scheduledAt: new Date(),
          scheduledVia: SchedulingMethod.GoogleTasks,
        },
      });
      // Pass the captured pre-write state (false inside this guard, but robust to
      // the guard being removed) rather than a hardcoded literal — matches
      // awardFirstSchedule's contract + scheduleSingleTask's pattern (#34).
      await awardFirstSchedule(workspaceId, task.scheduledAt != null);
    }

    revalidatePath(`/tasks/${taskId}`);
    return { ok: true, scheduled, listTitle: list.title };
  } catch (err) {
    return {
      ok: false,
      reason: "error",
      message: err instanceof Error ? err.message : "Google Tasks push failed",
    };
  }
}

export type GoogleScheduleSingleResult =
  | { ok: true }
  | {
      ok: false;
      reason:
        | "not_configured"
        | "not_connected"
        | "no_reclaim_list"
        | "reconnect_required"
        | "error";
      message?: string;
    };

/**
 * Schedule a single to-do (Single-task bucket row) as one Google Task, using
 * the same `(duration:Nm)` convention Reclaim parses off step titles. The row
 * may not have a linked Task yet (e.g. triaged straight from the inbox with
 * no steps) — mirrors `keepAsTask`/`ensureFocusStep` in braindump.ts by
 * creating one lazily so the googleTaskId has somewhere to live.
 */
export async function scheduleSingleTask(
  itemId: string,
  estMinutes: number,
): Promise<GoogleScheduleSingleResult> {
  const workspaceId = await currentWorkspaceId();
  // #35 Phase A: an explicit role check replaces the workspace-id comparison.
  // Google is still a single instance-level connection until Phase C makes it
  // per user, so it stays owner-only rather than any-signed-in-member.
  if (!(await isOwnerRequest())) throw new Error("owner only");

  // Server-side clamp (final-review fix): the client popover already refuses
  // out-of-range custom durations, but this action is the single source of
  // truth — round to the nearest minute and reject anything outside 1..480
  // rather than trust caller input.
  const minutes = Math.round(estMinutes);
  if (!Number.isFinite(minutes) || minutes < 1 || minutes > 480) {
    return {
      ok: false,
      reason: "error",
      message: "Duration must be 1-480 minutes",
    };
  }

  if (!googleConfigured()) return { ok: false, reason: "not_configured" };
  const token = await getValidAccessToken();
  if (!token) {
    const status = await getGoogleStatus();
    return {
      ok: false,
      reason: status.needsReconnect ? "reconnect_required" : "not_connected",
    };
  }

  const item = await prisma.brainDumpItem.findFirst({
    where: { id: itemId, workspaceId },
    include: { task: true },
  });
  if (!item) return { ok: false, reason: "error", message: "Item not found" };

  // Reward parity with pushStepsToGoogleTasks (#25): a successful schedule earns
  // Scheduled (+10) and, first ever, the FirstSchedule badge. Idempotency is
  // now keyed on the provider-agnostic `scheduledAt` marker (S0, #29) so ICS and
  // Google share one "already scheduled" signal — a task scheduled by EITHER
  // method won't re-award (the Scheduled points aren't idempotent; awardBadge
  // already is). Captured before the update below so re-scheduling is a no-op
  // reward-wise.
  const alreadyScheduled = item.task?.scheduledAt != null;

  let taskId = item.taskId;
  if (!taskId) {
    // Atomic lazy-create (Duo review): the Task insert and the item link must
    // commit together — otherwise a failed link orphans the Task row and a
    // retry creates a second one (the item's taskId stays null).
    taskId = await prisma.$transaction(async (tx) => {
      const task = await tx.task.create({
        data: {
          title: item.text,
          source: TaskSource.BrainDump,
          status: TaskStatus.Active,
          workspaceId,
        },
      });
      await tx.brainDumpItem.update({
        where: { id: item.id },
        data: { taskId: task.id },
      });
      return task.id;
    });
    // Invalidate the cache now that the item has a linked Task, regardless of
    // whether the Google Tasks push below succeeds — a later failure must not
    // leave the inbox serving stale data for the new task row (Duo review).
    revalidatePath("/");
  }

  try {
    const list = await findReclaimList(token);
    if (!list) return { ok: false, reason: "no_reclaim_list" };

    const encode = pickEncoder(list.title);
    const unit: ScheduleUnit = {
      id: taskId,
      order: 1,
      total: 1,
      text: item.text,
      emoji: null,
      // The caller's clamped duration IS the estimate for a stepless to-do.
      estMinutes: minutes,
    };
    const intent = defaultIntentFor([unit]);
    const { windows } = deriveWindows(intent);
    const settings = await getSettings(workspaceId);
    const voice: Voice = settings.voice === "playful" ? "playful" : "plain";
    const encoded = encode({
      unit,
      window: windows[0],
      intent,
      taskTitle: item.text,
      parentEmoji: null,
      origin: publicOrigin(),
      voice,
    });
    const existing = await prisma.task.findFirst({
      where: { id: taskId, workspaceId },
      select: { googleTaskId: true },
    });
    const created = await upsertGoogleTask(
      token,
      list.id,
      existing?.googleTaskId ?? null,
      encoded,
    );

    await prisma.task.update({
      where: { id: taskId },
      data: {
        googleTaskId: created.id,
        googleTaskListId: list.id,
        // Stamp the provider-agnostic marker on the first schedule (any method).
        // Folded into this same update (rather than a second one) — which is why
        // the shared reward helper stays marker-agnostic (it awards, callers stamp).
        ...(alreadyScheduled
          ? {}
          : {
              scheduledAt: new Date(),
              scheduledVia: SchedulingMethod.GoogleTasks,
            }),
      },
    });

    // Best-effort rewards through the shared seam helper: the Google task +
    // task.update have already committed, so a reward failure must NOT return
    // { ok: false } (a retry would duplicate the Google task). Idempotent on the
    // captured `alreadyScheduled` marker so re-scheduling never re-awards (#34).
    await awardFirstSchedule(workspaceId, alreadyScheduled);

    revalidatePath("/");
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      reason: "error",
      message: err instanceof Error ? err.message : "Google Tasks push failed",
    };
  }
}

export async function googleStatus() {
  if (!(await isOwnerRequest()))
    return { configured: false, connected: false, needsReconnect: false };
  return getGoogleStatus();
}

export async function disconnectGoogleTasks(): Promise<{ ok: true }> {
  if (!(await isOwnerRequest())) throw new Error("owner only");
  await disconnectGoogle();
  revalidatePath("/settings");
  return { ok: true };
}
