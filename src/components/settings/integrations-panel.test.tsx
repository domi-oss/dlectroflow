// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const { disconnectMock } = vi.hoisted(() => ({ disconnectMock: vi.fn() }));
vi.mock("@/app/actions/google-schedule", () => ({
  disconnectGoogleTasks: disconnectMock,
}));
// #154 — the calendar feed card lives in this section now. Its own behaviour is
// covered in `calendar-feed.test.tsx`; here it only has to render.
vi.mock("@/app/actions/calendar-feed", () => ({
  createCalendarFeed: vi.fn(),
  regenerateCalendarFeed: vi.fn(),
  disableCalendarFeed: vi.fn(),
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));

import { IntegrationsPanel } from "./integrations-panel";
import { GOOGLE_ACCOUNT_HINT } from "@/components/integrations/google-account-hint";

beforeEach(() => {
  vi.clearAllMocks();
  // #126 — the action reports whether Google accepted the revoke. The happy
  // path is the default; the tests that care set their own.
  disconnectMock.mockResolvedValue({ ok: true, revoked: true });
});
afterEach(cleanup);

const base = { configured: true, connected: false, needsReconnect: false };

// #101 — the section is a disclosure; these specs are about the card inside it,
// so they render it open. Closed is asserted at the bottom of this file.

describe("IntegrationsPanel — Google card", () => {
  it("not connected → Connect link to the OAuth start route", () => {
    render(<IntegrationsPanel google={base} defaultExpanded />);
    expect(screen.getByText(/not connected/i)).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: /connect google/i }),
    ).toHaveAttribute("href", "/api/google/oauth/start");
  });

  it("connected → Connected pill + Disconnect", () => {
    render(
      <IntegrationsPanel
        google={{ ...base, connected: true }}
        defaultExpanded
      />,
    );
    expect(screen.getByText(/^connected$/i)).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /disconnect/i }),
    ).toBeInTheDocument();
  });

  it("needsReconnect → Reconnect pill + reconnect link", () => {
    render(
      <IntegrationsPanel
        google={{ ...base, needsReconnect: true }}
        defaultExpanded
      />,
    );
    expect(screen.getByText(/reconnect needed/i)).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: /reconnect google/i }),
    ).toHaveAttribute("href", "/api/google/oauth/start");
  });

  it("not configured → explains env vars, no actions", () => {
    render(
      <IntegrationsPanel
        google={{ ...base, configured: false }}
        defaultExpanded
      />,
    );
    expect(screen.getByText(/not configured/i)).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /connect/i })).toBeNull();
  });

  it("disconnect asks for confirmation before firing the action", async () => {
    render(
      <IntegrationsPanel
        google={{ ...base, connected: true }}
        defaultExpanded
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /disconnect/i }));
    expect(disconnectMock).not.toHaveBeenCalled(); // confirm step first
    fireEvent.click(screen.getByRole("button", { name: /yes, disconnect/i }));
    expect(disconnectMock).toHaveBeenCalledOnce();
  });
});

// ── #118 Phase C — the connection is YOURS ─────────────────────────────────
describe("IntegrationsPanel — per-user copy and a11y (#118)", () => {
  it("says the connection is YOURS, not the instance's", () => {
    render(
      <IntegrationsPanel
        google={{ ...base, connected: true }}
        defaultExpanded
      />,
    );
    // Copy matters here: a member reading "the owner's Google account" would
    // reasonably assume disconnecting affects somebody else.
    expect(screen.getByText(/your own google tasks/i)).toBeInTheDocument();
  });

  it("the read-only shell no longer claims the integration is owner-only", () => {
    // #118 — it is per-user now. The shell is for a caller with no ACCOUNT.
    render(<IntegrationsPanel google={null} readOnly defaultExpanded />);
    expect(screen.queryByText(/owner-only/i)).toBeNull();
    expect(screen.getAllByText(/sign in/i).length).toBeGreaterThan(0);
  });

  it("gives both destructive controls a 44x44 hit target (WCAG 2.5.5)", () => {
    render(
      <IntegrationsPanel
        google={{ ...base, connected: true }}
        defaultExpanded
      />,
    );
    const disconnect = screen.getByRole("button", { name: /^disconnect$/i });
    expect(disconnect.className).toContain("min-h-11");
    fireEvent.click(disconnect);
    for (const name of [/yes, disconnect/i, /^cancel$/i]) {
      const btn = screen.getByRole("button", { name });
      expect(btn.className, String(name)).toContain("min-h-11");
    }
  });

  it("announces the disconnect confirmation and wires it to the button", () => {
    render(
      <IntegrationsPanel
        google={{ ...base, connected: true }}
        defaultExpanded
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /^disconnect$/i }));
    // A confirmation that appears silently is a confirmation a screen-reader
    // user never learns about — and the destructive button has to SAY what it
    // is confirming, not just be next to the words.
    //
    // Located THROUGH the button's own `aria-describedby` rather than by a bare
    // `getByRole("status")`: #154 added a second live region to this section
    // (the calendar feed card's), and this direction is the stronger assertion
    // anyway — it proves the button points at an announced question rather than
    // that exactly one announced thing exists on the page.
    const confirm = screen.getByRole("button", { name: /yes, disconnect/i });
    const describedBy = confirm.getAttribute("aria-describedby");
    expect(describedBy).toBeTruthy();
    const status = document.getElementById(describedBy!);
    expect(
      status,
      "the confirm button describes a node that is not there",
    ).not.toBeNull();
    expect(status).toHaveAttribute("role", "status");
    expect(status).toHaveTextContent(/remove access/i);
  });

  it("keeps the Disconnect confirmation reachable and cancellable from the keyboard", async () => {
    const user = userEvent.setup();
    render(
      <IntegrationsPanel
        google={{ ...base, connected: true }}
        defaultExpanded
      />,
    );
    const disconnect = screen.getByRole("button", { name: /^disconnect$/i });
    disconnect.focus();
    await user.keyboard("{Enter}");
    expect(
      screen.getByRole("button", { name: /yes, disconnect/i }),
    ).toBeInTheDocument();

    // Cancel by keyboard, and focus must land somewhere real rather than on
    // <body> after the button that had it was unmounted.
    const cancel = screen.getByRole("button", { name: /^cancel$/i });
    cancel.focus();
    await user.keyboard("{Enter}");
    expect(disconnectMock).not.toHaveBeenCalled();
    expect(
      screen.getByRole("button", { name: /^disconnect$/i }),
    ).toBeInTheDocument();
    expect(document.activeElement).not.toBe(document.body);
  });
});

// ── #126 — when Google does not confirm the revoke ─────────────────────────
//
// The tokens are deleted here either way, so the disconnect DID happen and this
// is not an error. What is outstanding is a step only this person can take, on
// their own Google account — and they are the one the app was not telling. It
// is their own connection, so unlike the People panel there is nothing to
// withhold: say the real thing, in the same words /privacy uses.
describe("IntegrationsPanel — an unconfirmed revoke (#126)", () => {
  const PERMISSIONS_URL = "https://myaccount.google.com/permissions";

  async function disconnect() {
    render(
      <IntegrationsPanel
        google={{ ...base, connected: true }}
        defaultExpanded
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /^disconnect$/i }));
    fireEvent.click(screen.getByRole("button", { name: /yes, disconnect/i }));
  }

  it("says the grant may still be listed, and links where to remove it", async () => {
    disconnectMock.mockResolvedValue({ ok: true, revoked: false });
    await disconnect();

    expect(
      await screen.findByText(/may still be listed in your Google account/i),
    ).toBeInTheDocument();
    const link = screen.getByRole("link", { name: /permissions page/i });
    expect(link).toHaveAttribute("href", PERMISSIONS_URL);
    // Same rule the legal footer states and tests: no forced new tab. Nothing
    // here is lost by navigating away, so `target="_blank"` would only remove
    // the reader's choice and add an "opens in a new tab" announcement.
    expect(link).not.toHaveAttribute("target");
    // The Referer would otherwise tell Google which instance sent them.
    expect(link).toHaveAttribute("rel", expect.stringContaining("noreferrer"));
  });

  it("does not read as a failure — the disconnect here is reported as done", async () => {
    disconnectMock.mockResolvedValue({ ok: true, revoked: false });
    await disconnect();

    const notice = await screen.findByText(
      /may still be listed in your Google account/i,
    );
    // The tokens ARE gone; wording that implied otherwise would send someone
    // hunting for a Disconnect button that has already done its job.
    expect(notice).toHaveTextContent(/tokens stored here are deleted/i);
    // Announced politely, not as an alert. Nothing has gone wrong.
    expect(notice).toHaveAttribute("role", "status");
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("stays quiet when Google confirmed the revoke", async () => {
    await disconnect();

    expect(
      await screen.findByRole("button", { name: /^disconnect$/i }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("link", { name: /permissions page/i }),
    ).toBeNull();
    expect(
      screen.queryByText(/may still be listed in your Google account/i),
    ).toBeNull();
  });
});

describe("IntegrationsPanel — signed-out read-only shell (#11, #118)", () => {
  it("shows the integration exists + a sign-in label, with no actions", () => {
    render(
      <IntegrationsPanel
        google={null}
        readOnly
        voice="plain"
        defaultExpanded
      />,
    );
    // The integration is named so guests see what exists…
    expect(screen.getByText("Google Tasks")).toBeInTheDocument();
    // …flagged as needing an account (text, not colour alone). #118 changed the
    // WORD — the integration is per-user, not owner-only — not the rule.
    expect(screen.getAllByText(/sign in/i).length).toBeGreaterThan(0);
    // …and no interactive affordances.
    expect(screen.queryByRole("link", { name: /connect/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /disconnect/i })).toBeNull();
  });

  // #90 — regression lock. The card was dimmed with `opacity-70`, which
  // composited its muted copy and its "Owner-only" pill below WCAG-AA (2.74:1
  // – 4.42:1 depending on theme; needs 4.5:1) — the same mistake #56 fixed on
  // the saved-for-later row. The e2e guest contrast gate
  // (e2e/a11y/axe-guest-surfaces.spec.ts) measures the real ratios; this holds
  // the line cheaply at the unit level.
  it("never washes the read-only card in an opacity dim (AA)", () => {
    render(
      <IntegrationsPanel
        google={null}
        readOnly
        voice="plain"
        defaultExpanded
      />,
    );
    const card = screen.getByText("Google Tasks").closest("div.rounded-lg");
    // Assert the container was found before reading it: a bare `!` would turn a
    // markup restructure into an unreadable TypeError instead of naming the
    // cause (Duo review, !176).
    expect(
      card,
      "could not find the card container — has the markup changed?",
    ).not.toBeNull();
    expect(card!.className).not.toContain("opacity-");
  });

  it("never leaks anyone's real connection status to a signed-out caller", () => {
    render(
      <IntegrationsPanel
        google={null}
        readOnly
        voice="plain"
        defaultExpanded
      />,
    );
    expect(screen.queryByText(/^connected$/i)).toBeNull();
    expect(screen.queryByText(/not connected/i)).toBeNull();
    expect(screen.queryByText(/reconnect needed/i)).toBeNull();
  });
});

// #154 — the calendar subscription feed sits in this section, which is what the
// issue asked for ("surfaced in Settings next to the existing integrations").
// It is a genuine second integration and not a sub-feature of Google: it needs
// no OAuth and no Google account at all, which is the whole point of it.
describe("IntegrationsPanel — the calendar feed card (#154)", () => {
  it("renders the feed card alongside the Google one for a signed-in account", () => {
    render(
      <IntegrationsPanel
        google={base}
        calendarFeedUrl={null}
        defaultExpanded
      />,
    );
    expect(screen.getByText("Google Tasks")).toBeInTheDocument();
    expect(screen.getByTestId("calendar-feed-card")).toBeInTheDocument();
  });

  it("passes the account's URL through, so the card can show it", () => {
    const url = `https://dlectroflow.dev/api/ics/feed/${"A".repeat(43)}`;
    render(
      <IntegrationsPanel google={base} calendarFeedUrl={url} defaultExpanded />,
    );
    expect(
      (screen.getByLabelText(/calendar feed url/i) as HTMLInputElement).value,
    ).toBe(url);
  });

  it("shows the signed-out shell a feed exists, with no URL and no controls", () => {
    render(
      <IntegrationsPanel
        google={null}
        readOnly
        voice="plain"
        defaultExpanded
      />,
    );
    expect(screen.getByText(/calendar subscription/i)).toBeInTheDocument();
    // Nothing to copy and nothing to press: a guest sandbox expires in about a
    // day, so a subscription URL for one would be a link that quietly dies.
    expect(screen.queryByLabelText(/calendar feed url/i)).toBeNull();
    expect(
      screen.queryByRole("button", { name: /create a calendar feed/i }),
    ).toBeNull();
  });

  it("never washes the read-only feed card in an opacity dim (AA)", () => {
    // Same regression lock #90 put on the Google shell, applied to its sibling
    // so the two cards cannot drift apart.
    render(
      <IntegrationsPanel
        google={null}
        readOnly
        voice="plain"
        defaultExpanded
      />,
    );
    const card = screen
      .getByText(/calendar subscription/i)
      .closest("div.rounded-lg");
    expect(
      card,
      "could not find the feed card container — has the markup changed?",
    ).not.toBeNull();
    expect(card!.className).not.toContain("opacity-");
  });
});

describe("IntegrationsPanel — the disclosure (#101)", () => {
  it("rests collapsed for a signed-in account", () => {
    render(<IntegrationsPanel google={base} />);
    const trigger = document.querySelector(
      '[data-section-toggle="settings-integrations"]',
    )!;
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("link", { name: /connect google/i })).toBeNull();
  });

  it("rests collapsed in the signed-out shell too, badge and all", () => {
    render(<IntegrationsPanel google={null} readOnly voice="plain" />);
    const trigger = document.querySelector(
      '[data-section-toggle="settings-integrations"]',
    )!;
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    // The "you cannot act on this" read has to survive the section being closed,
    // because closed is how a guest first meets it (#11 + #90).
    expect(trigger.closest("[data-section-header]")!.textContent).toMatch(
      /sign in/i,
    );
  });
});

// ── #128 — which Google account to connect ───────────────────────────────────
// A managed work account can be refused by its own administrator at Google's
// consent step. We never see it: no callback, no error state, no log line. The
// only thing that helps is saying which account to pick BEFORE the click.
describe("IntegrationsPanel — the pick-your-account hint (#128)", () => {
  const hintFor = (link: HTMLElement) =>
    document.getElementById(link.getAttribute("aria-describedby") ?? "");

  it("describes the Connect link with the hint, not merely sits it nearby", () => {
    render(<IntegrationsPanel google={base} defaultExpanded />);
    const link = screen.getByRole("link", { name: /connect google/i });
    expect(hintFor(link)).toHaveTextContent(GOOGLE_ACCOUNT_HINT);
  });

  it("describes the Reconnect link too — an admin can start blocking an app that used to work", () => {
    render(
      <IntegrationsPanel
        google={{ ...base, needsReconnect: true }}
        defaultExpanded
      />,
    );
    const link = screen.getByRole("link", { name: /reconnect google/i });
    expect(hintFor(link)).toHaveTextContent(GOOGLE_ACCOUNT_HINT);
  });

  it("drops the hint once connected — there is no account left to pick", () => {
    render(
      <IntegrationsPanel
        google={{ ...base, connected: true }}
        defaultExpanded
      />,
    );
    expect(screen.queryByText(GOOGLE_ACCOUNT_HINT)).toBeNull();
  });

  it("stays out of the signed-out shell, which offers nothing to connect", () => {
    render(
      <IntegrationsPanel
        google={null}
        readOnly
        voice="plain"
        defaultExpanded
      />,
    );
    expect(screen.queryByText(GOOGLE_ACCOUNT_HINT)).toBeNull();
  });

  it("reads as guidance, not an alarm — no destructive/warning colouring", () => {
    render(<IntegrationsPanel google={base} defaultExpanded />);
    const hint = screen.getByText(GOOGLE_ACCOUNT_HINT);
    expect(hint.className).toContain("text-muted-foreground");
    expect(hint.className).not.toMatch(/destructive|text-red|bg-red|amber/);
    expect(hint).not.toHaveAttribute("role", "alert");
  });
});
