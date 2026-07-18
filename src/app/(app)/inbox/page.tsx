import { prisma, getSettings } from "@/lib/db";
import { currentWorkspaceId, isOwnerRequest } from "@/lib/workspace";
import { getGoogleStatus } from "@/lib/google";
import { BrainDumpStatus } from "@/lib/constants";
import { InboxView } from "@/components/inbox/inbox-view";

// DB-backed, always fresh.
export const dynamic = "force-dynamic";

export default async function InboxPage({
  searchParams,
}: {
  searchParams: Promise<{
    reclaim?: string;
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
              // A step is "resumable" if it has an unfinished focus session
              // (started, never ended). Batched by Prisma into one query per
              // relation, so this is not a per-step N+1.
              include: {
                focusSessions: { where: { endedAt: null }, select: { id: true }, take: 1 },
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
  // Owner-gated, same as the settings page's Integrations panel — guests get
  // null and every row's 📅 control is omitted.
  const google = owner ? googleStatus : null;

  const items = rawItems.map(({ task, ...item }) => ({
    ...item,
    stepsTotal: task?.steps.length ?? 0,
    stepsDone: task?.steps.filter((s) => s.done).length ?? 0,
    taskStatus: task?.status ?? null,
    completedAt: item.completedAt,
    scheduledAt: task?.scheduledAt ?? null,
    steps: task?.steps.map((s) => ({
      id: s.id,
      order: s.order,
      text: s.text,
      done: s.done,
      estMinutes: s.estMinutes,
      subtaskEmoji: s.subtaskEmoji,
      resumable: s.focusSessions.length > 0,
    })) ?? [],
  }));

  return (
    <div className="space-y-4">
      {sp.reclaim === "connected" && (
        <div className="rounded-lg border border-green-600/30 bg-green-600/10 px-4 py-2 text-sm font-medium text-green-700">
          ✅ Reclaim connected — you can now schedule task breakdowns onto your
          calendar.
        </div>
      )}
      {sp.reclaim === "error" && (
        <div className="rounded-lg border border-red-600/30 bg-red-600/10 px-4 py-2 text-sm text-red-700">
          Reclaim connection failed{sp.reason ? `: ${sp.reason}` : ""}. You can
          try again from a task breakdown.
        </div>
      )}
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
        initialItems={items}
        settings={{
          agingThresholdMinutes: settings.agingThresholdMinutes,
          demoOverrideSeconds: settings.demoOverrideSeconds,
          agingHours: settings.agingHours,
          overdueHours: settings.overdueHours,
          wayOverdueHours: settings.wayOverdueHours,
        }}
        google={google}
        notifyAging={settings.notifyAging}
      />
    </div>
  );
}
