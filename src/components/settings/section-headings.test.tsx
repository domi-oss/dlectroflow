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
}));
vi.mock("@/app/actions/google-schedule", () => ({
  disconnectGoogleTasks: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/notifications", () => ({
  registerServiceWorker: vi.fn().mockResolvedValue(null),
  notificationPermission: () => "default",
  requestNotificationPermission: vi.fn().mockResolvedValue("granted"),
  subscribeNotificationPermission: () => () => {},
}));

import { SettingsPanel } from "@/components/settings/settings-panel";
import { AppearanceSection } from "@/components/settings/appearance-section";
import { NotificationsSection } from "@/components/settings/notifications-section";
import { FocusTimerSection } from "@/components/settings/focus-timer-section";
import { IntegrationsPanel } from "@/components/settings/integrations-panel";

/** Every Settings section, rendered the way the page renders them. */
function AllSections({ voice = "plain" as Voice }) {
  return (
    <>
      <SettingsPanel
        settings={{
          agingThresholdMinutes: 45,
          demoOverrideSeconds: null,
          agingHours: 24,
          overdueHours: 48,
          wayOverdueHours: 72,
          firstRunPreview: false,
        }}
        isOwner
        breakdownModel={null}
        modelChoices={[{ id: "sonnet", label: "Sonnet" }]}
        voice={voice}
      />
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
        sound="chime"
        voice={voice}
      />
      <IntegrationsPanel
        google={{ configured: true, connected: false, needsReconnect: false }}
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
