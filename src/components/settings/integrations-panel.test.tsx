// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";

const { disconnectMock } = vi.hoisted(() => ({ disconnectMock: vi.fn() }));
vi.mock("@/app/actions/google-schedule", () => ({
  disconnectGoogleTasks: disconnectMock,
}));

import { IntegrationsPanel } from "./integrations-panel";

beforeEach(() => vi.clearAllMocks());
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
    disconnectMock.mockResolvedValue({ ok: true });
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

describe("IntegrationsPanel — guest read-only shell (#11)", () => {
  it("shows the integration exists + an owner-only label, with no actions", () => {
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
    // …flagged owner-only (text, not colour alone)…
    expect(screen.getAllByText(/owner-only/i).length).toBeGreaterThan(0);
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

  it("never leaks the owner's real connection status to guests", () => {
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

describe("IntegrationsPanel — the disclosure (#101)", () => {
  it("rests collapsed for the owner, keeping the owner-only badge visible", () => {
    render(<IntegrationsPanel google={base} />);
    const trigger = document.querySelector(
      '[data-section-toggle="settings-integrations"]',
    )!;
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("link", { name: /connect google/i })).toBeNull();
  });

  it("rests collapsed in the guest shell too, badge and all", () => {
    render(<IntegrationsPanel google={null} readOnly voice="plain" />);
    const trigger = document.querySelector(
      '[data-section-toggle="settings-integrations"]',
    )!;
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    // The "you cannot act on this" read has to survive the section being closed,
    // because closed is how a guest first meets it (#11 + #90).
    expect(trigger.closest("[data-section-header]")!.textContent).toMatch(
      /owner-only/i,
    );
  });
});
