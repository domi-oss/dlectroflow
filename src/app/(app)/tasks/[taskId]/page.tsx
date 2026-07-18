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
  // `Object.hasOwn` (not just truthiness of the lookup) matters here: BACK_TARGETS
  // is a plain object, so `from` values like "__proto__" / "constructor" /
  // "toString" resolve to inherited Object.prototype members — truthy, but
  // missing `.href` / `.labelKey`, which would otherwise 500 the page below.
  const backTarget =
    from && Object.hasOwn(BACK_TARGETS, from) ? BACK_TARGETS[from] : DEFAULT_BACK_TARGET;

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
        scheduled={task.scheduledAt != null}
      />
    );
  }

  // Working view: focus on the steps.
  const doneCount = task.steps.filter((s) => s.done).length;
  const nextStep = task.steps.find((s) => !s.done);

  return (
    <div className="space-y-5">
      {/* Origin-aware back breadcrumb, promoted to the top of the page (!83
          top redesign) — it used to sit isolated at the bottom, far from the
          actions it relates to. `backTarget` is resolved above from the
          whitelist-guarded `from` query param; label + href are unchanged. */}
      <Link
        href={backTarget.href}
        className="text-muted-foreground hover:text-foreground inline-flex items-center text-sm"
      >
        ← {t(backTarget.labelKey, voice)}
      </Link>

      {/* Distinct task-view header (!83 top redesign, owner: "Both") — a
          bordered card + small "Task" eyebrow so this open-task view reads as
          clearly distinct from the Library hub's plain (unboxed) header at a
          glance, using only existing tokens (border/rounded-lg, the same
          "card" shape as the Done rows + empty-state on the Library page).
          The Refine/Schedule row lives inside it, directly under the meta
          line, per the owner's #1 request. */}
      <div className="space-y-3 rounded-lg border p-4">
        <p className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
          {t("task.eyebrow", voice)}
        </p>
        <h1 className="text-2xl font-semibold">
          {task.parentEmoji ? `${task.parentEmoji} ` : ""}
          {task.title}
        </h1>

        <p className="text-muted-foreground text-sm">
          {doneCount}/{task.steps.length} done
          {nextStep && (
            <>
              {" · next up: "}
              <span className="text-foreground">{nextStep.text}</span>
            </>
          )}
        </p>

        {/* Refine breakdown + Schedule share one left-aligned row (owner
            styling tweak on !83) — both styled as bordered buttons matching
            the Library's "Select" button (lib.select: "hover:bg-accent
            rounded-md border px-2.5 py-1 text-sm"). Refine breakdown drops
            its old ↻ glyph (follow-up owner ask: clean text, no icon) — the
            Schedule button keeps its 📅 (owner: functional glyphs stay in
            Plain voice). The "Scheduled ✓ / Not scheduled yet" indicator
            stays a plain inline status inside <TaskSchedule>, not a button.
            Moved here from the bottom of the page on !83 (owner #1): same
            row, same behavior, only its position changed. */}
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <Link
            href={`/tasks/${task.id}?edit=1`}
            className="hover:bg-accent rounded-md border px-2.5 py-1"
          >
            Refine breakdown
          </Link>

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
    </div>
  );
}
