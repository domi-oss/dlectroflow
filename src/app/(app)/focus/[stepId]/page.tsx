import { notFound } from "next/navigation";
import { prisma, getSettings } from "@/lib/db";
import { currentWorkspaceId } from "@/lib/workspace";
import { getDashboardData } from "@/lib/rewards";
import { BrainDumpStatus, TaskStatus } from "@/lib/constants";
import { libraryBuckets, type Item } from "@/components/inbox/bucket";
import {
  FocusTimer,
  type ExistingPausedSession,
  type NextUp,
} from "@/components/focus/focus-timer";
import { remainingSecForSession } from "@/lib/focus-timer-clock";
import { nextInFocusOrder } from "@/lib/focus-next";

export const dynamic = "force-dynamic";

export default async function FocusPage({
  params,
}: {
  params: Promise<{ stepId: string }>;
}) {
  const workspaceId = await currentWorkspaceId();
  const { stepId } = await params;
  const step = await prisma.step.findFirst({
    where: { id: stepId, task: { workspaceId } },
    include: { task: true },
  });
  if (!step) notFound();

  const [
    settings,
    dashboard,
    steps,
    nextStep,
    openSession,
    otherTasks,
    rawItems,
  ] = await Promise.all([
    getSettings(workspaceId),
    getDashboardData(workspaceId),
    prisma.step.findMany({
      where: { taskId: step.taskId, task: { workspaceId } },
      orderBy: { order: "asc" },
    }),
    prisma.step.findFirst({
      where: {
        taskId: step.taskId,
        done: false,
        order: { gt: step.order },
        task: { workspaceId },
      },
      orderBy: { order: "asc" },
    }),
    // #27 — the step's own open FocusSession, if any. Only a truly PAUSED
    // one (pausedAt set) is offered as "Resume …" below; an open-but-never-
    // paused row is stale (e.g. a closed tab mid-countdown) and Start will
    // silently retire it (see beginFocus).
    prisma.focusSession.findFirst({
      where: { stepId: step.id, workspaceId, endedAt: null },
      orderBy: { startedAt: "desc" },
    }),
    // ── #142: what comes after THIS task ────────────────────────────────
    //
    // Loaded on every focus page rather than on demand after the step is
    // completed. A server action at completion time would be cheaper, but it
    // would put a round-trip — and a new failure mode — in the one moment
    // this issue exists to protect: the finish. Two more reads on a
    // force-dynamic page that already runs five is the cheaper trade.
    //
    // Other multi-step tasks with something left to do. Same #64 orphan
    // filter as the launcher, so Focus can never offer work the Library
    // cannot see.
    prisma.task.findMany({
      where: {
        workspaceId,
        id: { not: step.taskId },
        status: { not: TaskStatus.Archived },
        brainDumpItems: {
          some: { status: { not: BrainDumpStatus.Archived } },
        },
        steps: { some: { done: false } },
      },
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        title: true,
        scheduleDueAt: true,
        scheduledAt: true,
        steps: {
          orderBy: { order: "asc" },
          select: { id: true, text: true, subtaskEmoji: true, done: true },
        },
      },
    }),
    // …and the single-task to-dos, through the SAME BrainDumpItem query the
    // launcher, Inbox and Library use, so the four surfaces can never
    // disagree about what a single-task to-do is.
    prisma.brainDumpItem.findMany({
      where: { workspaceId, status: { not: BrainDumpStatus.Archived } },
      orderBy: { createdAt: "desc" },
      include: {
        task: { include: { steps: { orderBy: { order: "asc" } } } },
      },
    }),
  ]);

  // eslint-disable-next-line react-hooks/purity -- async Server Component: this runs once per request on the server, not in a compiler-memoised client render.
  const now = Date.now();

  /**
   * The multi-step lane, in the default order: soonest due, then soonest
   * scheduled (`compareFocusOrder`). One entry per task — its next incomplete
   * step — exactly as the launcher derives its rows. A ONE-step task is a
   * single-task to-do, not a multi-step one, which is the same `<= 1` rule
   * `bucketItems` applies.
   */
  const nextTask = nextInFocusOrder(
    otherTasks.flatMap((task) => {
      if (task.steps.length < 2) return [];
      const next = task.steps.find((s) => !s.done);
      return next
        ? [
            {
              dueAt: task.scheduleDueAt,
              scheduledAt: task.scheduledAt,
              taskTitle: task.title,
              step: next,
            },
          ]
        : [];
    }),
  );

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
        // Not read by the bucketing rules; the launcher's resume hero is the
        // only thing that needs it and it is not derived here.
        resumable: false,
      })) ?? [],
  }));
  // `Item` carries the task's scheduledAt but not its due date, so keep the due
  // dates beside it rather than widening a type four other surfaces share.
  const dueByItem = new Map(
    rawItems.map((i) => [i.id, i.task?.scheduleDueAt ?? null]),
  );

  const nextSingle = nextInFocusOrder(
    libraryBuckets(items, now)
      .singleTask // The to-do that owns the step just finished is not "next".
      .filter((i) => i.taskId !== step.taskId)
      .map((i) => ({
        dueAt: dueByItem.get(i.id) ?? null,
        scheduledAt: i.scheduledAt,
        itemId: i.id,
        text: i.text,
      })),
  );

  /**
   * Multi-step tasks are drained before single-task to-dos, rather than the two
   * lanes being interleaved by date. That is the issue's own rule — the offer to
   * turn on hyper focus mode is gated on "the multi-step queue is empty" — and
   * it matches how /focus already presents the two lanes. Ordering *within* each
   * lane is the due-then-scheduled default. Whether a to-do due today should
   * ever outrank a task due next month is a cross-lane question, and the surface
   * that owns queue order is #143.
   */
  const nextUp: NextUp | null = nextTask
    ? {
        kind: "step",
        stepId: nextTask.step.id,
        text: nextTask.step.text,
        emoji: nextTask.step.subtaskEmoji,
        taskTitle: nextTask.taskTitle,
      }
    : nextSingle
      ? { kind: "single", itemId: nextSingle.itemId, text: nextSingle.text }
      : null;

  const existingSession: ExistingPausedSession | null = openSession?.pausedAt
    ? {
        id: openSession.id,
        plannedMin: openSession.plannedMin,
        totalSec: openSession.plannedMin * 60,
        remainingSec: remainingSecForSession(
          {
            plannedMin: openSession.plannedMin,
            startedAt: openSession.startedAt.getTime(),
            pausedAt: openSession.pausedAt.getTime(),
            accumulatedPausedMs: openSession.accumulatedPausedMs,
          },
          // eslint-disable-next-line react-hooks/purity -- async Server Component: this runs once per request on the server, not in a compiler-memoised client render.
          Date.now(),
        ),
      }
    : null;

  return (
    <FocusTimer
      step={{
        id: step.id,
        text: step.text,
        estMinutes: step.estMinutes,
        subtaskEmoji: step.subtaskEmoji,
        order: step.order,
        total: step.total,
        done: step.done,
      }}
      steps={steps.map((s) => ({
        id: s.id,
        text: s.text,
        done: s.done,
        estMinutes: s.estMinutes,
        subtaskEmoji: s.subtaskEmoji,
      }))}
      taskId={step.taskId}
      taskTitle={step.task.title}
      parentEmoji={step.task.parentEmoji}
      streak={dashboard.currentStreak}
      focusMinToday={dashboard.focusMinToday}
      nextStep={
        nextStep
          ? {
              id: nextStep.id,
              text: nextStep.text,
              subtaskEmoji: nextStep.subtaskEmoji,
            }
          : null
      }
      nextUp={nextUp}
      isSingleTask={step.total <= 1}
      addTimeIncrementMin={settings.addTimeIncrementMin}
      settings={{
        timerStyle: settings.focusTimerStyle,
        minimalMode: settings.focusMinimalMode,
        keepAwake: settings.focusKeepAwake,
        alarmEnabled: settings.focusAlarmEnabled,
        sound: settings.focusSound,
        shuffle: settings.focusShuffle,
        pauseTogether: settings.focusPauseTogether,
      }}
      tipDismissed={settings.focusTimerTipDismissedAt != null}
      existingSession={existingSession}
    />
  );
}
