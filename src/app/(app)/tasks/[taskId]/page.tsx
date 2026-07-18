import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma, getSettings } from "@/lib/db";
import { currentWorkspaceId, isOwnerRequest } from "@/lib/workspace";
import { BreakdownChat } from "@/components/breakdown/breakdown-chat";
import { TaskSteps } from "@/components/breakdown/task-steps";
import { TaskSchedule } from "@/components/breakdown/task-schedule";
import { getReclaimStatus } from "@/lib/reclaim";
import { getGoogleStatus } from "@/lib/google";
import { t, type StringKey, type Voice } from "@/lib/strings";
import type { Proposal } from "@/lib/breakdown";

export const dynamic = "force-dynamic";

// Whitelisted `from` origins → the task page's back-link destination + label
// (#8 follow-up — the Library "Open task" link used to strand users on
// /inbox). Deliberately a closed map: an unknown/absent `from` always falls
// back to /inbox rather than reflecting the query value into a path, so this
// can never become an open redirect.
const BACK_TARGETS: Record<string, { href: string; labelKey: StringKey }> = {
  // Library's Multi-step ("sorted") tab is the only place that currently
  // deep-links in with `?from=`, so this is the only non-default entry.
  library: { href: "/library?tab=sorted", labelKey: "action.backToLibrary" },
};
const DEFAULT_BACK_TARGET: { href: string; labelKey: StringKey } = {
  href: "/inbox",
  labelKey: "action.backToInbox",
};

export default async function TaskPage({
  params,
  searchParams,
}: {
  params: Promise<{ taskId: string }>;
  searchParams: Promise<{ edit?: string; manual?: string; from?: string }>;
}) {
  const workspaceId = await currentWorkspaceId();
  const { taskId } = await params;
  const { edit, manual, from } = await searchParams;
  const [task, reclaim, google, owner, settings] = await Promise.all([
    prisma.task.findFirst({
      where: { id: taskId, workspaceId },
      include: {
        steps: {
          orderBy: { order: "asc" },
          // Resumable = has an unfinished focus session (started, never ended).
          // Batched by Prisma into one query, so not a per-step N+1.
          include: {
            focusSessions: { where: { endedAt: null }, select: { id: true }, take: 1 },
          },
        },
      },
    }),
    getReclaimStatus(),
    getGoogleStatus(),
    isOwnerRequest(),
    getSettings(workspaceId),
  ]);
  if (!task) notFound();

  const voice: Voice = settings.voice === "playful" ? "playful" : "plain";
  const backTarget = (from && BACK_TARGETS[from]) || DEFAULT_BACK_TARGET;

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
        startManual={manual === "1"}
        reclaimConnected={reclaim.connected}
        google={google}
        isGuest={!owner}
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
        <Link href={backTarget.href} className="text-muted-foreground text-sm hover:underline">
          ← {t(backTarget.labelKey, voice)}
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

      <TaskSteps
        taskId={task.id}
        steps={task.steps.map((s) => ({
          id: s.id,
          order: s.order,
          total: s.total,
          text: s.text,
          subtaskEmoji: s.subtaskEmoji,
          estMinutes: s.estMinutes,
          done: s.done,
          resumable: s.focusSessions.length > 0,
        }))}
      />

      <div className="space-y-3">
        <div className="flex gap-4 text-sm">
          <Link href={`/tasks/${task.id}?edit=1`} className="text-muted-foreground hover:underline">
            ↻ Refine breakdown
          </Link>
        </div>

        {/* Split out of the old merged "Refine breakdown / schedule" link
            (#8 follow-up) — this control actually schedules, reusing the
            Inbox's ScheduleControl + owner/guest wiring verbatim. */}
        <TaskSchedule
          taskId={task.id}
          scheduledAt={task.scheduledAt}
          google={owner ? google : null}
          voice={voice}
        />
      </div>
    </div>
  );
}
