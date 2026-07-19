import { describe, it, expect } from "vitest";
import {
  icsProvider,
  googleTasksProvider,
  schedulingProviders,
  availableProviders,
  isProviderAvailable,
  leadSchedulingMethod,
} from "./providers";
import type { SchedulingContext } from "./types";

const ctx = (over: Partial<SchedulingContext> = {}): SchedulingContext => ({
  workspaceId: "ws",
  isOwner: false,
  google: null,
  ...over,
});

const guest = ctx();
const ownerConfigured = ctx({
  isOwner: true,
  google: { configured: true, connected: true, needsReconnect: false },
});
// Configured but the OAuth handshake never finished — isAvailable gates only on
// `configured`, so this is still "available" (scheduleState renders it Connect).
const ownerConfiguredNotConnected = ctx({
  isOwner: true,
  google: { configured: true, connected: false, needsReconnect: false },
});
const ownerNotConfigured = ctx({
  isOwner: true,
  google: { configured: false, connected: false, needsReconnect: false },
});

describe("icsProvider.isAvailable — universal, zero-OAuth baseline", () => {
  it("is always available (guest, owner, self-hoster)", () => {
    expect(icsProvider.isAvailable(guest)).toBe(true);
    expect(icsProvider.isAvailable(ownerConfigured)).toBe(true);
    expect(icsProvider.isAvailable(ownerNotConfigured)).toBe(true);
  });
  it("has the ics id/labelKey", () => {
    expect(icsProvider.id).toBe("ics");
    expect(icsProvider.labelKey).toBe("action.addToCalendar");
  });
});

describe("googleTasksProvider.isAvailable — owner + configured truth table", () => {
  it("guest → false", () => {
    expect(googleTasksProvider.isAvailable(guest)).toBe(false);
  });
  it("owner + not configured → false", () => {
    expect(googleTasksProvider.isAvailable(ownerNotConfigured)).toBe(false);
  });
  it("owner + configured (even if not yet connected) → true", () => {
    expect(googleTasksProvider.isAvailable(ownerConfigured)).toBe(true);
    expect(googleTasksProvider.isAvailable(ownerConfiguredNotConnected)).toBe(true);
  });
  it("has the googleTasks id (distinct from the stored scheduledVia)", () => {
    expect(googleTasksProvider.id).toBe("googleTasks");
  });
});

describe("availableProviders — the single 'which methods?' answer", () => {
  it("guest → [ics] only", () => {
    expect(availableProviders(guest).map((p) => p.id)).toEqual(["ics"]);
  });
  it("configured owner → [ics, googleTasks]", () => {
    expect(availableProviders(ownerConfigured).map((p) => p.id)).toEqual(["ics", "googleTasks"]);
  });
  it("owner without a configured Google → [ics] (the Connect affordance is separate)", () => {
    expect(availableProviders(ownerNotConfigured).map((p) => p.id)).toEqual(["ics"]);
  });
});

describe("leadSchedulingMethod — the UI's control-visibility choice", () => {
  it("guest (google=null) → ics", () => {
    expect(leadSchedulingMethod(null)).toBe("ics");
  });
  it("owner with a configured Google → googleTasks", () => {
    expect(leadSchedulingMethod({ configured: true, connected: true, needsReconnect: false })).toBe(
      "googleTasks",
    );
  });
  it("owner WITHOUT a configured Google still leads with googleTasks (Connect affordance)", () => {
    // Distinct from isAvailable: the control is offered (as Connect) even though
    // the method can't run yet.
    expect(
      leadSchedulingMethod({ configured: false, connected: false, needsReconnect: false }),
    ).toBe("googleTasks");
    expect(googleTasksProvider.isAvailable(ownerNotConfigured)).toBe(false);
  });
});

describe("registry + isProviderAvailable", () => {
  it("registry maps ids to the provider singletons", () => {
    expect(schedulingProviders.ics).toBe(icsProvider);
    expect(schedulingProviders.googleTasks).toBe(googleTasksProvider);
  });
  it("isProviderAvailable mirrors the provider's own predicate", () => {
    expect(isProviderAvailable(googleTasksProvider, ownerConfigured)).toBe(true);
    expect(isProviderAvailable(googleTasksProvider, guest)).toBe(false);
    expect(isProviderAvailable(icsProvider, guest)).toBe(true);
  });
});
