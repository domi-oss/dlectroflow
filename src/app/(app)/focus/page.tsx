import { prisma, getSettings } from "@/lib/db";
import { currentWorkspaceId } from "@/lib/workspace";
import { TaskStatus } from "@/lib/constants";
import { focusableSteps } from "@/lib/focus-launcher";
import { FocusLauncher } from "@/components/focus/focus-launcher";
import { t, type Voice } from "@/lib/strings";

// DB-backed, always fresh.
export const dynamic = "force-dynamic";

/**
 * /focus — the Focus launcher / step-picker. Lists the next incomplete step of
 * each in-progress task (resumable/paused first, then newest task first) and
 * links each into the existing /focus/[stepId] timer. New users (no focusable
 * steps) get an empty state pointing at the Inbox.
 */
export default async function FocusLauncherPage() {
  const workspaceId = await currentWorkspaceId();
  const [rawTasks, settings] = await Promise.all([
    prisma.task.findMany({
      // Workspace-scoped, same as every other page. Archived tasks are never
      // focusable; done tasks have no incomplete steps so they drop out below.
      where: { workspaceId, status: { not: TaskStatus.Archived } },
      orderBy: { createdAt: "desc" },
      include: {
        steps: {
          orderBy: { order: "asc" },
          // A step is "resumable" if it has an unfinished focus session
          // (started, never ended) — mirrors inbox/page.tsx. Batched by Prisma
          // into one query per relation, so this is not a per-step N+1.
          include: {
            focusSessions: { where: { endedAt: null }, select: { id: true }, take: 1 },
          },
        },
      },
    }),
    getSettings(workspaceId),
  ]);

  const voice: Voice = settings.voice === "playful" ? "playful" : "plain";

  const entries = focusableSteps(
    rawTasks.map((task) => ({
      id: task.id,
      title: task.title,
      createdAt: task.createdAt,
      steps: task.steps.map((s) => ({
        id: s.id,
        order: s.order,
        text: s.text,
        done: s.done,
        estMinutes: s.estMinutes,
        subtaskEmoji: s.subtaskEmoji,
        resumable: s.focusSessions.length > 0,
      })),
    })),
  );

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold">{t("nav.focusTimer", voice)}</h1>
      <FocusLauncher entries={entries} voice={voice} />
    </div>
  );
}
