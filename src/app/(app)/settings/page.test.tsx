// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";

// --- Server-side deps: stubbed so the async server component runs in jsdom ---
const settingsFixture = {
  voice: "plain" as const,
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

// #118 Phase C — the page's Integrations branch is now "signed in → your own
// panel, no account → the read-only shell", so the identity mock has to be able
// to answer MEMBER as well as owner and guest. Derived from isOwnerRequest by
// default so the existing owner/guest specs above are untouched.
const OWNER_USER = { id: "u-owner", role: "owner", workspaceId: "ws-test" };
const MEMBER_USER = {
  id: "u-member",
  role: "member",
  workspaceId: "ws-member",
};
const userOverride = vi.fn<() => Promise<object | null>>(async () =>
  (await isOwnerRequest()) ? OWNER_USER : null,
);
const ownLlmKeyPresentMock = vi.fn<() => Promise<boolean>>(async () => false);
// #154 — the page reads the acting account's feed at the server boundary. The
// module's own rules (mint, rotate, the capability lookup) are covered in
// calendar-feed.test.ts and calendar-feed.integration.test.ts.
const ownFeedMock = vi.fn<() => Promise<{ token: string } | null>>(
  async () => null,
);

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
  currentUser: () => userOverride(),
}));
vi.mock("@/lib/google", () => ({
  getGoogleStatus: vi.fn().mockResolvedValue(null),
}));
vi.mock("@/lib/people", () => ({
  loadPeopleAdmin: vi.fn().mockResolvedValue(null),
}));
// `feedUrl` is the REAL one: "the page hands the panel an absolute URL" is a
// thing worth asserting, and a stub would make it pass whatever the page built.
vi.mock("@/lib/calendar-feed", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/calendar-feed")>();
  return { feedUrl: actual.feedUrl, getOwnFeed: () => ownFeedMock() };
});

// --- Heavy child components: stubbed down to a marker each ---------------
// The markers keep the footer assertions cheap AND make the page's own job
// testable: it composes nine sections in ONE order, and #101 made that order
// (and which single section arrives expanded) a decision worth locking down.
function stub(id: string) {
  const Stub = ({ defaultExpanded }: { defaultExpanded?: boolean }) => (
    <div
      data-stub={id}
      data-default-expanded={String(Boolean(defaultExpanded))}
    />
  );
  Stub.displayName = `Stub(${id})`;
  return Stub;
}
vi.mock("@/components/settings/aging-section", () => ({
  AgingSection: stub("settings-aging"),
}));
vi.mock("@/components/settings/voice-section", () => ({
  VoiceSection: stub("settings-voice"),
}));
vi.mock("@/components/settings/breakdown-model-section", () => ({
  BreakdownModelSection: stub("settings-breakdown-model"),
}));
vi.mock("@/components/settings/demo-section", () => ({
  DemoSection: stub("settings-demo"),
}));
vi.mock("@/components/settings/shopping-section", () => ({
  ShoppingSection: stub("settings-shopping"),
}));
vi.mock("@/components/settings/notifications-section", () => ({
  NotificationsSection: stub("settings-notifications"),
}));
vi.mock("@/components/settings/appearance-section", () => ({
  AppearanceSection: stub("settings-appearance"),
}));
vi.mock("@/components/settings/focus-timer-section", () => ({
  FocusTimerSection: stub("settings-focus-timer"),
}));
// #118 — this stub records the two props the page's branch decides: whether the
// panel is the read-only shell, and WHOSE status it was handed. The real panel's
// own copy and a11y are covered in integrations-panel.test.tsx.
vi.mock("@/components/settings/integrations-panel", () => ({
  IntegrationsPanel: ({
    defaultExpanded,
    readOnly,
    google,
    calendarFeedUrl,
  }: {
    defaultExpanded?: boolean;
    readOnly?: boolean;
    google?: unknown;
    calendarFeedUrl?: string | null;
  }) => (
    <div
      data-stub="settings-integrations"
      data-default-expanded={String(Boolean(defaultExpanded))}
      data-read-only={String(Boolean(readOnly))}
      data-google={google == null ? "null" : "status"}
      data-calendar-feed={calendarFeedUrl ?? "null"}
    />
  ),
}));
vi.mock("@/components/settings/people-panel", () => ({
  PeoplePanel: stub("settings-people"),
}));
vi.mock("@/components/settings/account-panel", () => ({
  AccountPanel: stub("settings-account"),
}));
// #118 — the page reads key PRESENCE at the server boundary. Mocked so this stays
// a unit test; the action's own rules are covered in src/app/actions/account.test.ts.
vi.mock("@/app/actions/account", () => ({
  // Wrapped in a lambda, like the workspace mock above: a vi.mock factory is
  // hoisted above the const declarations, so naming the mock directly would read
  // it before initialisation.
  ownLlmKeyPresent: () => ownLlmKeyPresentMock(),
}));
// Rendered as an inert marker rather than a real link: this file's assertions
// are about which sections the page composes, and the control's own behaviour
// (the `?from=` whitelist, the label, the focus ring) belongs to
// back-link.test.tsx. A <span> keeps it out of every getByRole("link") query
// while still recording the two props the PAGE decides — which copy this is,
// and the origin it was handed (#131).
vi.mock("@/components/nav/back-link", () => ({
  BackLink: ({
    from,
    variant = "page",
  }: {
    from?: string;
    variant?: string;
  }) => <span data-back-link={variant} data-from={from ?? ""} />,
}));

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
import { SETTINGS_SECTIONS } from "@/lib/section-nav";
import { getGoogleStatus } from "@/lib/google";
import { loadPeopleAdmin } from "@/lib/people";

/** Render the page as the owner of a fully-populated instance: all nine sections. */
async function renderWholePage() {
  vi.mocked(getGoogleStatus).mockResolvedValueOnce({
    configured: true,
    connected: false,
    needsReconnect: false,
  });
  vi.mocked(loadPeopleAdmin).mockResolvedValueOnce({
    people: [],
    invitations: [],
    windowHours: 720,
  });
  render(await SettingsPage({ searchParams: Promise.resolve({}) }));
  return Array.from(document.querySelectorAll("[data-stub]"));
}

afterEach(() => {
  cleanup();
  // Call history is per-test: these are module-level mocks, so without this a
  // `not.toHaveBeenCalledWith(...)` assertion would be about the whole file's
  // history rather than about the render under test.
  vi.mocked(getGoogleStatus).mockClear();
  vi.mocked(loadPeopleAdmin).mockClear();
  ownLlmKeyPresentMock.mockClear();
  ownLlmKeyPresentMock.mockResolvedValue(false);
  voiceOverride.mockReturnValue("plain");
  userOverride.mockImplementation(async () =>
    (await isOwnerRequest()) ? OWNER_USER : null,
  );
  isOwnerRequest.mockResolvedValue(true);
});

/** The recorded Integrations stub, or null if the page rendered none. */
function integrationsStub() {
  return document.querySelector('[data-stub="settings-integrations"]');
}

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

describe("SettingsPage section composition (#101)", () => {
  it("renders every section in the REGISTRY's order — the nav is built from it", async () => {
    // The nav's entries come from SETTINGS_SECTIONS; the page renders the
    // components. Reorder one and not the other and the nav jumps backwards,
    // which is the drift #101 had to correct in the first place (People was
    // listed first because it WAS first).
    const stubs = await renderWholePage();
    expect(stubs.map((el) => el.getAttribute("data-stub"))).toEqual(
      SETTINGS_SECTIONS.map((s) => s.id),
    );
  });

  it("opens exactly ONE section on arrival, and it is the first", async () => {
    // Owner's call: a scannable list of titles, but not an empty page.
    const stubs = await renderWholePage();
    const expanded = stubs
      .filter((el) => el.getAttribute("data-default-expanded") === "true")
      .map((el) => el.getAttribute("data-stub"));
    expect(expanded).toEqual([SETTINGS_SECTIONS[0].id]);
    expect(expanded).toEqual(["settings-focus-timer"]);
  });

  it("closes the page with administration, not with it", async () => {
    const stubs = await renderWholePage();
    expect(stubs.at(-1)!.getAttribute("data-stub")).toBe("settings-people");
  });
});

// ── #131 — there is ONE way home, and it is always on screen ────────────────
//
// #131 originally shipped two copies of the same control: a page-level "← Back"
// above the heading, plus one folded into the "Jump to…" bar. The reason was
// that the page-level one scrolls away with the header, leaving no exit at the
// bottom of a long page.
//
// The bar solved that by being `sticky top-0` — which also means its copy is on
// screen at the TOP, next to the page-level one. So the pair only ever rendered
// together, 40px apart, offering the identical destination twice; the second
// copy did not add reach, it added a duplicate. The page-level one is gone and
// the sticky one is the single exit, at every scroll position including zero.
//
// What the page still owes it is the origin, which was always the substance of
// #131 — an exit that forgets where you came from sends the reader somewhere
// the other copy would not have.
describe("SettingsPage back control (#131)", () => {
  /** Every back control the page renders, in document order. */
  function backControls() {
    return Array.from(document.querySelectorAll("[data-back-link]"));
  }

  it("renders exactly one back control, and it is the sticky one", async () => {
    render(await SettingsPage({ searchParams: Promise.resolve({}) }));
    expect(
      backControls().map((el) => el.getAttribute("data-back-link")),
    ).toEqual(["bar"]);
    // It lives inside the bar, which is the whole point: the bar is the only
    // part of the page's chrome still on screen once you have scrolled.
    const nav = screen.getByRole("navigation", { name: "Settings sections" });
    expect(nav.querySelector('[data-back-link="bar"]')).not.toBeNull();
  });

  it("hands the surviving copy the origin", async () => {
    render(
      await SettingsPage({ searchParams: Promise.resolve({ from: "help" }) }),
    );
    expect(backControls().map((el) => el.getAttribute("data-from"))).toEqual([
      "help",
    ]);
  });

  it("passes an absent origin through untouched — the component owns the fallback", async () => {
    // The inbox fallback and the whitelist are resolved once, in <BackLink>
    // (back-link.test.tsx). The page must not grow a second opinion about it.
    render(await SettingsPage({ searchParams: Promise.resolve({}) }));
    expect(backControls().map((el) => el.getAttribute("data-from"))).toEqual([
      "",
    ]);
  });
});

// ── #118 Phase C — a member manages their OWN connection ───────────────────
//
// A member used to get the identical 🔒 owner-only shell a guest gets
// (settings/page.tsx's `owner && google` / `!owner` branch), so the one account
// type this phase exists for had no way to reach the connect flow from the UI at
// all. The branch is now "signed in → your own panel, no account → the shell".
describe("SettingsPage — Integrations is per-account (#118)", () => {
  it("gives a MEMBER the real Integrations panel, not the owner-only shell", async () => {
    isOwnerRequest.mockResolvedValue(false);
    userOverride.mockResolvedValue(MEMBER_USER);
    vi.mocked(getGoogleStatus).mockResolvedValueOnce({
      configured: true,
      connected: false,
      needsReconnect: false,
    });

    render(await SettingsPage({ searchParams: Promise.resolve({}) }));

    const panel = integrationsStub();
    expect(panel).not.toBeNull();
    expect(panel!.getAttribute("data-read-only")).toBe("false");
    expect(panel!.getAttribute("data-google")).toBe("status");
  });

  it("resolves the status for the member's OWN id", async () => {
    isOwnerRequest.mockResolvedValue(false);
    userOverride.mockResolvedValue(MEMBER_USER);
    render(await SettingsPage({ searchParams: Promise.resolve({}) }));
    expect(getGoogleStatus).toHaveBeenCalledWith("u-member");
    expect(getGoogleStatus).not.toHaveBeenCalledWith("u-owner");
  });

  it("still gives a caller with NO ACCOUNT the read-only shell and no status", async () => {
    isOwnerRequest.mockResolvedValue(false);
    userOverride.mockResolvedValue(null);

    render(await SettingsPage({ searchParams: Promise.resolve({}) }));

    const panel = integrationsStub();
    expect(panel!.getAttribute("data-read-only")).toBe("true");
    expect(panel!.getAttribute("data-google")).toBe("null");
    // null, not an id — getGoogleStatus answers without a query, so a guest's
    // settings page load touches the credential table not at all (#118).
    expect(getGoogleStatus).toHaveBeenCalledWith(null);
  });

  // #154 — the calendar feed URL is resolved on the SERVER and handed down as a
  // prop. That is the whole reason the capability token never has to travel
  // through a client fetch: the only browser it ever reaches is the one
  // rendering the page for the account it belongs to.
  it("hands the panel an ABSOLUTE feed URL for an account that has one", async () => {
    isOwnerRequest.mockResolvedValue(false);
    userOverride.mockResolvedValue(MEMBER_USER);
    ownFeedMock.mockResolvedValue({ token: "T".repeat(43) });
    process.env.PUBLIC_ORIGIN = "https://dlectroflow.dev";

    render(await SettingsPage({ searchParams: Promise.resolve({}) }));

    expect(integrationsStub()!.getAttribute("data-calendar-feed")).toBe(
      `https://dlectroflow.dev/api/ics/feed/${"T".repeat(43)}`,
    );
  });

  it("hands it null when the account has not turned a feed on", async () => {
    isOwnerRequest.mockResolvedValue(false);
    userOverride.mockResolvedValue(MEMBER_USER);
    ownFeedMock.mockResolvedValue(null);

    render(await SettingsPage({ searchParams: Promise.resolve({}) }));

    expect(integrationsStub()!.getAttribute("data-calendar-feed")).toBe("null");
  });

  it("does not query the feed at all for a caller with no account", async () => {
    // A guest sandbox expires in about a day, so it can never have a feed —
    // and a settings page load by somebody with no account should not touch the
    // credential table, the same rule #118 set for the Google status.
    isOwnerRequest.mockResolvedValue(false);
    userOverride.mockResolvedValue(null);
    ownFeedMock.mockClear();

    render(await SettingsPage({ searchParams: Promise.resolve({}) }));

    expect(ownFeedMock).not.toHaveBeenCalled();
    expect(integrationsStub()!.getAttribute("data-calendar-feed")).toBe("null");
  });

  it("lists Integrations in the section nav for a member", async () => {
    // showIntegrations was `owner ? google != null : true`, which a member fell
    // through in the wrong direction once they stopped being "not owner".
    isOwnerRequest.mockResolvedValue(false);
    userOverride.mockResolvedValue(MEMBER_USER);
    render(await SettingsPage({ searchParams: Promise.resolve({}) }));
    expect(
      screen.getByRole("link", { name: /integrations/i }),
    ).toBeInTheDocument();
  });

  it("renders the panel for an owner even when no status object came back", async () => {
    // The old branch had a third arm ("owner but no status → render nothing")
    // that could only fire if getGoogleStatus lied. It always returns an object,
    // so the arm is gone and `me` is the only condition.
    userOverride.mockResolvedValue(OWNER_USER);
    vi.mocked(getGoogleStatus).mockResolvedValueOnce(
      null as unknown as Awaited<ReturnType<typeof getGoogleStatus>>,
    );
    render(await SettingsPage({ searchParams: Promise.resolve({}) }));
    expect(integrationsStub()!.getAttribute("data-read-only")).toBe("false");
  });
});

// ── #118 Phase C — the Account section (your own LLM key) ──────────────────
describe("SettingsPage — Account section (#118)", () => {
  it("renders for a signed-in MEMBER and is listed in the nav", async () => {
    isOwnerRequest.mockResolvedValue(false);
    userOverride.mockResolvedValue(MEMBER_USER);
    render(await SettingsPage({ searchParams: Promise.resolve({}) }));
    expect(
      document.querySelector('[data-stub="settings-account"]'),
    ).not.toBeNull();
    expect(screen.getByRole("link", { name: /account/i })).toBeInTheDocument();
  });

  it("is absent from the page AND the nav for a caller with no account", async () => {
    // There is nothing here for a guest to see or set, so a nav link would jump
    // nowhere — the same rule People follows.
    isOwnerRequest.mockResolvedValue(false);
    userOverride.mockResolvedValue(null);
    render(await SettingsPage({ searchParams: Promise.resolve({}) }));
    expect(document.querySelector('[data-stub="settings-account"]')).toBeNull();
    expect(screen.queryByRole("link", { name: /^account$/i })).toBeNull();
  });

  it("reads key presence without being handed an id", async () => {
    // ownLlmKeyPresent() derives the account from the session; the page has no
    // way to ask about somebody else's key because there is no parameter for it.
    ownLlmKeyPresentMock.mockResolvedValue(true);
    userOverride.mockResolvedValue(MEMBER_USER);
    render(await SettingsPage({ searchParams: Promise.resolve({}) }));
    expect(ownLlmKeyPresentMock).toHaveBeenCalledWith();
  });
});
