import { notFound } from "next/navigation";
import { prisma, getSettings } from "@/lib/db";
import { currentWorkspaceId } from "@/lib/workspace";
import { focusStatsToday } from "@/app/actions/focus";
import { FocusTimer } from "@/components/focus/focus-timer";

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

  const [settings, stats, nextStep] = await Promise.all([
    getSettings(workspaceId),
    focusStatsToday(),
    prisma.step.findFirst({
      where: { taskId: step.taskId, done: false, order: { gt: step.order }, task: { workspaceId } },
      orderBy: { order: "asc" },
    }),
  ]);

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
      taskId={step.taskId}
      taskTitle={step.task.title}
      parentEmoji={step.task.parentEmoji}
      addTimeIncrementMin={settings.addTimeIncrementMin}
      initialStats={stats}
      nextStepId={nextStep?.id ?? null}
    />
  );
}
