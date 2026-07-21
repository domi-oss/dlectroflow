import { prisma, getSettings } from "@/lib/db";
import { currentWorkspaceId } from "@/lib/workspace";
import { TaskStatus, BrainDumpStatus } from "@/lib/constants";
import { libraryBuckets, type Item } from "@/components/inbox/bucket";
import {
  focusLauncherData,
  type FocusTask,
  type SingleFocusable,
} from "@/lib/focus-launcher";
import { getDashboardData } from "@/lib/rewards";
import { FocusLauncher } from "@/components/focus/focus-launcher";
import { type Voice } from "@/lib/strings";

// DB-backed, always fresh.
export const dynamic = "force-dynamic";

/**
 * /focus — the Focus launcher. A dashboard meta line, a resume hero
 * (most-recently-active paused multi-step step), and Single-task / Multi-step
 * lanes using the exact inbox SubHeader + "see all →", with inline ✓
 * quick-complete. Read-only: single-task ▶ Start lazily creates its one-step
 * task via ensureFocusStep at click time. Selection is the pure
 * focusLauncherData; this page only loads + maps.
 */
export default async function FocusLauncherPage() {
  const workspaceId = await currentWorkspaceId();
  const now = Date.now();

  const [rawTasks, rawItems, settings, dashboard] = await Promise.all([
    prisma.task.findMany({
      where: { workspaceId, status: { not: TaskStatus.Archived } },
      orderBy: { createdAt: "desc" },
      include: {
        steps: {
          orderBy: { order: "asc" },
          include: {
            // Most-recent open session → drives resumable + resumeAt ordering.
            focusSessions: {
              where: { endedAt: null },
              orderBy: { startedAt: "desc" },
              take: 1,
              select: { startedAt: true },
            },
          },
        },
      },
    }),
    // Single-task to-dos come from the SAME BrainDumpItem query + libraryBuckets
    // the Inbox/Library use, so the lanes can never disagree with those surfaces.
    prisma.brainDumpItem.findMany({
      where: { workspaceId, status: { not: BrainDumpStatus.Archived } },
      orderBy: { createdAt: "desc" },
      include: {
        task: {
          include: {
            steps: {
              orderBy: { order: "asc" },
              include: {
                focusSessions: {
                  where: { endedAt: null },
                  select: { id: true },
                  take: 1,
                },
              },
            },
          },
        },
      },
    }),
    getSettings(workspaceId),
    getDashboardData(workspaceId),
  ]);

  const voice: Voice = settings.voice === "playful" ? "playful" : "plain";

  const tasks: FocusTask[] = rawTasks.map((task) => ({
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
      resumeAt: s.focusSessions[0]?.startedAt.getTime() ?? null,
    })),
  }));

  const items: Item[] = rawItems.map(({ task, ...item }) => ({
    ...item,
    stepsTotal: task?.steps.length ?? 0,
    stepsDone: task?.steps.filter((s) => s.done).length ?? 0,
    taskStatus: task?.status ?? null,
    scheduledAt: task?.scheduledAt ?? null,
    steps:
      task?.steps.map((s) => ({
        id: s.id,
        order: s.order,
        text: s.text,
        done: s.done,
        estMinutes: s.estMinutes,
        subtaskEmoji: s.subtaskEmoji,
        resumable: s.focusSessions.length > 0,
      })) ?? [],
  }));

  // The single-task ("plated") bucket → SingleFocusable rows. `?? 5` mirrors
  // library-row-meta's singleTaskEstimate (null estimate → a 5-min default).
  const singleTasks: SingleFocusable[] = libraryBuckets(
    items,
    now,
  ).singleTask.map((i) => ({
    itemId: i.id,
    text: i.text,
    estMinutes: i.estMinutes ?? 5,
  }));

  const data = focusLauncherData(tasks, singleTasks);

  return (
    <FocusLauncher
      data={data}
      focusMinToday={dashboard.focusMinToday}
      currentStreak={dashboard.currentStreak}
      // Proxy for "had focusable work today, now cleared" — a step got done today.
      clearedToday={dashboard.stepsDoneToday > 0}
      voice={voice}
    />
  );
}
