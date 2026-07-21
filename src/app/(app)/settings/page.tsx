import Link from "next/link";
import { getSettings } from "@/lib/db";
import { currentWorkspaceId, isOwnerRequest } from "@/lib/workspace";
import { getGoogleStatus } from "@/lib/google";
import { SettingsPanel } from "@/components/settings/settings-panel";
import { NotificationsSection } from "@/components/settings/notifications-section";
import { IntegrationsPanel } from "@/components/settings/integrations-panel";
import { BackLink } from "@/components/nav/back-link";
import { t, type Voice } from "@/lib/strings";

// DB-backed, always fresh.
export const dynamic = "force-dynamic";

export default async function SettingsPage({
  searchParams,
}: {
  searchParams: Promise<{ from?: string }>;
}) {
  const workspaceId = await currentWorkspaceId();
  const { from } = await searchParams;
  const [settings, owner] = await Promise.all([
    getSettings(workspaceId),
    isOwnerRequest(),
  ]);
  const google = owner ? await getGoogleStatus() : null;
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
          firstRunPreview: settings.firstRunPreview,
        }}
        isOwner={owner}
        breakdownModel={settings.breakdownModel ?? null}
        voice={voice}
      />
      <div className="border-t pt-4">
        <NotificationsSection
          notifyRoundup={settings.notifyRoundup}
          notifyAging={settings.notifyAging}
          notifyDailyReview={settings.notifyDailyReview}
          dailyReviewNudgeTime={settings.dailyReviewNudgeTime}
          voice={voice}
        />
      </div>
      {owner && google && <IntegrationsPanel google={google} />}
      <div className="flex gap-4 text-sm">
        <Link href="/help?from=settings" className="underline">
          {t("nav.help", voice)} &amp; docs
        </Link>
        <BackLink from={from} voice={voice} />
      </div>
    </div>
  );
}
