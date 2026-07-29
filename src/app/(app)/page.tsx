import { prisma, getSettings } from "@/lib/db";
import { currentWorkspaceId, currentUser } from "@/lib/workspace";
import { getGoogleStatus } from "@/lib/google";
import { BrainDumpStatus, UserRole } from "@/lib/constants";
import { InboxView } from "@/components/inbox/inbox-view";
import { firstResumableStep } from "@/components/inbox/resume-step";
import { openSessionRemainingSec } from "@/lib/focus-timer-clock";
import { mergePersistedIntent } from "@/lib/scheduling/intent";
import type { ScheduleIntent } from "@/lib/scheduling/types";

// DB-backed, always fresh.
export const dynamic = "force-dynamic";

export default async function InboxPage({
  searchParams,
}: {
  searchParams: Promise<{
    google?: string;
    reason?: string;
  }>;
}) {
  const workspaceId = await currentWorkspaceId();
  // One request-time clock — also snapshots each step's persisted remaining
  // time (#27 follow-up), matching the Library page's same-request approach.
  // eslint-disable-next-line react-hooks/purity -- async Server Component: this runs once per request on the server, not in a compiler-memoised client render.
  const now = Date.now();
  // #118 — ONE identity resolution, awaited inside the batch. isOwnerRequest()
  // is implemented in terms of currentUser(), so this is the same query it made,
  // and chaining the status off it keeps page-load latency flat.
  const mePromise = currentUser();
  const [rawItems, settings, sp, me, googleStatus] = await Promise.all([
    prisma.brainDumpItem.findMany({
      where: { workspaceId, status: { not: BrainDumpStatus.Archived } },
      orderBy: { createdAt: "desc" },
      include: {
        task: {
          include: {
            steps: {
              orderBy: { order: "asc" },
              // #27 follow-up — fetch ANY open session (paused or actively
              // running); `resumable` is derived from `pausedAt` below
              // (an open-but-never-paused session is stale — e.g. a closed
              // tab mid-countdown — and isn't offered as resumable), and the
              // full row also feeds the step's effective remaining time
              // (task-remaining.ts) for the row's total + active-step pills.
              // Batched by Prisma into one query per relation, so this is
              // not a per-step N+1.
              include: {
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
        },
      },
    }),
    getSettings(workspaceId),
    searchParams,
    mePromise,
    // Resolved for the ACTING user, in parallel so page-load latency stays flat
    // (Duo review: this was once a serial round-trip after the Promise.all). A
    // guest/anonymous caller is passed null, which short-circuits before any
    // query at all — getAuth() used to be an upsert, so an anonymous page load
    // MATERIALISED the credential row (#118).
    mePromise.then((u) => getGoogleStatus(u ? u.id : null)),
  ]);
  const owner = me?.role === UserRole.Owner;
  // Resolved once at the server boundary (S1 seam, #34). Task 5 of #118 changes
  // this line to `me ? googleStatus : null`; it is left owner-gated here so this
  // commit ships no behaviour change and a member still falls back to .ics.
  const google = owner ? googleStatus : null;

  const items = rawItems.map(({ task, ...item }) => ({
    ...item,
    stepsTotal: task?.steps.length ?? 0,
    stepsDone: task?.steps.filter((s) => s.done).length ?? 0,
    taskStatus: task?.status ?? null,
    completedAt: item.completedAt,
    scheduledAt: task?.scheduledAt ?? null,
    estMinutes: item.estMinutes,
    steps:
      task?.steps.map((s) => {
        const session = s.focusSessions[0] ?? null;
        return {
          id: s.id,
          order: s.order,
          text: s.text,
          done: s.done,
          estMinutes: s.estMinutes,
          subtaskEmoji: s.subtaskEmoji,
          resumable: session?.pausedAt != null,
          openRemainingSec: openSessionRemainingSec(session, now),
        };
      }) ?? [],
  }));

  // #106 — the Schedule menu's prefill for every row that can open it, built
  // HERE rather than fetched per row: `rawItems` already carries each task's
  // three intent columns and its steps, so the alternative is one server-action
  // round trip per multi-step row on every inbox load. Only tasks WITH steps can
  // reach `ready_steps`, so nothing else needs an entry. Owner-only, mirroring
  // `google` above: a guest never sees the Google control at all.
  //
  // Built on the same mergePersistedIntent as loadScheduleIntent, so "what the
  // menu opens with" has one definition, not two that agree today.
  const scheduleIntents: Record<string, ScheduleIntent> = {};
  if (owner) {
    for (const { task } of rawItems) {
      if (!task || task.steps.length === 0) continue;
      scheduleIntents[task.id] = mergePersistedIntent(
        task.steps.map((s) => ({
          id: s.id,
          order: s.order,
          total: task.steps.length,
          text: s.text,
          emoji: s.subtaskEmoji,
          estMinutes: s.estMinutes,
          dueAt: null,
        })),
        task,
        new Date(now),
      );
    }
  }

  // Phase 5 (#8): the demo/first-run preview override shows the Inbox as a
  // brand-new workspace would see it (empty, welcome card, no resume banner)
  // without touching real data. welcomeVisible otherwise reflects whether the
  // workspace has ever dismissed the welcome card.
  const firstRun = settings.firstRunPreview;
  const welcomeVisible = firstRun || settings.welcomeDismissedAt == null;
  // Most-recent resumable, NOT-done step (open focus session) for the resume
  // banner — see resume-step.ts for why the !done guard matters.
  const resumeStep = firstResumableStep(items);

  return (
    <div className="space-y-4">
      {sp.google === "connected" && (
        <div className="rounded-lg border border-green-600/30 bg-green-600/10 px-4 py-2 text-sm font-medium text-green-700">
          ✅ Google Tasks connected — task breakdowns can now sync into Reclaim
          via your Google Tasks list.
        </div>
      )}
      {sp.google === "error" && (
        <div className="rounded-lg border border-red-600/30 bg-red-600/10 px-4 py-2 text-sm text-red-700">
          Google Tasks connection failed{sp.reason ? `: ${sp.reason}` : ""}. Try
          again from a task breakdown.
        </div>
      )}
      <InboxView
        initialItems={firstRun ? [] : items}
        settings={{
          agingThresholdMinutes: settings.agingThresholdMinutes,
          demoOverrideSeconds: settings.demoOverrideSeconds,
          agingHours: settings.agingHours,
          overdueHours: settings.overdueHours,
          wayOverdueHours: settings.wayOverdueHours,
        }}
        google={google}
        scheduleIntents={scheduleIntents}
        welcomeVisible={welcomeVisible}
        resumeStep={firstRun ? null : resumeStep}
        notifyAging={settings.notifyAging}
        // #105 — the same request-time clock used above, handed to the client
        // component so its FIRST render matches this one. Without it InboxView
        // read the wall clock again at hydration time, and any row younger than
        // a minute renders "Ns ago" from two different seconds: a text mismatch,
        // React error #418, and a regeneration from the root that silently
        // stripped the pre-hydration `dark` class off <html>.
        now={now}
      />
    </div>
  );
}
