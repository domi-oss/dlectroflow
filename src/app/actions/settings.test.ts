/**
 * Action tests for updateRoundupSettings (#20 guest email abuse guard).
 *
 * Guests must never be able to point roundup emails anywhere: the action
 * forces roundupEmailEnabled=false + roundupEmail=null for non-owner
 * workspaces while still letting the sandbox tweak the harmless demo knobs
 * (workdayEndTime, roundupDemoOverride). Owner keeps full control.
 *
 * Mirrors the vi.mock shape used in snooze.test.ts.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const { prismaMock, revalidatePathMock, currentWorkspaceIdMock } = vi.hoisted(
  () => {
    const prismaMock = {
      settings: {
        upsert: vi.fn().mockResolvedValue({}),
      },
    };
    return {
      prismaMock,
      revalidatePathMock: vi.fn(),
      currentWorkspaceIdMock: vi.fn().mockResolvedValue("owner"),
    };
  },
);
vi.mock("next/cache", () => ({ revalidatePath: revalidatePathMock }));
vi.mock("@/lib/db", () => ({ prisma: prismaMock }));
vi.mock("@/lib/workspace", () => ({
  currentWorkspaceId: currentWorkspaceIdMock,
  isOwnerRequest: vi.fn().mockResolvedValue(true),
}));

beforeEach(() => {
  vi.clearAllMocks();
  currentWorkspaceIdMock.mockResolvedValue("owner");
});

describe("updateRoundupSettings", () => {
  it("guest workspace: forces email opt-out and null address in both upsert branches, keeps demo knobs", async () => {
    currentWorkspaceIdMock.mockResolvedValue("g_attacker");
    const { updateRoundupSettings } = await import("./settings");
    await updateRoundupSettings({
      workdayEndTime: "18:30",
      roundupDemoOverride: true,
      roundupEmailEnabled: true,
      roundupEmail: "victim@example.com",
    });

    expect(prismaMock.settings.upsert).toHaveBeenCalledTimes(1);
    const call = prismaMock.settings.upsert.mock.calls[0][0];
    expect(call.update.roundupEmailEnabled).toBe(false);
    expect(call.update.roundupEmail).toBeNull();
    expect(call.create.roundupEmailEnabled).toBe(false);
    expect(call.create.roundupEmail).toBeNull();
    // Harmless sandbox knobs still apply for guests.
    expect(call.update.workdayEndTime).toBe("18:30");
    expect(call.update.roundupDemoOverride).toBe(true);
  });

  it("owner workspace: email opt-in and address pass through unchanged", async () => {
    const { updateRoundupSettings } = await import("./settings");
    await updateRoundupSettings({
      workdayEndTime: "17:00",
      roundupDemoOverride: false,
      roundupEmailEnabled: true,
      roundupEmail: "me@example.com",
    });

    const call = prismaMock.settings.upsert.mock.calls[0][0];
    expect(call.update.roundupEmailEnabled).toBe(true);
    expect(call.update.roundupEmail).toBe("me@example.com");
  });
});

describe("updateNotificationSettings (Phase 6)", () => {
  it("persists the four notification prefs, workspace-scoped, in both upsert branches", async () => {
    currentWorkspaceIdMock.mockResolvedValue("g_guest");
    const { updateNotificationSettings } = await import("./settings");
    await updateNotificationSettings({
      notifyRoundup: false,
      notifyAging: true,
      notifyDailyReview: true,
      dailyReviewNudgeTime: "08:30",
    });

    expect(prismaMock.settings.upsert).toHaveBeenCalledTimes(1);
    const call = prismaMock.settings.upsert.mock.calls[0][0];
    expect(call.where).toEqual({ workspaceId: "g_guest" });
    for (const branch of [call.create, call.update]) {
      expect(branch.notifyRoundup).toBe(false);
      expect(branch.notifyAging).toBe(true);
      expect(branch.notifyDailyReview).toBe(true);
      expect(branch.dailyReviewNudgeTime).toBe("08:30");
    }
    // create branch also seeds the keys
    expect(call.create.workspaceId).toBe("g_guest");
  });

  it("coerces non-boolean inputs to booleans", async () => {
    const { updateNotificationSettings } = await import("./settings");
    await updateNotificationSettings({
      notifyRoundup: 1 as unknown as boolean,
      notifyAging: 0 as unknown as boolean,
      notifyDailyReview: "" as unknown as boolean,
      dailyReviewNudgeTime: "17:00",
    });
    const call = prismaMock.settings.upsert.mock.calls[0][0];
    expect(call.update.notifyRoundup).toBe(true);
    expect(call.update.notifyAging).toBe(false);
    expect(call.update.notifyDailyReview).toBe(false);
  });

  it("falls back to 17:00 when the nudge time is not valid HH:mm", async () => {
    const { updateNotificationSettings } = await import("./settings");
    await updateNotificationSettings({
      notifyRoundup: true,
      notifyAging: true,
      notifyDailyReview: true,
      dailyReviewNudgeTime: "25:99",
    });
    const call = prismaMock.settings.upsert.mock.calls[0][0];
    expect(call.update.dailyReviewNudgeTime).toBe("17:00");
    expect(call.create.dailyReviewNudgeTime).toBe("17:00");
  });

  it("accepts a valid HH:mm nudge time unchanged", async () => {
    const { updateNotificationSettings } = await import("./settings");
    await updateNotificationSettings({
      notifyRoundup: true,
      notifyAging: true,
      notifyDailyReview: true,
      dailyReviewNudgeTime: "21:15",
    });
    const call = prismaMock.settings.upsert.mock.calls[0][0];
    expect(call.update.dailyReviewNudgeTime).toBe("21:15");
  });
});
