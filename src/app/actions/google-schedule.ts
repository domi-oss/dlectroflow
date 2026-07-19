"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import {
  getValidAccessToken,
  googleConfigured,
  findReclaimList,
  listTaskLists,
  createGoogleTask,
  getGoogleStatus,
  disconnectGoogle,
} from "@/lib/google";
import {
  OWNER_WORKSPACE_ID,
  TaskSource,
  TaskStatus,
} from "@/lib/constants";
import { currentWorkspaceId } from "@/lib/workspace";
import { awardFirstSchedule } from "@/lib/scheduling/award";
import { SchedulingMethod } from "@/lib/scheduling/types";

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
 * Build the Google Task title with Reclaim's parsing syntax appended in parens.
 * Reclaim ingests the task from the synced list, reads `duration:Nm`, then strips
 * the parenthetical — leaving a clean, auto-scheduled task.
 *   e.g. "🎬 Prep demo: 2 of 5 🎤 Practice run-through (duration:20m)"
 */
function reclaimTitle(
  parentEmoji: string,
  taskTitle: string,
  order: number,
  total: number,
  subtaskEmoji: string,
  text: string,
  estMinutes: number,
): string {
  const emoji = parentEmoji ? `${parentEmoji} ` : "";
  const sub = subtaskEmoji ? `${subtaskEmoji} ` : "";
  return `${emoji}${taskTitle}: ${order} of ${total} ${sub}${text} (duration:${estMinutes}m)`;
}

/**
 * Push a task's steps into the Reclaim-synced Google Tasks list. Reclaim then
 * auto-syncs + schedules them. Sidesteps the MCP write gate entirely.
 */
export async function pushStepsToGoogleTasks(
  taskId: string,
): Promise<GoogleScheduleResult> {
  const workspaceId = await currentWorkspaceId();
  if (workspaceId !== OWNER_WORKSPACE_ID) throw new Error("owner only");

  if (!googleConfigured()) return { ok: false, reason: "not_configured" };
  const token = await getValidAccessToken();
  if (!token) {
    const status = await getGoogleStatus();
    return { ok: false, reason: status.needsReconnect ? "reconnect_required" : "not_connected" };
  }

  const task = await prisma.task.findFirst({
    where: { id: taskId, workspaceId },
    include: { steps: { orderBy: { order: "asc" } } },
  });
  if (!task || task.steps.length === 0) return { ok: false, reason: "no_steps" };

  try {
    const list = await findReclaimList(token);
    if (!list) {
      const names = (await listTaskLists(token)).map((l) => l.title).join(", ");
      return {
        ok: false,
        reason: "no_reclaim_list",
        message: `Couldn't find a Google Tasks list matching "Reclaim". Available: ${names || "none"}. Make sure Reclaim's Google Tasks integration is set up (it creates a 🗓 Reclaim list).`,
      };
    }

    const parentEmoji = task.parentEmoji ?? "🗂️";
    const total = task.steps.length;
    let scheduled = 0;
    for (const s of task.steps) {
      const title = reclaimTitle(
        parentEmoji,
        task.title,
        s.order,
        total,
        s.subtaskEmoji ?? "",
        s.text,
        s.estMinutes,
      );
      const created = await createGoogleTask(token, list.id, { title });
      // Guard step ownership before update
      const stepCheck = await prisma.step.findFirst({ where: { id: s.id, task: { workspaceId } } });
      if (stepCheck) {
        await prisma.step.update({
          where: { id: s.id },
          data: { googleTaskId: created.id, googleTaskListId: list.id },
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
        data: { scheduledAt: new Date(), scheduledVia: SchedulingMethod.GoogleTasks },
      });
      await awardFirstSchedule(workspaceId, false);
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
  if (workspaceId !== OWNER_WORKSPACE_ID) throw new Error("owner only");

  // Server-side clamp (final-review fix): the client popover already refuses
  // out-of-range custom durations, but this action is the single source of
  // truth — round to the nearest minute and reject anything outside 1..480
  // rather than trust caller input.
  const minutes = Math.round(estMinutes);
  if (!Number.isFinite(minutes) || minutes < 1 || minutes > 480) {
    return { ok: false, reason: "error", message: "Duration must be 1-480 minutes" };
  }

  if (!googleConfigured()) return { ok: false, reason: "not_configured" };
  const token = await getValidAccessToken();
  if (!token) {
    const status = await getGoogleStatus();
    return { ok: false, reason: status.needsReconnect ? "reconnect_required" : "not_connected" };
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
      await tx.brainDumpItem.update({ where: { id: item.id }, data: { taskId: task.id } });
      return task.id;
    });
    // Invalidate the cache now that the item has a linked Task, regardless of
    // whether the Google Tasks push below succeeds — a later failure must not
    // leave the inbox serving stale data for the new task row (Duo review).
    revalidatePath("/inbox");
  }

  try {
    const list = await findReclaimList(token);
    if (!list) return { ok: false, reason: "no_reclaim_list" };

    const title = `${item.text} (duration:${minutes}m)`;
    const created = await createGoogleTask(token, list.id, { title });

    await prisma.task.update({
      where: { id: taskId },
      data: {
        googleTaskId: created.id,
        googleTaskListId: list.id,
        // Stamp the provider-agnostic marker on the first schedule (any method).
        // Folded into this same update (rather than a second one) — which is why
        // the shared reward helper stays marker-agnostic (it awards, callers stamp).
        ...(alreadyScheduled ? {} : { scheduledAt: new Date(), scheduledVia: SchedulingMethod.GoogleTasks }),
      },
    });

    // Best-effort rewards through the shared seam helper: the Google task +
    // task.update have already committed, so a reward failure must NOT return
    // { ok: false } (a retry would duplicate the Google task). Idempotent on the
    // captured `alreadyScheduled` marker so re-scheduling never re-awards (#34).
    await awardFirstSchedule(workspaceId, alreadyScheduled);

    revalidatePath("/inbox");
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
  const workspaceId = await currentWorkspaceId();
  if (workspaceId !== OWNER_WORKSPACE_ID)
    return { configured: false, connected: false, needsReconnect: false };
  return getGoogleStatus();
}

export async function disconnectGoogleTasks(): Promise<{ ok: true }> {
  const workspaceId = await currentWorkspaceId();
  if (workspaceId !== OWNER_WORKSPACE_ID) throw new Error("owner only");
  await disconnectGoogle();
  revalidatePath("/settings");
  return { ok: true };
}
