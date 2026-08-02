import Link from "next/link";
import { getSettings } from "@/lib/db";
import { currentWorkspaceId, currentUser } from "@/lib/workspace";
import { getGoogleStatus } from "@/lib/google";
import { loadPeopleAdmin } from "@/lib/people";
import { ownLlmKeyPresent } from "@/app/actions/account";
import { PeoplePanel } from "@/components/settings/people-panel";
import { AgingSection } from "@/components/settings/aging-section";
import { VoiceSection } from "@/components/settings/voice-section";
import { BreakdownModelSection } from "@/components/settings/breakdown-model-section";
import { DemoSection } from "@/components/settings/demo-section";
import { randomFableLine } from "@/lib/fable-lines";
import {
  modelChoicesForProvider,
  resolveUtilityModel,
  resolveBreakdownModel,
} from "@/lib/models";
import { NotificationsSection } from "@/components/settings/notifications-section";
import { AppearanceSection } from "@/components/settings/appearance-section";
import { FocusTimerSection } from "@/components/settings/focus-timer-section";
import { IntegrationsPanel } from "@/components/settings/integrations-panel";
import { AccountPanel } from "@/components/settings/account-panel";
import { PURGE_GRACE_DAYS } from "@/lib/account-lifecycle";
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
  const [google, people, keyPresent] = await Promise.all([
    // #118 Phase C — every signed-in account has its own connection, so this is
    // resolved for whoever is asking. A caller with no account is passed null
    // and getGoogleStatus() answers without a query.
    getGoogleStatus(meId),
    // Still owner-only. loadPeopleAdmin re-checks the role itself and returns
    // null for anyone else, so the panel cannot render for a member even if this
    // call site were ever changed to drop the gate.
    owner ? loadPeopleAdmin(me?.id) : Promise.resolve(null),
    // #118 — PRESENCE only, and it derives the account from the session itself:
    // there is no id to pass, which is why the ciphertext can never be read for
    // somebody else. Answers false without a query for a caller with no account.
    ownLlmKeyPresent(),
  ]);
  const voice: Voice = settings.voice === "playful" ? "playful" : "plain";
  // Relative times ("2h ago") are rendered from ONE timestamp so the server and
  // the client agree — the convention library-row-meta.tsx follows.
  // eslint-disable-next-line react-hooks/purity -- async Server Component: this runs once per request on the server, not in a compiler-memoised client render.
  const now = Date.now();

  // #72 + #118 — the nav lists what this render actually put on the page. Both
  // presentations of the Integrations section render something now (your own
  // panel, or the signed-out shell), so it is always listed; People remains
  // owner-only and Account needs an account, so a caller without either never
  // gets a link that jumps nowhere.
  const sections = SETTINGS_SECTIONS.filter(
    (section) =>
      (section.id !== "settings-people" || people != null) &&
      (section.id !== "settings-account" || me != null),
  );

  return (
    <div className="space-y-4">
      <BackLink from={from} voice={voice} />

      <h1 className="text-xl font-semibold">{t("nav.settings", voice)}</h1>
      {/* #131 — the same `from` goes to both back controls: the one above, which
          scrolls away with the header, and the compact copy the sticky bar
          carries for everywhere below the fold. */}
      <SectionNav
        sections={sections}
        voice={voice}
        label="Settings sections"
        from={from}
      />
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
      <div className="border-t pt-4">
        {me ? (
          // #118 Phase C — YOUR OWN connection, owner or member alike. Was
          // `owner && google`, with a member falling into the guest shell below
          // and no way to reach the connect flow from the UI at all.
          <IntegrationsPanel google={google} voice={voice} />
        ) : (
          // #11 — a caller with no account sees the section EXISTS, read-only,
          // with no status fetched and none shown.
          <IntegrationsPanel google={null} readOnly voice={voice} />
        )}
      </div>
      {/* #118 Phase C — your own account: the per-user LLM key. Signed-in only;
          there is nothing here for a caller with no account to see or set, and
          the section is filtered out of the nav to match. */}
      {me && (
        <div className="border-t pt-4">
          <AccountPanel
            handle={me.handle}
            provider={me.provider}
            keyPresent={keyPresent}
            // #118 — the model a member's OWN-KEY breakdown actually resolves
            // to, not resolveUtilityModel(). The utility model (Opus on
            // anthropic) serves the spark/rollup calls; llmKeyEnc pays for
            // BREAKDOWNS, which #96 resolves to the owner-grade default for an
            // account on its own key. Naming the utility model here would put a
            // model id on screen that no request of theirs ever uses.
            activeModelName={resolveBreakdownModel({
              tier: "member",
              hasOwnKey: true,
            })}
            // #153 — the owner is refused a self-serve deletion (the action
            // refuses it too; this only decides whether they are shown a
            // control that could never succeed). The window is resolved here
            // because @/lib/account-lifecycle imports Prisma, so a client
            // component must be handed the number rather than import it.
            isOwner={owner}
            purgeGraceDays={PURGE_GRACE_DAYS}
            voice={voice}
          />
        </div>
      )}
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
