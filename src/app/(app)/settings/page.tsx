import Link from "next/link";
import { getSettings } from "@/lib/db";
import { currentWorkspaceId, isOwnerRequest } from "@/lib/workspace";
import { SettingsPanel } from "@/components/inbox/settings-panel";
import { t, type Voice } from "@/lib/strings";

// DB-backed, always fresh.
export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const workspaceId = await currentWorkspaceId();
  const [settings, owner] = await Promise.all([
    getSettings(workspaceId),
    isOwnerRequest(),
  ]);
  const voice: Voice = settings.voice === "playful" ? "playful" : "plain";

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold">{t("nav.settings", voice)}</h1>
      <SettingsPanel
        settings={{
          agingThresholdMinutes: settings.agingThresholdMinutes,
          demoOverrideSeconds: settings.demoOverrideSeconds,
          agingHours: settings.agingHours,
          overdueHours: settings.overdueHours,
          wayOverdueHours: settings.wayOverdueHours,
        }}
        isOwner={owner}
        breakdownModel={settings.breakdownModel ?? null}
        voice={voice}
      />
      <Link href="/inbox" className="text-sm underline">
        {t("action.backToInbox", voice)}
      </Link>
    </div>
  );
}
