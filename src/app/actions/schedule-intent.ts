"use server";

import { prisma } from "@/lib/db";
import { currentWorkspaceId, isOwnerRequest } from "@/lib/workspace";
import { mergePersistedIntent } from "@/lib/scheduling/intent";
import type { ScheduleIntent, ScheduleUnit } from "@/lib/scheduling/types";

/**
 * The intent the Schedule menu opens with (#106): what the owner said last time,
 * or the shared defaults if they have never said anything.
 *
 * `null` when the task is not visible to the caller — a task in another
 * workspace, or a request that is not the owner's. Google is still the owner's
 * singleton connection until #35 Phase C, so the ownership check comes first and
 * a non-owner never reaches the query at all.
 *
 * The merge itself lives in `mergePersistedIntent` (pure, client-safe) so this
 * action and the inbox page — which already holds the same three columns and must
 * not pay a round trip per row for them — cannot drift apart.
 */
export async function loadScheduleIntent(
  taskId: string,
): Promise<ScheduleIntent | null> {
  if (!(await isOwnerRequest())) return null;
  const workspaceId = await currentWorkspaceId();

  const task = await prisma.task.findFirst({
    where: { id: taskId, workspaceId },
    select: {
      id: true,
      scheduleDueAt: true,
      schedulePriority: true,
      scheduleHours: true,
      steps: {
        orderBy: { order: "asc" },
        select: {
          id: true,
          order: true,
          text: true,
          subtaskEmoji: true,
          estMinutes: true,
        },
      },
    },
  });
  if (!task) return null;

  const units: ScheduleUnit[] = task.steps.map((s) => ({
    id: s.id,
    order: s.order,
    total: task.steps.length,
    text: s.text,
    emoji: s.subtaskEmoji,
    estMinutes: s.estMinutes,
    dueAt: null,
  }));

  return mergePersistedIntent(units, task);
}
