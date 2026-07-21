/**
 * Action tests for triggerRollup email gating (#20) and the duplicate-send
 * race (#18).
 *
 * #20 — Send-site defense in depth: even if a guest workspace's Settings row
 * already carries roundupEmailEnabled=true + an attacker-chosen address
 * (rows written before the updateRoundupSettings guard existed), triggerRollup
 * must never send email for a guest workspace. Resend sends only for the owner.
 *
 * #18 — The once-per-day auto/client-triggered path must claim the send
 * atomically so two overlapping triggers (e.g. a double dashboard open) can
 * never both send. Here the claim is mocked to model "first caller wins"; the
 * real atomicity is proven against Postgres in rollup.integration.test.ts.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const {
  getSettingsMock,
  generateTodayRollupMock,
  markRollupEmailedMock,
  claimRollupEmailMock,
  releaseRollupEmailClaimMock,
  emailConfiguredMock,
  sendRoundupEmailMock,
  currentWorkspaceIdMock,
} = vi.hoisted(() => ({
  getSettingsMock: vi.fn(),
  generateTodayRollupMock: vi.fn(),
  markRollupEmailedMock: vi.fn().mockResolvedValue(undefined),
  claimRollupEmailMock: vi.fn().mockResolvedValue(true),
  releaseRollupEmailClaimMock: vi.fn().mockResolvedValue(undefined),
  emailConfiguredMock: vi.fn().mockReturnValue(true),
  sendRoundupEmailMock: vi.fn().mockResolvedValue({ ok: true }),
  currentWorkspaceIdMock: vi.fn().mockResolvedValue("owner"),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/db", () => ({ getSettings: getSettingsMock }));
vi.mock("@/lib/rollup", () => ({
  generateTodayRollup: generateTodayRollupMock,
  markRollupEmailed: markRollupEmailedMock,
  claimRollupEmail: claimRollupEmailMock,
  releaseRollupEmailClaim: releaseRollupEmailClaimMock,
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
  claimRollupEmailMock.mockReset();
  claimRollupEmailMock.mockResolvedValue(true);
  releaseRollupEmailClaimMock.mockReset();
  releaseRollupEmailClaimMock.mockResolvedValue(undefined);
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
    // The once-per-day guard depends on the emailed marker being written.
    expect(markRollupEmailedMock).toHaveBeenCalledWith(
      "owner",
      rollupFixture.date,
    );
    expect(res.email).toEqual({ attempted: true, ok: true, reason: undefined });
  });
});

describe("triggerRollup duplicate-send race (#18)", () => {
  it("two concurrent auto-triggers email the round-up exactly once", async () => {
    // Model the atomic claim: only the first caller to run it wins; the rest
    // see the day already claimed and must skip without emailing.
    let won = false;
    claimRollupEmailMock.mockImplementation(async () => {
      if (won) return false;
      won = true;
      return true;
    });

    const { triggerRollup } = await import("./rollup");

    const results = await Promise.all([
      triggerRollup({ force: false, sendEmail: true }),
      triggerRollup({ force: false, sendEmail: true }),
    ]);

    expect(sendRoundupEmailMock).toHaveBeenCalledTimes(1);
    expect(results.filter((r) => r.email.attempted)).toHaveLength(1);
    // The loser reports no attempt (silently skipped), never a failure.
    expect(results.some((r) => r.email.attempted === false)).toBe(true);
  });

  it("does not send on the auto path when the day is already claimed", async () => {
    claimRollupEmailMock.mockResolvedValue(false);

    const { triggerRollup } = await import("./rollup");
    const res = await triggerRollup({ force: false, sendEmail: true });

    expect(sendRoundupEmailMock).not.toHaveBeenCalled();
    expect(res.email).toEqual({ attempted: false });
  });

  it("releases the claim when the send fails, so a later trigger can retry", async () => {
    claimRollupEmailMock.mockResolvedValue(true);
    sendRoundupEmailMock.mockResolvedValue({ ok: false, reason: "error" });

    const { triggerRollup } = await import("./rollup");
    const res = await triggerRollup({ force: false, sendEmail: true });

    expect(res.email).toEqual({ attempted: true, ok: false, reason: "error" });
    expect(releaseRollupEmailClaimMock).toHaveBeenCalledWith(
      "owner",
      rollupFixture.date,
    );
    // A failed send must not leave the day marked as emailed.
    expect(markRollupEmailedMock).not.toHaveBeenCalled();
  });

  it("releases the claim when the send THROWS and re-raises, so a later trigger can retry", async () => {
    // A network error / unhandled Resend rejection throws instead of returning
    // { ok: false }. The claim was already stamped, so it must be released or
    // every future auto-trigger would skip forever (Duo regression on !74).
    claimRollupEmailMock.mockResolvedValue(true);
    const boom = new Error("resend network blip");
    sendRoundupEmailMock.mockRejectedValue(boom);

    const { triggerRollup } = await import("./rollup");

    await expect(
      triggerRollup({ force: false, sendEmail: true }),
    ).rejects.toThrow(boom);
    expect(releaseRollupEmailClaimMock).toHaveBeenCalledWith(
      "owner",
      rollupFixture.date,
    );
    expect(markRollupEmailedMock).not.toHaveBeenCalled();
  });

  it("manual force trigger still (re)sends, bypassing the once-per-day claim", async () => {
    const { triggerRollup } = await import("./rollup");
    const res = await triggerRollup({ force: true, sendEmail: true });

    expect(sendRoundupEmailMock).toHaveBeenCalledTimes(1);
    // Force is the demo override: it marks-emailed directly, never via a claim.
    expect(claimRollupEmailMock).not.toHaveBeenCalled();
    expect(markRollupEmailedMock).toHaveBeenCalledWith(
      "owner",
      rollupFixture.date,
    );
    expect(res.email).toEqual({ attempted: true, ok: true, reason: undefined });
  });
});
