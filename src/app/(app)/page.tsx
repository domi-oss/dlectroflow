import { prisma, getSettings } from "@/lib/db";
import { currentWorkspaceId, isOwnerRequest } from "@/lib/workspace";
import { getGoogleStatus } from "@/lib/google";
import { BrainDumpStatus } from "@/lib/constants";
import { InboxView } from "@/components/inbox/inbox-view";
import { firstResumableStep } from "@/components/inbox/resume-step";

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
  const [rawItems, settings, sp, owner, googleStatus] = await Promise.all([
    prisma.brainDumpItem.findMany({
      where: { workspaceId, status: { not: BrainDumpStatus.Archived } },
      orderBy: { createdAt: "desc" },
      include: {
        task: {
          include: {
            steps: {
              orderBy: { order: "asc" },
              // #27 — a step is "resumable" if it has a TRULY PAUSED focus
              // session (pausedAt set), not merely an open one — an open-but-
              // never-paused session is stale (e.g. a closed tab mid-
              // countdown) and isn't offered as resumable. Batched by Prisma
              // into one query per relation, so this is not a per-step N+1.
              include: {
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
    searchParams,
    isOwnerRequest(),
    // Fetched in parallel and discarded for guests, so owner page-load latency
    // stays flat (Duo review: was a serial round-trip after the Promise.all).
    getGoogleStatus(),
  ]);
  // The owner's Google status (null for guests, same as the settings
  // Integrations panel) — resolved once at the server boundary (S1 seam, #34).
  // When F (#35) makes Google per-user, only this owner-gate + the provider's
  // isAvailable() change, not the InboxView call site.
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
        welcomeVisible={welcomeVisible}
        resumeStep={firstRun ? null : resumeStep}
        notifyAging={settings.notifyAging}
      />
    </div>
  );
}
