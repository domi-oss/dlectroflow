import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/db";
import { BreakdownChat } from "@/components/breakdown/breakdown-chat";
import { getReclaimStatus } from "@/lib/reclaim";
import { getGoogleStatus } from "@/lib/google";
import type { Proposal } from "@/lib/breakdown";

export const dynamic = "force-dynamic";

export default async function TaskPage({
  params,
  searchParams,
}: {
  params: Promise<{ taskId: string }>;
  searchParams: Promise<{ edit?: string }>;
}) {
  const { taskId } = await params;
  const { edit } = await searchParams;
  const [task, reclaim, google] = await Promise.all([
    prisma.task.findUnique({
      where: { id: taskId },
      include: { steps: { orderBy: { order: "asc" } } },
    }),
    getReclaimStatus(),
    getGoogleStatus(),
  ]);
  if (!task) notFound();

  const hasSteps = task.steps.length > 0;
  const editing = edit === "1" || !hasSteps;

  // Editing / generating the breakdown.
  if (editing) {
    const initialProposal: Proposal | null = hasSteps
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

  // Working view: focus on the steps.
  const doneCount = task.steps.filter((s) => s.done).length;
  const nextStep = task.steps.find((s) => !s.done);

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">
          {task.parentEmoji ? `${task.parentEmoji} ` : ""}
          {task.title}
        </h1>
        <Link href="/inbox" className="text-muted-foreground text-sm hover:underline">
          ← inbox
        </Link>
      </div>

      <p className="text-muted-foreground text-sm">
        {doneCount}/{task.steps.length} done
        {nextStep && (
          <>
            {" · next up: "}
            <span className="text-foreground">{nextStep.text}</span>
          </>
        )}
      </p>

      <ol className="space-y-2">
        {task.steps.map((s) => (
          <li
            key={s.id}
            className="flex items-center gap-3 rounded-lg border px-3 py-2"
          >
            <span className="text-muted-foreground w-8 text-xs tabular-nums">
              {s.order}/{s.total}
            </span>
            <span className={s.done ? "flex-1 text-muted-foreground line-through" : "flex-1"}>
              {s.subtaskEmoji ? `${s.subtaskEmoji} ` : ""}
              {s.text}
            </span>
            <span className="text-muted-foreground text-xs">{s.estMinutes}m</span>
            {s.done ? (
              <span className="text-green-600" title="done">✓</span>
            ) : (
              <Link
                href={`/focus/${s.id}`}
                className="bg-primary text-primary-foreground rounded-md px-3 py-1 text-sm font-medium"
              >
                ▶ Focus
              </Link>
            )}
          </li>
        ))}
      </ol>

      <div className="flex gap-4 text-sm">
        <Link href={`/tasks/${task.id}?edit=1`} className="text-muted-foreground hover:underline">
          ↻ Refine breakdown / schedule
        </Link>
      </div>
    </div>
  );
}
