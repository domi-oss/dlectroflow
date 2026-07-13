/**
 * Action tests for triggerRollup email gating (#20).
 *
 * Send-site defense in depth: even if a guest workspace's Settings row
 * already carries roundupEmailEnabled=true + an attacker-chosen address
 * (rows written before the updateRoundupSettings guard existed), triggerRollup
 * must never send email for a guest workspace. Resend sends only for the owner.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const {
  getSettingsMock,
  generateTodayRollupMock,
  markRollupEmailedMock,
  emailConfiguredMock,
  sendRoundupEmailMock,
  currentWorkspaceIdMock,
} = vi.hoisted(() => ({
  getSettingsMock: vi.fn(),
  generateTodayRollupMock: vi.fn(),
  markRollupEmailedMock: vi.fn().mockResolvedValue(undefined),
  emailConfiguredMock: vi.fn().mockReturnValue(true),
  sendRoundupEmailMock: vi.fn().mockResolvedValue({ ok: true }),
  currentWorkspaceIdMock: vi.fn().mockResolvedValue("owner"),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/db", () => ({ getSettings: getSettingsMock }));
vi.mock("@/lib/rollup", () => ({
  generateTodayRollup: generateTodayRollupMock,
  markRollupEmailed: markRollupEmailedMock,
}));
vi.mock("@/lib/email", () => ({
  emailConfigured: emailConfiguredMock,
  roundupEmailHtml: vi.fn().mockReturnValue("<html></html>"),
  sendRoundupEmail: sendRoundupEmailMock,
}));
vi.mock("@/lib/workspace", () => ({
  currentWorkspaceId: currentWorkspaceIdMock,
}));

const rollupFixture = {
  date: "2026-07-13",
  narrative: "n",
  stepsDone: 1,
  focusMin: 10,
  sessions: 1,
  points: 5,
  streakDay: 2,
  spark: null,
  emailedAt: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  currentWorkspaceIdMock.mockResolvedValue("owner");
  emailConfiguredMock.mockReturnValue(true);
  sendRoundupEmailMock.mockResolvedValue({ ok: true });
  generateTodayRollupMock.mockResolvedValue(rollupFixture);
  getSettingsMock.mockResolvedValue({
    roundupEmailEnabled: true,
    roundupEmail: "attacker-chosen@example.com",
  });
});

describe("triggerRollup email gating", () => {
  it("guest workspace: never emails, even with a poisoned opt-in settings row", async () => {
    currentWorkspaceIdMock.mockResolvedValue("g_attacker");
    const { triggerRollup } = await import("./rollup");

    const res = await triggerRollup({ force: true, sendEmail: true });

    expect(sendRoundupEmailMock).not.toHaveBeenCalled();
    expect(res.email).toEqual({ attempted: false });
  });

  it("owner workspace: emails when opted in", async () => {
    const { triggerRollup } = await import("./rollup");

    const res = await triggerRollup({ force: true, sendEmail: true });

    expect(sendRoundupEmailMock).toHaveBeenCalledTimes(1);
    expect(res.email).toEqual({ attempted: true, ok: true, reason: undefined });
  });
});
