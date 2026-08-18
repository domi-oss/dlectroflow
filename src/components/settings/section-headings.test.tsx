// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { SETTINGS_SECTIONS, sectionLabel } from "@/lib/section-nav";
import type { Voice } from "@/lib/strings";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));
vi.mock("@/app/actions/settings", () => ({
  updateAgingSettings: vi.fn().mockResolvedValue(undefined),
  updateBreakdownModel: vi.fn().mockResolvedValue(undefined),
  updateVoice: vi.fn().mockResolvedValue(undefined),
  updateFirstRunPreview: vi.fn().mockResolvedValue(undefined),
  updateAppearanceSettings: vi.fn().mockResolvedValue(undefined),
  updateNotificationSettings: vi.fn().mockResolvedValue(undefined),
  updateFocusTimerSettings: vi.fn().mockResolvedValue(undefined),
  updateShoppingList: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/app/actions/google-schedule", () => ({
  disconnectGoogleTasks: vi.fn().mockResolvedValue(undefined),
}));
// All three exports, not only the two this file exercises. `AccountPanel` is
// rendered here with `isOwner={false}`, which since #153 renders `DeleteAccount`
// and pulls `deleteOwnAccount` in from the same module — a factory mock replaces
// the module wholesale, so an omitted export is `undefined` rather than absent.
// Nothing here triggers the delete flow, so it passes either way today; the cost
// lands on whoever adds that interaction and gets "not a function" instead of a
// failing assertion. Raised in review on !237.
// #252 — `saveDisplayName` is here because the panel REACHES it
// (`DisplayNameField`), the same reason `deleteOwnAccount` is. A factory mock
// replaces the module wholesale, so an omission is `undefined` at call time
// rather than a failing assertion — this file is the second site !237 names for
// exactly that.
vi.mock("@/app/actions/account", () => ({
  saveOwnLlmKey: vi.fn().mockResolvedValue({ ok: true }),
  removeOwnLlmKey: vi.fn().mockResolvedValue({ ok: true }),
  deleteOwnAccount: vi.fn().mockResolvedValue({ ok: true }),
  saveDisplayName: vi.fn().mockResolvedValue({ ok: true }),
}));
vi.mock("@/app/actions/people", () => ({
  invitePerson: vi.fn().mockResolvedValue({ ok: true }),
  withdrawInvitation: vi.fn().mockResolvedValue({ ok: true }),
  updatePersonAiPolicy: vi.fn().mockResolvedValue({ ok: true }),
  revokePerson: vi.fn().mockResolvedValue({ ok: true }),
}));
vi.mock("@/lib/notifications", () => ({
  registerServiceWorker: vi.fn().mockResolvedValue(null),
  notificationPermission: () => "default",
  requestNotificationPermission: vi.fn().mockResolvedValue("granted"),
  subscribeNotificationPermission: () => () => {},
}));

import { AgingSection } from "@/components/settings/aging-section";
import { VoiceSection } from "@/components/settings/voice-section";
import { BreakdownModelSection } from "@/components/settings/breakdown-model-section";
import { DemoSection } from "@/components/settings/demo-section";
import { ShoppingSection } from "@/components/settings/shopping-section";
import { AppearanceSection } from "@/components/settings/appearance-section";
import { NotificationsSection } from "@/components/settings/notifications-section";
import { FocusTimerSection } from "@/components/settings/focus-timer-section";
import { IntegrationsPanel } from "@/components/settings/integrations-panel";
import { AccountPanel } from "@/components/settings/account-panel";
import { PeoplePanel } from "@/components/settings/people-panel";

/**
 * Every Settings section, rendered the way the page renders them.
 *
 * People (#35 Phase B) is owner-only and Account (#118 Phase C) is signed-in
 * only on the real page; both are rendered here because this suite's contract is
 * "every REGISTERED section has a real jump target", and the registry is what the
 * nav is built from.
 */
// A fixed clock rather than Date.now(): this helper renders like a component, so
// reading the real clock here trips react-hooks/purity, and nothing in the suite
// depends on the value.
const NOW = new Date("2026-07-28T12:00:00.000Z").getTime();

function AllSections({ voice = "plain" as Voice }) {
  return (
    <>
      <PeoplePanel
        view={{ people: [], invitations: [], windowHours: 720 }}
        now={NOW}
        voice={voice}
      />
      <AgingSection
        settings={{
          agingHours: 24,
          overdueHours: 48,
          wayOverdueHours: 72,
        }}
        voice={voice}
      />
      <VoiceSection voice={voice} />
      <BreakdownModelSection
        isOwner
        breakdownModel={null}
        modelChoices={[{ id: "sonnet", label: "Sonnet" }]}
        voice={voice}
      />
      <ShoppingSection shoppingList={false} voice={voice} />
      <DemoSection firstRunPreview={false} voice={voice} />
      <AppearanceSection
        completeStrikethrough
        completeTickColor="green"
        typeface="figtree"
        voice={voice}
      />
      <NotificationsSection
        notifyRoundup
        notifyAging
        notifyDailyReview={false}
        dailyReviewNudgeTime="17:00"
        voice={voice}
      />
      <FocusTimerSection
        timerStyle="bar"
        minimalMode={false}
        keepAwake={false}
        alarmEnabled={false}
        sound="off"
        pauseTogether={false}
        quickAccess
        voice={voice}
      />
      <IntegrationsPanel
        google={{ configured: true, connected: false, needsReconnect: false }}
        voice={voice}
      />
      <AccountPanel
        handle="owner"
        displayName={null}
        provider="gitlab"
        keyPresent={false}
        activeModelName="claude-sonnet-4-6"
        isOwner={false}
        purgeGraceDays={30}
        voice={voice}
      />
    </>
  );
}

beforeEach(() => {
  const store = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
    clear: () => store.clear(),
  });
  class FakeAudio {
    loop = false;
    currentTime = 0;
    volume = 1;
    onended: (() => void) | null = null;
    play = vi.fn().mockResolvedValue(undefined);
    pause = vi.fn();
    constructor(public src: string) {}
  }
  vi.stubGlobal("Audio", FakeAudio as unknown as typeof Audio);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("Settings section headings (#72)", () => {
  it("renders a real jump target for EVERY registered settings section", () => {
    render(<AllSections />);
    for (const section of SETTINGS_SECTIONS) {
      const heading = document.getElementById(section.id);
      expect(heading, `no heading rendered for #${section.id}`).not.toBeNull();
      expect(heading!.tagName).toBe("H2");
      // The nav label and the heading come from the same registry entry, so a
      // rename moves both or neither.
      expect(heading!.textContent).toContain(sectionLabel(section, "plain"));
      expect(heading).toHaveAttribute("data-section-target");
      expect(heading).toHaveAttribute("tabindex", "-1");
    }
  });

  it("normalises the three old <h2> weights to one treatment", () => {
    // Before #72: text-lg (appearance/notifications/integrations), text-sm
    // (focus timer) and an unsized font-semibold (the settings-panel sections)
    // — three visual weights for one semantic level.
    render(<AllSections />);
    const headings = Array.from(document.querySelectorAll("h2"));
    expect(headings.length).toBe(SETTINGS_SECTIONS.length);
    for (const h of headings) {
      expect(h).toHaveClass("text-lg");
      expect(h).toHaveClass("font-semibold");
      expect(h).not.toHaveClass("text-sm");
    }
  });

  it("keeps section headings on the app voice", () => {
    render(<AllSections voice="playful" />);
    expect(document.getElementById("settings-appearance")).toHaveTextContent(
      "🎨 Appearance",
    );
    expect(document.getElementById("settings-focus-timer")).toHaveTextContent(
      "⏱️ Focus timer",
    );
  });

  it("keeps the trailing badges out of nothing — heading text still reads cleanly", () => {
    render(<AllSections />);
    // "Aging & reminder" carries an inline save indicator; the heading must
    // still start with its own name rather than the badge.
    expect(
      screen.getByRole("heading", { name: /^Aging & reminder/ }),
    ).toBeInTheDocument();
  });
});
