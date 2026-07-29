import Link from "next/link";
import { getSettings } from "@/lib/db";
import { currentWorkspaceId, currentUser } from "@/lib/workspace";
import { getGoogleStatus } from "@/lib/google";
import { loadPeopleAdmin } from "@/lib/people";
import { PeoplePanel } from "@/components/settings/people-panel";
import { AgingSection } from "@/components/settings/aging-section";
import { VoiceSection } from "@/components/settings/voice-section";
import { BreakdownModelSection } from "@/components/settings/breakdown-model-section";
import { DemoSection } from "@/components/settings/demo-section";
import { randomFableLine } from "@/lib/fable-lines";
import { modelChoicesForProvider, resolveUtilityModel } from "@/lib/models";
import { NotificationsSection } from "@/components/settings/notifications-section";
import { AppearanceSection } from "@/components/settings/appearance-section";
import { FocusTimerSection } from "@/components/settings/focus-timer-section";
import { IntegrationsPanel } from "@/components/settings/integrations-panel";
import { BackLink } from "@/components/nav/back-link";
import { SectionNav } from "@/components/nav/section-nav";
import { SETTINGS_SECTIONS } from "@/lib/section-nav";
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
  // #35 Phase B — one identity resolution for the whole render. `currentUser()`
  // is what isOwnerRequest() is implemented in terms of, so reading it directly
  // gives the role AND the id the People panel needs to mark the owner's own row
  // without a second database round trip.
  const [settings, me] = await Promise.all([
    getSettings(workspaceId),
    currentUser(),
  ]);
  const owner = me?.role === "owner";
  // #118 Phase C — getGoogleStatus() resolves ONE account's connection, so it
  // needs the acting account's id. A narrowed local rather than `me!`: the
  // signature already accepts null (a caller with no account is answered without
  // a query), so no non-null assertion is needed at all.
  const meId = me?.id ?? null;
  // Both owner-only reads. loadPeopleAdmin re-checks the role itself and returns
  // null for anyone else, so the panel cannot render for a member even if this
  // call site were ever changed to drop the gate.
  const [google, people] = await Promise.all([
    owner ? getGoogleStatus(meId) : Promise.resolve(null),
    owner ? loadPeopleAdmin(me?.id) : Promise.resolve(null),
  ]);
  const voice: Voice = settings.voice === "playful" ? "playful" : "plain";
  // Relative times ("2h ago") are rendered from ONE timestamp so the server and
  // the client agree — the convention library-row-meta.tsx follows.
  // eslint-disable-next-line react-hooks/purity -- async Server Component: this runs once per request on the server, not in a compiler-memoised client render.
  const now = Date.now();

  // #72 — the nav must list what this render actually put on the page. Two
  // sections are conditional (see the branches below): an owner with no status
  // object gets a nav without a dead "Integrations" anchor, and People is
  // owner-only, so a guest never gets a link that jumps nowhere.
  const showIntegrations = owner ? google != null : true;
  const sections = SETTINGS_SECTIONS.filter(
    (section) =>
      (section.id !== "settings-integrations" || showIntegrations) &&
      (section.id !== "settings-people" || people != null),
  );

  return (
    <div className="space-y-4">
      <BackLink from={from} voice={voice} />

      <h1 className="text-xl font-semibold">{t("nav.settings", voice)}</h1>
      <SectionNav sections={sections} voice={voice} label="Settings sections" />
      {/* #101 — frequency of use descending, administration last, and every
          section is a disclosure (see <CollapsibleSection>). The order here and
          the order in SETTINGS_SECTIONS are the same list twice over: the nav is
          built from the registry, so a section moved in one place and not the
          other shows up as a nav that jumps backwards.
          ONE section arrives expanded — the first. The owner's call: the page
          should read as a scannable list of titles, but not as an empty page. It
          is stated here, at the composition site, because "which section greets
          you" is a fact about page ORDER rather than about the timer. */}
      {/* No `border-t` on the first section only: the nav bar above already draws
          a `border-b`, and the two rules 16px apart read as a mistake. */}
      <div>
        <FocusTimerSection
          timerStyle={settings.focusTimerStyle}
          minimalMode={settings.focusMinimalMode}
          keepAwake={settings.focusKeepAwake}
          alarmEnabled={settings.focusAlarmEnabled}
          sound={settings.focusSound}
          pauseTogether={settings.focusPauseTogether}
          voice={voice}
          defaultExpanded
        />
      </div>
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
        <VoiceSection voice={voice} />
      </div>
      <div className="border-t pt-4">
        <AgingSection
          settings={{
            agingThresholdMinutes: settings.agingThresholdMinutes,
            demoOverrideSeconds: settings.demoOverrideSeconds,
            agingHours: settings.agingHours,
            overdueHours: settings.overdueHours,
            wayOverdueHours: settings.wayOverdueHours,
          }}
          voice={voice}
        />
      </div>
      <div className="border-t pt-4">
        <BreakdownModelSection
          isOwner={owner}
          breakdownModel={settings.breakdownModel ?? null}
          // #59 — env-driven (LLM_PROVIDER); must be resolved server-side and
          // passed as a prop so SSR and client hydration see the same value
          // (a client component can't safely read non-NEXT_PUBLIC_ env vars).
          modelChoices={modelChoicesForProvider()}
          // Resolve via the same owner-model path resolveBreakdownModel/
          // resolveUtilityModel use, not a raw env read — LLM_MODEL alone
          // misreports when an owner/guest split (LLM_OWNER_MODEL) is set.
          activeModelName={resolveUtilityModel()}
          voice={voice}
          // Rolled here, on the server, so SSR and hydration see the same line.
          fable={randomFableLine()}
        />
      </div>
      {owner && google ? (
        <div className="border-t pt-4">
          <IntegrationsPanel google={google} voice={voice} />
        </div>
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
      <div className="border-t pt-4">
        <DemoSection firstRunPreview={settings.firstRunPreview} voice={voice} />
      </div>
      {/* Administration closes the page: it is not what should greet you on your
          own settings page (#101). Owner-only — loadPeopleAdmin returns null for
          anyone else, so a guest gets no section and no nav entry. */}
      {people && (
        <div className="border-t pt-4">
          <PeoplePanel view={people} now={now} voice={voice} />
        </div>
      )}
      <div className="flex gap-4 text-sm">
        <Link href="/help?from=settings" className="underline">
          {t("settings.helpDocs", voice)}
        </Link>
      </div>
    </div>
  );
}
