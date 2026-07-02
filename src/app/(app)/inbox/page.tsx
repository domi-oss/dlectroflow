import { prisma, getSettings } from "@/lib/db";
import { BrainDumpStatus } from "@/lib/constants";
import { InboxView } from "@/components/inbox/inbox-view";

// DB-backed, always fresh.
export const dynamic = "force-dynamic";

export default async function InboxPage() {
  const [items, settings] = await Promise.all([
    prisma.brainDumpItem.findMany({
      where: { status: { not: BrainDumpStatus.Archived } },
      orderBy: { createdAt: "desc" },
    }),
    getSettings(),
  ]);

  return (
    <InboxView
      initialItems={items}
      settings={{
        agingThresholdMinutes: settings.agingThresholdMinutes,
        demoOverrideSeconds: settings.demoOverrideSeconds,
      }}
    />
  );
}
