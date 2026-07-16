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
import { RewardType, BadgeKey, OWNER_WORKSPACE_ID } from "@/lib/constants";
import { logReward, awardBadge } from "@/lib/rewards";
import { currentWorkspaceId } from "@/lib/workspace";

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

    await logReward(workspaceId, RewardType.Scheduled);
    await awardBadge(workspaceId, BadgeKey.FirstSchedule);

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
