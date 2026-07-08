import { prisma } from "@/lib/db";
import { currentWorkspaceId } from "@/lib/workspace";
import { buildTaskIcs } from "@/lib/ics";

export const runtime = "nodejs";

export async function GET(
  _req: Request,
  ctx: { params: Promise<{ taskId: string }> },
): Promise<Response> {
  const { taskId } = await ctx.params;
  const workspaceId = await currentWorkspaceId();
  const task = await prisma.task.findFirst({
    where: { id: taskId, workspaceId },
    include: { steps: { orderBy: { order: "asc" } } },
  });
  if (!task) return new Response("Not found", { status: 404 });

  const ics = buildTaskIcs({
    title: task.title,
    parentEmoji: task.parentEmoji,
    steps: task.steps.map((s) => ({
      text: s.text,
      estMinutes: s.estMinutes,
      subtaskEmoji: s.subtaskEmoji,
    })),
  });
  const safe = task.title.replace(/[^a-z0-9]+/gi, "-").slice(0, 40) || "task";
  return new Response(ics, {
    headers: {
      "Content-Type": "text/calendar; charset=utf-8",
      "Content-Disposition": `attachment; filename="dlectroflow-${safe}.ics"`,
      "Cache-Control": "no-store",
    },
  });
}
