// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";

// --- Server-side deps: stubbed so the async server component runs in jsdom ---
const settingsFixture = {
  voice: "plain" as const,
  agingThresholdMinutes: 45,
  demoOverrideSeconds: null,
  agingHours: 24,
  overdueHours: 48,
  wayOverdueHours: 72,
  firstRunPreview: false,
  breakdownModel: null,
  completeStrikethrough: true,
  completeTickColor: "green",
  typeface: "system",
  notifyRoundup: false,
  notifyAging: false,
  notifyDailyReview: false,
  dailyReviewNudgeTime: "17:00",
  focusTimerStyle: "bar",
  focusMinimalMode: false,
  focusKeepAwake: false,
  focusAlarmEnabled: false,
  focusSound: "chime",
};

const isOwnerRequest = vi.fn().mockResolvedValue(true);
const voiceOverride = vi.fn<() => "plain" | "playful">(() => "plain");

vi.mock("@/lib/db", () => ({
  getSettings: vi.fn().mockImplementation(async () => ({
    ...settingsFixture,
    voice: voiceOverride(),
  })),
}));
vi.mock("@/lib/workspace", () => ({
  currentWorkspaceId: vi.fn().mockResolvedValue("ws-test"),
  isOwnerRequest: () => isOwnerRequest(),
  // #35 Phase B — the page resolves the identity once and derives `owner` from
  // its role, so the mock has to answer with a user, not just a boolean.
  currentUser: async () =>
    (await isOwnerRequest())
      ? { id: "u-owner", role: "owner", workspaceId: "ws-test" }
      : null,
}));
vi.mock("@/lib/google", () => ({
  getGoogleStatus: vi.fn().mockResolvedValue(null),
}));
vi.mock("@/lib/people", () => ({
  loadPeopleAdmin: vi.fn().mockResolvedValue(null),
}));

// --- Heavy child components: stubbed to keep the test on the page footer ---
vi.mock("@/components/settings/settings-panel", () => ({
  SettingsPanel: () => null,
}));
vi.mock("@/components/settings/notifications-section", () => ({
  NotificationsSection: () => null,
}));
vi.mock("@/components/settings/appearance-section", () => ({
  AppearanceSection: () => null,
}));
vi.mock("@/components/settings/focus-timer-section", () => ({
  FocusTimerSection: () => null,
}));
vi.mock("@/components/settings/integrations-panel", () => ({
  IntegrationsPanel: () => null,
}));
vi.mock("@/components/settings/people-panel", () => ({
  PeoplePanel: () => null,
}));
vi.mock("@/components/nav/back-link", () => ({ BackLink: () => null }));

// Plain anchor stub — avoids needing router context and keeps the assertion on
// the page's own JSX (the children it hands to <Link>).
vi.mock("next/link", () => ({
  default: ({
    href,
    children,
    ...rest
  }: {
    href: string;
    children: React.ReactNode;
  }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

import SettingsPage from "@/app/(app)/settings/page";

afterEach(() => {
  cleanup();
  voiceOverride.mockReturnValue("plain");
});

describe("SettingsPage footer help link", () => {
  it('renders "Help & Docs" — dedicated string, casing + spacing intact', async () => {
    const ui = await SettingsPage({ searchParams: Promise.resolve({}) });
    render(ui);

    const link = screen.getByRole("link", { name: /docs/i });
    expect(link).toHaveAttribute("href", "/help?from=settings");
    // Exact text lock — guards against the "Help& docs" (dropped space) and
    // "Help & docs" (lowercase, from reusing the nav.help label) regressions.
    expect(link.textContent).toBe("Help & Docs");
  });

  it('renders "🆘 Help & Docs" in the playful voice', async () => {
    voiceOverride.mockReturnValue("playful");
    const ui = await SettingsPage({ searchParams: Promise.resolve({}) });
    render(ui);

    const link = screen.getByRole("link", { name: /docs/i });
    expect(link.textContent).toBe("🆘 Help & Docs");
  });
});
