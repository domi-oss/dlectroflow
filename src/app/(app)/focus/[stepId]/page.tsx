import { notFound } from "next/navigation";
import { prisma, getSettings } from "@/lib/db";
import { focusStatsToday } from "@/app/actions/focus";
import { FocusTimer } from "@/components/focus/focus-timer";

export const dynamic = "force-dynamic";

export default async function FocusPage({
  params,
}: {
  params: Promise<{ stepId: string }>;
}) {
  const { stepId } = await params;
  const step = await prisma.step.findUnique({
    where: { id: stepId },
    include: { task: true },
  });
  if (!step) notFound();

  const [settings, stats, nextStep] = await Promise.all([
    getSettings(),
    focusStatsToday(),
    prisma.step.findFirst({
      where: { taskId: step.taskId, done: false, order: { gt: step.order } },
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
