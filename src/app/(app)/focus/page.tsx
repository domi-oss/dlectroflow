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
import { openSessionRemainingSec } from "@/lib/focus-timer-clock";
import { effectiveRemainingMin } from "@/lib/task-remaining";

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
      where: {
        workspaceId,
        status: { not: TaskStatus.Archived },
        // #64 defensive filter: a Task with no live BrainDumpItem pointing at
        // it is structurally invisible to the Library (its only source query
        // is BrainDumpItem) — never surface one here either, however it
        // arose, so Focus and Library can't disagree on what's phantom.
        brainDumpItems: { some: { status: { not: BrainDumpStatus.Archived } } },
      },
      orderBy: { createdAt: "desc" },
      include: {
        steps: {
          orderBy: { order: "asc" },
          include: {
            // #27 follow-up — fetch ANY open session (paused or actively
            // running), not just paused ones: `resumable` (the CTA/ordering
            // signal) is derived from `pausedAt` in the mapping below, while
            // the full row also feeds the step's effective remaining time
            // (task-remaining.ts) for the resume hero's "~Xm left".
            focusSessions: {
              where: { endedAt: null },
              orderBy: { startedAt: "desc" },
              take: 1,
              select: {
                startedAt: true,
                pausedAt: true,
                accumulatedPausedMs: true,
                plannedMin: true,
              },
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
                // #27 — same truly-paused filter as the tasks query above.
                focusSessions: {
                  where: { endedAt: null, pausedAt: { not: null } },
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
    steps: task.steps.map((s) => {
      const session = s.focusSessions[0] ?? null;
      const openRemainingSec = openSessionRemainingSec(session, now);
      return {
        id: s.id,
        order: s.order,
        text: s.text,
        done: s.done,
        estMinutes: s.estMinutes,
        subtaskEmoji: s.subtaskEmoji,
        // #27 — resumable means TRULY paused (pausedAt set), not merely open.
        resumable: session?.pausedAt != null,
        resumeAt: session?.startedAt.getTime() ?? null,
        // #27 follow-up — the resume hero's "~Xm left" reflects real
        // progress (task-remaining.ts), not just the original estimate.
        remainingMin: effectiveRemainingMin({
          done: s.done,
          estMinutes: s.estMinutes,
          openRemainingSec,
        }),
      };
    }),
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
