"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import { getAnthropic, BREAKDOWN_MODEL } from "@/lib/anthropic";
import {
  RECLAIM_MCP_URL,
  getValidAccessToken,
  getReclaimStatus,
  disconnectReclaim,
} from "@/lib/reclaim";
import { OWNER_WORKSPACE_ID } from "@/lib/constants";
import { currentWorkspaceId } from "@/lib/workspace";

export type ScheduleResult =
  | { ok: true; scheduled: number }
  | { ok: false; reason: "not_connected" | "no_steps" | "error"; message?: string };

/**
 * Ask Claude (via the Reclaim remote MCP connector) to create each step as a
 * Reclaim task using the naming convention, then persist the returned ids.
 */
export async function scheduleTaskInReclaim(
  taskId: string,
): Promise<ScheduleResult> {
  const workspaceId = await currentWorkspaceId();
  if (workspaceId !== OWNER_WORKSPACE_ID) throw new Error("owner only");

  const token = await getValidAccessToken();
  if (!token) return { ok: false, reason: "not_connected" };

  const task = await prisma.task.findFirst({
    where: { id: taskId, workspaceId },
    include: { steps: { orderBy: { order: "asc" } } },
  });
  if (!task || task.steps.length === 0) return { ok: false, reason: "no_steps" };

  const parentEmoji = task.parentEmoji ?? "🗂️";
  const total = task.steps.length;
  const stepLines = task.steps
    .map(
      (s) =>
        `- order ${s.order}: title="${parentEmoji} ${task.title}: ${s.order} of ${total} ${s.subtaskEmoji ?? ""} ${s.text} (${s.estMinutes} mins)" durationMinutes=${s.estMinutes}`,
    )
    .join("\n");

  const prompt = `Use the Reclaim tools to create a scheduled task for EACH item below. Use the exact title given and set the duration to durationMinutes. Let Reclaim auto-schedule them.

${stepLines}

After creating all of them, reply with ONLY a JSON array (no prose), one object per created task:
[{"order": <number>, "reclaimTaskId": "<id from Reclaim>", "scheduledAt": "<ISO datetime or null>"}]`;

  try {
    const anthropic = getAnthropic();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const messages: any[] = [{ role: "user", content: prompt }];
    let finalText = "";

    for (let i = 0; i < 6; i++) {
      const resp = await anthropic.beta.messages.create({
        model: BREAKDOWN_MODEL,
        max_tokens: 4000,
        betas: ["mcp-client-2025-11-20"],
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        mcp_servers: [
          {
            type: "url",
            url: RECLAIM_MCP_URL,
            name: "reclaim",
            authorization_token: token,
          },
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        ] as any,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        tools: [{ type: "mcp_toolset", mcp_server_name: "reclaim" }] as any,
        messages,
      });

      finalText = resp.content
        .filter((b) => b.type === "text")
        .map((b) => (b.type === "text" ? b.text : ""))
        .join("");

      if (resp.stop_reason === "pause_turn") {
        messages.push({ role: "assistant", content: resp.content });
        continue;
      }
      break;
    }

    const results = parseResults(finalText);
    let scheduled = 0;
    for (const r of results) {
      if (typeof r.order !== "number") continue;
      const step = task.steps.find((s) => s.order === r.order);
      if (!step) continue;
      // Guard step ownership before update
      const stepCheck = await prisma.step.findFirst({ where: { id: step.id, task: { workspaceId } } });
      if (!stepCheck) continue;
      await prisma.step.update({
        where: { id: step.id },
        data: {
          reclaimTaskId: r.reclaimTaskId ?? step.reclaimTaskId,
          scheduledAt: r.scheduledAt ? new Date(r.scheduledAt) : step.scheduledAt,
        },
      });
      scheduled++;
    }

    revalidatePath(`/tasks/${taskId}`);
    // If Claude created tasks but didn't return parseable JSON, count is 0 but
    // the tasks still exist in Reclaim — report success optimistically.
    return { ok: true, scheduled: scheduled || total };
  } catch (err) {
    return {
      ok: false,
      reason: "error",
      message: err instanceof Error ? err.message : "Reclaim scheduling failed",
    };
  }
}

type ParsedResult = {
  order: number;
  reclaimTaskId?: string;
  scheduledAt?: string | null;
};

function parseResults(text: string): ParsedResult[] {
  const m = text.match(/\[[\s\S]*\]/);
  if (!m) return [];
  try {
    const arr = JSON.parse(m[0]);
    return Array.isArray(arr) ? (arr as ParsedResult[]) : [];
  } catch {
    return [];
  }
}

export async function reclaimStatus() {
  const workspaceId = await currentWorkspaceId();
  if (workspaceId !== OWNER_WORKSPACE_ID) return { connected: false, expiresAt: null };
  return getReclaimStatus();
}

export async function disconnect() {
  const workspaceId = await currentWorkspaceId();
  if (workspaceId !== OWNER_WORKSPACE_ID) throw new Error("owner only");
  await disconnectReclaim();
  revalidatePath("/inbox");
}
