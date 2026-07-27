import { notFound } from "next/navigation";
import { prisma, getSettings } from "@/lib/db";
import { currentWorkspaceId } from "@/lib/workspace";
import { getDashboardData } from "@/lib/rewards";
import {
  FocusTimer,
  type ExistingPausedSession,
} from "@/components/focus/focus-timer";
import { remainingSecForSession } from "@/lib/focus-timer-clock";

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

  const [settings, dashboard, steps, nextStep, openSession] = await Promise.all(
    [
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
    ],
  );

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
      isSingleTask={step.total <= 1}
      addTimeIncrementMin={settings.addTimeIncrementMin}
      settings={{
        timerStyle: settings.focusTimerStyle,
        minimalMode: settings.focusMinimalMode,
        keepAwake: settings.focusKeepAwake,
        alarmEnabled: settings.focusAlarmEnabled,
        sound: settings.focusSound,
        shuffle: settings.focusShuffle,
      }}
      tipDismissed={settings.focusTimerTipDismissedAt != null}
      existingSession={existingSession}
    />
  );
}
