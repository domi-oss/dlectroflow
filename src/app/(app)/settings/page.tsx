import Link from "next/link";
import { getSettings } from "@/lib/db";
import { currentWorkspaceId, isOwnerRequest } from "@/lib/workspace";
import { getGoogleStatus } from "@/lib/google";
import { SettingsPanel } from "@/components/settings/settings-panel";
import { modelChoicesForProvider } from "@/lib/models";
import { NotificationsSection } from "@/components/settings/notifications-section";
import { AppearanceSection } from "@/components/settings/appearance-section";
import { FocusTimerSection } from "@/components/settings/focus-timer-section";
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
      <BackLink from={from} voice={voice} />

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
        // #59 — env-driven (LLM_PROVIDER); must be resolved server-side and
        // passed as a prop so SSR and client hydration see the same value
        // (a client component can't safely read non-NEXT_PUBLIC_ env vars).
        modelChoices={modelChoicesForProvider()}
        activeModelName={process.env.LLM_MODEL ?? null}
        voice={voice}
      />
      <div className="border-t pt-4">
        <AppearanceSection
          completeStrikethrough={settings.completeStrikethrough}
          completeTickColor={settings.completeTickColor}
          typeface={settings.typeface}
          voice={voice}
        />
      </div>
      <div className="border-t pt-4">
        <NotificationsSection
          notifyRoundup={settings.notifyRoundup}
          notifyAging={settings.notifyAging}
          notifyDailyReview={settings.notifyDailyReview}
          dailyReviewNudgeTime={settings.dailyReviewNudgeTime}
          voice={voice}
        />
      </div>
      <div className="border-t pt-4">
        <FocusTimerSection
          timerStyle={settings.focusTimerStyle}
          minimalMode={settings.focusMinimalMode}
          keepAwake={settings.focusKeepAwake}
          alarmEnabled={settings.focusAlarmEnabled}
          sound={settings.focusSound}
          voice={voice}
        />
      </div>
      {owner && google ? (
        <IntegrationsPanel google={google} />
      ) : !owner ? (
        // #11 — guests see the integrations section as a read-only owner-only
        // shell (no owner status fetched or shown).
        <div className="border-t pt-4">
          <IntegrationsPanel google={null} readOnly voice={voice} />
        </div>
      ) : // Owner but no status object (shouldn't happen; getGoogleStatus always
      // returns one) — render nothing, matching the pre-#11 behaviour rather
      // than showing an owner the guest shell.
      null}
      <div className="flex gap-4 text-sm">
        <Link href="/help?from=settings" className="underline">
          {t("settings.helpDocs", voice)}
        </Link>
      </div>
    </div>
  );
}
