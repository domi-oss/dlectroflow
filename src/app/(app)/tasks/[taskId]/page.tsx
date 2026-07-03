import { notFound } from "next/navigation";
import { prisma } from "@/lib/db";
import { BreakdownChat } from "@/components/breakdown/breakdown-chat";
import { getReclaimStatus } from "@/lib/reclaim";
import { getGoogleStatus } from "@/lib/google";
import type { Proposal } from "@/lib/breakdown";

export const dynamic = "force-dynamic";

export default async function TaskPage({
  params,
}: {
  params: Promise<{ taskId: string }>;
}) {
  const { taskId } = await params;
  const [task, reclaim, google] = await Promise.all([
    prisma.task.findUnique({
      where: { id: taskId },
      include: { steps: { orderBy: { order: "asc" } } },
    }),
    getReclaimStatus(),
    getGoogleStatus(),
  ]);
  if (!task) notFound();

  const initialProposal: Proposal | null = task.steps.length
    ? {
        parentEmoji: task.parentEmoji ?? "🗂️",
        steps: task.steps.map((s) => ({
          text: s.text,
          estMinutes: s.estMinutes,
          subtaskEmoji: s.subtaskEmoji ?? "•",
        })),
      }
    : null;

  return (
    <BreakdownChat
      taskId={task.id}
      title={task.title}
      initialProposal={initialProposal}
      reclaimConnected={reclaim.connected}
      google={google}
    />
  );
}
