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

describe("IntegrationsPanel — Google card", () => {
  it("not connected → Connect link to the OAuth start route", () => {
    render(<IntegrationsPanel google={base} />);
    expect(screen.getByText(/not connected/i)).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: /connect google/i }),
    ).toHaveAttribute("href", "/api/google/oauth/start");
  });

  it("connected → Connected pill + Disconnect", () => {
    render(<IntegrationsPanel google={{ ...base, connected: true }} />);
    expect(screen.getByText(/^connected$/i)).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /disconnect/i }),
    ).toBeInTheDocument();
  });

  it("needsReconnect → Reconnect pill + reconnect link", () => {
    render(<IntegrationsPanel google={{ ...base, needsReconnect: true }} />);
    expect(screen.getByText(/reconnect needed/i)).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: /reconnect google/i }),
    ).toHaveAttribute("href", "/api/google/oauth/start");
  });

  it("not configured → explains env vars, no actions", () => {
    render(<IntegrationsPanel google={{ ...base, configured: false }} />);
    expect(screen.getByText(/not configured/i)).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /connect/i })).toBeNull();
  });

  it("disconnect asks for confirmation before firing the action", async () => {
    disconnectMock.mockResolvedValue({ ok: true });
    render(<IntegrationsPanel google={{ ...base, connected: true }} />);
    fireEvent.click(screen.getByRole("button", { name: /disconnect/i }));
    expect(disconnectMock).not.toHaveBeenCalled(); // confirm step first
    fireEvent.click(screen.getByRole("button", { name: /yes, disconnect/i }));
    expect(disconnectMock).toHaveBeenCalledOnce();
  });
});

describe("IntegrationsPanel — guest read-only shell (#11)", () => {
  it("shows the integration exists + an owner-only label, with no actions", () => {
    render(<IntegrationsPanel google={null} readOnly voice="plain" />);
    // The integration is named so guests see what exists…
    expect(screen.getByText("Google Tasks")).toBeInTheDocument();
    // …flagged owner-only (text, not colour alone)…
    expect(screen.getAllByText(/owner-only/i).length).toBeGreaterThan(0);
    // …and no interactive affordances.
    expect(screen.queryByRole("link", { name: /connect/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /disconnect/i })).toBeNull();
  });

  it("never leaks the owner's real connection status to guests", () => {
    render(<IntegrationsPanel google={null} readOnly voice="plain" />);
    expect(screen.queryByText(/^connected$/i)).toBeNull();
    expect(screen.queryByText(/not connected/i)).toBeNull();
    expect(screen.queryByText(/reconnect needed/i)).toBeNull();
  });
});
