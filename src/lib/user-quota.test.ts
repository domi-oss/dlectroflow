import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// #35 Phase B — the per-user AI policy matrix and the sliding window it meters
// against. The three policies the design defines (`uncapped` / `capped` /
// `own_key`) plus the rule that makes "capped until you bring your key" need no
// fourth state: A PRESENT KEY WINS, whatever the policy says.

const db = vi.hoisted(() => ({
  user: { findUnique: vi.fn() },
  userAiUsage: {
    findUnique: vi.fn(),
    updateMany: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
  },
}));

vi.mock("@/lib/db", () => ({
  prisma: db,
  isUniqueViolation: (e: unknown) =>
    !!e && typeof e === "object" && (e as { code?: string }).code === "P2002",
}));

import {
  consumeUserBreakdown,
  peekUserAiUsage,
  refundUserBreakdown,
  userQuotaConfig,
} from "./user-quota";
import { encryptToken } from "@/lib/crypto/token-cipher";

const USER_ID = "user-1";

/** A User row as the policy resolver selects it. */
function userRow(over: Partial<Record<string, unknown>> = {}) {
  return {
    id: USER_ID,
    aiPolicy: "capped",
    aiQuota: 5,
    llmProvider: null,
    llmKeyEnc: null,
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.USER_AI_WINDOW_HOURS;
  process.env.TOKEN_ENC_KEY = "0".repeat(64);
  // Default: nothing consumed yet, and every write succeeds.
  db.userAiUsage.findUnique.mockResolvedValue(null);
  db.userAiUsage.updateMany.mockResolvedValue({ count: 0 });
  db.userAiUsage.create.mockResolvedValue({});
});

afterEach(() => {
  delete process.env.USER_AI_WINDOW_HOURS;
});

describe("userQuotaConfig", () => {
  it("defaults the window to 720 hours (30 days), read exactly as the guest window is", () => {
    expect(userQuotaConfig()).toEqual({ windowHours: 720 });
  });

  it("honours USER_AI_WINDOW_HOURS", () => {
    process.env.USER_AI_WINDOW_HOURS = "168";
    expect(userQuotaConfig().windowHours).toBe(168);
  });

  it("falls back to the default for a non-numeric or empty value", () => {
    process.env.USER_AI_WINDOW_HOURS = "";
    expect(userQuotaConfig().windowHours).toBe(720);
    process.env.USER_AI_WINDOW_HOURS = "not-a-number";
    expect(userQuotaConfig().windowHours).toBe(720);
    process.env.USER_AI_WINDOW_HOURS = "0";
    expect(userQuotaConfig().windowHours).toBe(720);
  });
});

describe("consumeUserBreakdown — the policy matrix", () => {
  it("uncapped: instance key, nothing metered", async () => {
    db.user.findUnique.mockResolvedValue(userRow({ aiPolicy: "uncapped" }));

    const access = await consumeUserBreakdown(USER_ID);

    expect(access).toEqual({
      policy: "uncapped",
      ownKey: null,
      metered: false,
      blockedReason: null,
    });
    expect(db.userAiUsage.updateMany).not.toHaveBeenCalled();
    expect(db.userAiUsage.create).not.toHaveBeenCalled();
  });

  it("capped, under quota: instance key, ONE unit metered", async () => {
    db.user.findUnique.mockResolvedValue(userRow({ aiQuota: 5 }));
    db.userAiUsage.create.mockResolvedValue({});

    const access = await consumeUserBreakdown(USER_ID);

    expect(access).toEqual({
      policy: "capped",
      ownKey: null,
      metered: true,
      blockedReason: null,
    });
    // First use → the row is created with a single consumed unit.
    expect(db.userAiUsage.create).toHaveBeenCalledWith({
      data: { userId: USER_ID, count: 1, windowStartedAt: expect.any(Date) },
    });
  });

  it("capped, over quota: blocked with the same 'quota' reason the guest cap returns", async () => {
    db.user.findUnique.mockResolvedValue(userRow({ aiQuota: 5 }));
    // An exhausted ACTIVE window: no reset matches, no increment matches, and
    // the row exists so no create is attempted.
    db.userAiUsage.findUnique.mockResolvedValue({
      userId: USER_ID,
      count: 5,
      windowStartedAt: new Date(),
    });

    const access = await consumeUserBreakdown(USER_ID);

    expect(access).toEqual({
      policy: "capped",
      ownKey: null,
      metered: false,
      blockedReason: "quota",
    });
    expect(db.userAiUsage.create).not.toHaveBeenCalled();
  });

  it("own_key WITH a key present: their key, no cap, nothing metered", async () => {
    db.user.findUnique.mockResolvedValue(
      userRow({
        aiPolicy: "own_key",
        llmProvider: "anthropic",
        llmKeyEnc: encryptToken("sk-their-own-key"),
      }),
    );

    const access = await consumeUserBreakdown(USER_ID);

    expect(access).toEqual({
      policy: "own_key",
      ownKey: { apiKey: "sk-their-own-key", provider: "anthropic" },
      metered: false,
      blockedReason: null,
    });
    expect(db.userAiUsage.updateMany).not.toHaveBeenCalled();
  });

  it("own_key WITHOUT a key present: falls back to the instance key AND is metered", async () => {
    // The honest reading of "capped until you bring your key": the policy alone
    // buys nothing. Without a key there is no key to bill, so the instance pays
    // and the instance's meter runs.
    db.user.findUnique.mockResolvedValue(
      userRow({ aiPolicy: "own_key", llmKeyEnc: null, aiQuota: 5 }),
    );

    const access = await consumeUserBreakdown(USER_ID);

    expect(access).toEqual({
      policy: "own_key",
      ownKey: null,
      metered: true,
      blockedReason: null,
    });
  });

  it("a present key WINS over a capped policy — that is why there is no fourth state", async () => {
    db.user.findUnique.mockResolvedValue(
      userRow({
        aiPolicy: "capped",
        aiQuota: 0, // would block instantly if the meter ran
        llmKeyEnc: encryptToken("sk-brought-their-own"),
      }),
    );

    const access = await consumeUserBreakdown(USER_ID);

    expect(access.ownKey).toEqual({
      apiKey: "sk-brought-their-own",
      provider: null,
    });
    expect(access.metered).toBe(false);
    expect(access.blockedReason).toBeNull();
    expect(db.userAiUsage.updateMany).not.toHaveBeenCalled();
  });

  it("an UNDECRYPTABLE key is treated as absent, not as a free pass", async () => {
    // Key rotation, corruption, a stray non-v1 value. Degrading to "no key"
    // keeps the account working on the instance key + meter; treating it as a
    // present key would hand out an uncapped allowance backed by nothing.
    db.user.findUnique.mockResolvedValue(
      userRow({ aiPolicy: "own_key", llmKeyEnc: "v1:not-real-ciphertext" }),
    );

    const access = await consumeUserBreakdown(USER_ID);

    expect(access.ownKey).toBeNull();
    expect(access.metered).toBe(true);
  });

  it("an unknown aiPolicy value fails CLOSED onto the metered path", async () => {
    // The CHECK constraint makes this unreachable through Prisma, but a hand-
    // edited row must not become an uncapped account.
    db.user.findUnique.mockResolvedValue(
      userRow({ aiPolicy: "free_for_all", aiQuota: 5 }),
    );

    const access = await consumeUserBreakdown(USER_ID);

    expect(access.metered).toBe(true);
    expect(access.ownKey).toBeNull();
  });

  it("an unknown user is blocked rather than served on the instance key", async () => {
    db.user.findUnique.mockResolvedValue(null);

    const access = await consumeUserBreakdown(USER_ID);

    expect(access.blockedReason).toBe("quota");
    expect(access.metered).toBe(false);
    expect(access.ownKey).toBeNull();
  });

  it("a zero quota blocks immediately without recording a consume", async () => {
    db.user.findUnique.mockResolvedValue(userRow({ aiQuota: 0 }));

    const access = await consumeUserBreakdown(USER_ID);

    expect(access.blockedReason).toBe("quota");
    expect(db.userAiUsage.create).not.toHaveBeenCalled();
    expect(db.userAiUsage.updateMany).not.toHaveBeenCalled();
  });
});

describe("refundUserBreakdown", () => {
  it("decrements a consumed unit", async () => {
    db.userAiUsage.findUnique.mockResolvedValue({
      userId: USER_ID,
      count: 3,
      windowStartedAt: new Date(),
    });

    await refundUserBreakdown(USER_ID);

    expect(db.userAiUsage.update).toHaveBeenCalledWith({
      where: { userId: USER_ID },
      data: { count: { decrement: 1 } },
    });
  });

  it("never goes below zero, and no-ops when there is no row", async () => {
    db.userAiUsage.findUnique.mockResolvedValue({
      userId: USER_ID,
      count: 0,
      windowStartedAt: new Date(),
    });
    await refundUserBreakdown(USER_ID);
    expect(db.userAiUsage.update).not.toHaveBeenCalled();

    db.userAiUsage.findUnique.mockResolvedValue(null);
    await refundUserBreakdown(USER_ID);
    expect(db.userAiUsage.update).not.toHaveBeenCalled();
  });
});

describe("peekUserAiUsage — what the People panel reports", () => {
  it("reports zero used and no window for a user who has never used AI", async () => {
    db.userAiUsage.findUnique.mockResolvedValue(null);

    expect(await peekUserAiUsage(USER_ID, 50)).toEqual({
      used: 0,
      quota: 50,
      remaining: 50,
      windowStartedAt: null,
      windowEndsAt: null,
    });
  });

  it("reports the CURRENT window's count against the quota", async () => {
    const started = new Date("2026-07-20T09:00:00.000Z");
    db.userAiUsage.findUnique.mockResolvedValue({
      userId: USER_ID,
      count: 12,
      windowStartedAt: started,
    });

    expect(await peekUserAiUsage(USER_ID, 50)).toEqual({
      used: 12,
      quota: 50,
      remaining: 38,
      windowStartedAt: started,
      windowEndsAt: new Date(started.getTime() + 720 * 3600_000),
    });
  });

  it("reports an EXPIRED window as a spent one, so the owner sees the same number enforcement will", async () => {
    // The next consume resets the row, so 0 used is what enforcement is about
    // to see. Showing the stale count would tell the owner someone is at their
    // cap when they are not.
    process.env.USER_AI_WINDOW_HOURS = "24";
    const started = new Date(Date.now() - 48 * 3600_000);
    db.userAiUsage.findUnique.mockResolvedValue({
      userId: USER_ID,
      count: 50,
      windowStartedAt: started,
    });

    const usage = await peekUserAiUsage(USER_ID, 50);

    expect(usage.used).toBe(0);
    expect(usage.remaining).toBe(50);
    // The lapsed window is still reported, flagged as over — the owner can see
    // WHEN the last window began rather than being shown a blank.
    expect(usage.windowStartedAt).toEqual(started);
  });

  it("never reports a negative remaining allowance", async () => {
    db.userAiUsage.findUnique.mockResolvedValue({
      userId: USER_ID,
      count: 60,
      windowStartedAt: new Date(),
    });
    expect((await peekUserAiUsage(USER_ID, 50)).remaining).toBe(0);
  });
});
