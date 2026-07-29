import { describe, it, expect, vi, beforeEach } from "vitest";

// The providers wrap these two "use server" actions; mock them so schedule()'s
// pure result-shape mapping can be tested without a DB, Google, or ICS render.
vi.mock("@/app/actions/ics-schedule", () => ({ scheduleViaIcs: vi.fn() }));
vi.mock("@/app/actions/google-schedule", () => ({
  pushStepsToGoogleTasks: vi.fn(),
}));

import { scheduleViaIcs } from "@/app/actions/ics-schedule";
import { pushStepsToGoogleTasks } from "@/app/actions/google-schedule";
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
// #118 Phase C — an invited MEMBER with their own connection. `isOwner: false`
// and a non-null status is exactly the combination that used to be impossible.
const memberConfigured = ctx({
  workspaceId: "ws-member",
  isOwner: false,
  google: { configured: true, connected: false, needsReconnect: false },
});
const memberNotConfigured = ctx({
  workspaceId: "ws-member",
  isOwner: false,
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

describe("googleTasksProvider.isAvailable — configured truth table (#118)", () => {
  it("does not offer it to a guest — a null status is the guest signal", () => {
    expect(googleTasksProvider.isAvailable(guest)).toBe(false);
  });

  it("offers Google Tasks to a MEMBER with a configured instance (#118)", () => {
    // Was false before Phase C: the predicate required ctx.isOwner, so a member
    // with their own connection was still handed the .ics fallback.
    expect(googleTasksProvider.isAvailable(memberConfigured)).toBe(true);
  });

  it("does not offer it to a member when the instance has no OAuth client", () => {
    expect(googleTasksProvider.isAvailable(memberNotConfigured)).toBe(false);
  });
  it("owner + not configured → false", () => {
    expect(googleTasksProvider.isAvailable(ownerNotConfigured)).toBe(false);
  });
  it("owner + configured (even if not yet connected) → true", () => {
    expect(googleTasksProvider.isAvailable(ownerConfigured)).toBe(true);
    expect(googleTasksProvider.isAvailable(ownerConfiguredNotConnected)).toBe(
      true,
    );
  });
  it("has the googleTasks id (distinct from the stored scheduledVia)", () => {
    expect(googleTasksProvider.id).toBe("googleTasks");
  });
});

describe("availableProviders — the single 'which methods?' answer", () => {
  it("guest → [ics] only", () => {
    expect(availableProviders(guest).map((p) => p.id)).toEqual(["ics"]);
  });
  it("configured MEMBER → [ics, googleTasks] (#118)", () => {
    expect(availableProviders(memberConfigured).map((p) => p.id)).toEqual([
      "ics",
      "googleTasks",
    ]);
  });
  it("configured owner → [ics, googleTasks]", () => {
    expect(availableProviders(ownerConfigured).map((p) => p.id)).toEqual([
      "ics",
      "googleTasks",
    ]);
  });
  it("owner without a configured Google → [ics] (the Connect affordance is separate)", () => {
    expect(availableProviders(ownerNotConfigured).map((p) => p.id)).toEqual([
      "ics",
    ]);
  });
});

describe("leadSchedulingMethod — the UI's control-visibility choice", () => {
  it("guest (google=null) → ics", () => {
    expect(leadSchedulingMethod(null)).toBe("ics");
  });
  it("owner with a configured Google → googleTasks", () => {
    expect(
      leadSchedulingMethod({
        configured: true,
        connected: true,
        needsReconnect: false,
      }),
    ).toBe("googleTasks");
  });
  it("owner WITHOUT a configured Google still leads with googleTasks (Connect affordance)", () => {
    // Distinct from isAvailable: the control is offered (as Connect) even though
    // the method can't run yet.
    expect(
      leadSchedulingMethod({
        configured: false,
        connected: false,
        needsReconnect: false,
      }),
    ).toBe("googleTasks");
    expect(googleTasksProvider.isAvailable(ownerNotConfigured)).toBe(false);
  });
});

describe("icsProvider.schedule — result-shape mapping", () => {
  beforeEach(() => vi.clearAllMocks());

  it("maps a successful ICS result to a via:'ics' ScheduleResult", async () => {
    vi.mocked(scheduleViaIcs).mockResolvedValue({
      ok: true,
      ics: "BEGIN:VCALENDAR",
      icsFilename: "task.ics",
    });
    const res = await icsProvider.schedule("task1", guest);
    expect(res).toEqual({
      ok: true,
      via: "ics",
      ics: "BEGIN:VCALENDAR",
      icsFilename: "task.ics",
    });
  });

  it("passes durationMin through when provided, and omits opts entirely otherwise", async () => {
    vi.mocked(scheduleViaIcs).mockResolvedValue({
      ok: true,
      ics: "X",
      icsFilename: "t.ics",
    });

    await icsProvider.schedule("task1", guest, { durationMin: 45 });
    expect(scheduleViaIcs).toHaveBeenCalledWith("task1", { durationMin: 45 });

    vi.mocked(scheduleViaIcs).mockClear();
    await icsProvider.schedule("task1", guest);
    // No trailing `undefined` opts — preserves the exact single-arg call.
    expect(scheduleViaIcs).toHaveBeenCalledWith("task1");
  });

  it("propagates a failure reason + message", async () => {
    vi.mocked(scheduleViaIcs).mockResolvedValue({
      ok: false,
      reason: "not_found",
      message: "gone",
    });
    const res = await icsProvider.schedule("task1", guest);
    expect(res).toEqual({ ok: false, reason: "not_found", message: "gone" });
  });
});

describe("googleTasksProvider.schedule — result-shape mapping", () => {
  beforeEach(() => vi.clearAllMocks());

  it("maps a successful Google push to a via:'google' ScheduleResult", async () => {
    vi.mocked(pushStepsToGoogleTasks).mockResolvedValue({
      ok: true,
      scheduled: 3,
      listTitle: "Reclaim",
    });
    const res = await googleTasksProvider.schedule("task1", ownerConfigured);
    expect(res).toEqual({
      ok: true,
      via: "google",
      scheduled: 3,
      listTitle: "Reclaim",
    });
  });

  it("propagates a failure reason + message", async () => {
    vi.mocked(pushStepsToGoogleTasks).mockResolvedValue({
      ok: false,
      reason: "not_connected",
      message: "connect first",
    });
    const res = await googleTasksProvider.schedule("task1", ownerConfigured);
    expect(res).toEqual({
      ok: false,
      reason: "not_connected",
      message: "connect first",
    });
  });

  it("ignores ctx/opts (Google Tasks are date-based) — calls the action with just the taskId", async () => {
    vi.mocked(pushStepsToGoogleTasks).mockResolvedValue({
      ok: true,
      scheduled: 1,
      listTitle: "L",
    });
    await googleTasksProvider.schedule("task1", ownerConfigured, {
      durationMin: 30,
    });
    expect(pushStepsToGoogleTasks).toHaveBeenCalledWith("task1");
  });
});

describe("registry + isProviderAvailable", () => {
  it("registry maps ids to the provider singletons", () => {
    expect(schedulingProviders.ics).toBe(icsProvider);
    expect(schedulingProviders.googleTasks).toBe(googleTasksProvider);
  });
  it("isProviderAvailable mirrors the provider's own predicate", () => {
    expect(isProviderAvailable(googleTasksProvider, ownerConfigured)).toBe(
      true,
    );
    expect(isProviderAvailable(googleTasksProvider, guest)).toBe(false);
    expect(isProviderAvailable(icsProvider, guest)).toBe(true);
  });
});
