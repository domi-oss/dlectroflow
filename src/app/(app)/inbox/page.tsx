import { prisma, getSettings } from "@/lib/db";
import { currentWorkspaceId, isOwnerRequest } from "@/lib/workspace";
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
  const [items, settings, owner, sp] = await Promise.all([
    prisma.brainDumpItem.findMany({
      where: { workspaceId, status: { not: BrainDumpStatus.Archived } },
      orderBy: { createdAt: "desc" },
    }),
    getSettings(workspaceId),
    isOwnerRequest(),
    searchParams,
  ]);

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
        }}
        isOwner={owner}
        breakdownModel={settings.breakdownModel ?? null}
      />
    </div>
  );
}
