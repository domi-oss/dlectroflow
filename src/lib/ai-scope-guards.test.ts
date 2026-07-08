/**
 * Call-site guard tests: assert that guests NEVER trigger getAnthropic() in
 * the three Claude-calling paths (spark, rollup narrative, focus estimate).
 *
 * Strategy: vi.mock("@/lib/anthropic") with a spy that throws on invocation so
 * any accidental guest call fails the test loudly. We then invoke each function
 * with a guest workspace id and assert the spy was never called. Owner paths
 * verify the spy *is* reached (even though it then throws / falls through).
 *
 * Covered call sites:
 *   1. spark.ts › getTodaySpark      — guest skips getAnthropic via quoteFor guard
 *   2. rollup.ts › generateTodayRollup — guest skips getAnthropic via generateNarrative guard
 *   3. focus.ts › proposeNewEstimate  — guest skips getAnthropic via early-return guard
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { SparkSource } from "@/lib/constants";

// ── vi.hoisted: create shared mock objects before vi.mock hoisting ──────────
const { getAnthropicSpy, prismaMock, currentWorkspaceIdMock } = vi.hoisted(() => {
  const getAnthropicSpy = vi.fn(() => {
    throw new Error("getAnthropic must NOT be called for guests");
  });

  // Shared prisma stub — individual tests update the sub-objects they need.
  const prismaMock = {
    dailySpark: {
      findUnique: vi.fn(),
      upsert: vi.fn(),
    },
    dayRollup: {
      findUnique: vi.fn(),
      upsert: vi.fn(),
    },
    focusSession: {
      findMany: vi.fn(),
    },
    rewardEvent: {
      aggregate: vi.fn(),
      count: vi.fn(),
    },
    step: {
      findMany: vi.fn(),
      findFirst: vi.fn(),
    },
  };

  const currentWorkspaceIdMock = vi.fn();

  return { getAnthropicSpy, prismaMock, currentWorkspaceIdMock };
});

// ── Module mocks (hoisted automatically by vitest) ──────────────────────────
vi.mock("@/lib/anthropic", () => ({
  getAnthropic: getAnthropicSpy,
  BREAKDOWN_MODEL: "claude-opus-4-8",
}));

vi.mock("@/lib/db", () => ({
  prisma: prismaMock,
  getStreak: vi.fn().mockResolvedValue({ current: 0, freshStart: false }),
}));

vi.mock("@/lib/workspace", () => ({
  currentWorkspaceId: currentWorkspaceIdMock,
  MissingWorkspaceError: class MissingWorkspaceError extends Error {},
}));

// next/cache is imported by focus.ts ("use server" file)
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

// focus.ts also imports google & rewards — stub them to prevent real network/db calls
vi.mock("@/lib/google", () => ({
  getValidAccessToken: vi.fn().mockResolvedValue(null),
  patchGoogleTask: vi.fn().mockResolvedValue(false),
}));

vi.mock("@/lib/rewards", () => ({
  logReward: vi.fn().mockResolvedValue(undefined),
  touchStreakOnCompletion: vi.fn().mockResolvedValue(null),
  awardBadge: vi.fn().mockResolvedValue(false),
}));

// ═══════════════════════════════════════════════════════════════════════════
// 1. spark.ts — getTodaySpark
// ═══════════════════════════════════════════════════════════════════════════
describe("spark.ts › getTodaySpark", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // No cached spark in DB → quoteFor() is exercised on every call.
    prismaMock.dailySpark.findUnique.mockResolvedValue(null);
    prismaMock.dailySpark.upsert.mockImplementation(
      ({ create }: { create: { quote: string; source: string; date: string; workspaceId: string } }) =>
        Promise.resolve(create),
    );
    // Reset spy to throwing behaviour (guards against false-positive owner tests)
    getAnthropicSpy.mockImplementation(() => {
      throw new Error("getAnthropic must NOT be called for guests");
    });
  });

  it("guest workspace: getAnthropic is never called", async () => {
    const { getTodaySpark } = await import("@/lib/spark");
    await getTodaySpark("guest-xyz");
    expect(getAnthropicSpy).not.toHaveBeenCalled();
  });

  it("guest workspace: returned source is Fallback", async () => {
    const { getTodaySpark } = await import("@/lib/spark");
    const result = await getTodaySpark("guest-abc");
    expect(result.source).toBe(SparkSource.Fallback);
    expect(result.quote).toBeTruthy();
  });

  it("owner workspace: getAnthropic IS called (no guard for owner)", async () => {
    // For the owner, getAnthropic throws (no real key), so spark falls through
    // to fallback — but the important thing is the spy was reached.
    const { getTodaySpark } = await import("@/lib/spark");
    await getTodaySpark("owner");
    expect(getAnthropicSpy).toHaveBeenCalledTimes(1);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. focus.ts — proposeNewEstimate
// ═══════════════════════════════════════════════════════════════════════════
describe("focus.ts › proposeNewEstimate", () => {
  const STEP = {
    id: "step-1",
    taskId: "task-1",
    text: "Write the intro paragraph",
    estMinutes: 20,
    estimateHistory: null,
    order: 1,
    total: 5,
    done: false,
    subtaskEmoji: null,
    googleTaskId: null,
    googleTaskListId: null,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    prismaMock.step.findFirst.mockResolvedValue(STEP);
    getAnthropicSpy.mockImplementation(() => {
      throw new Error("getAnthropic must NOT be called for guests");
    });
  });

  it("guest workspace: getAnthropic is never called", async () => {
    currentWorkspaceIdMock.mockResolvedValue("guest-xyz");
    const { proposeNewEstimate } = await import("@/app/actions/focus");
    const result = await proposeNewEstimate("step-1");
    expect(getAnthropicSpy).not.toHaveBeenCalled();
    // Guest fallback: estMinutes + 10
    expect(result).toBe(STEP.estMinutes + 10);
  });

  it("owner workspace: getAnthropic IS called (no guard for owner)", async () => {
    currentWorkspaceIdMock.mockResolvedValue("owner");
    const { proposeNewEstimate } = await import("@/app/actions/focus");
    // getAnthropic throws → caught → returns estMinutes + 10 as fallback
    const result = await proposeNewEstimate("step-1");
    expect(getAnthropicSpy).toHaveBeenCalledTimes(1);
    expect(result).toBe(STEP.estMinutes + 10);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 3. rollup.ts — generateTodayRollup (narrative guard via generateNarrative)
//
// generateTodayRollup calls gatherDayData (5 parallel prisma queries + getStreak),
// then generateNarrative (where the guest guard lives), then upserts DayRollup,
// then calls getTodaySpark. All collaborators are stubbed below.
// ═══════════════════════════════════════════════════════════════════════════
describe("rollup.ts › generateTodayRollup (narrative guard)", () => {
  const TODAY = new Date().toISOString().slice(0, 10);

  const ROLLUP_ROW = {
    date: TODAY,
    workspaceId: "guest-xyz",
    stepsDone: 0,
    focusMin: 0,
    sessions: 0,
    pointsEarned: 0,
    streakDay: 0,
    narrative: "fallback narrative text",
    emailedAt: null,
  };

  beforeEach(() => {
    vi.clearAllMocks();

    // gatherDayData: focusSession.findMany called twice (done sessions + all today)
    prismaMock.focusSession.findMany.mockResolvedValue([]);
    // rewardEvent.aggregate for points
    prismaMock.rewardEvent.aggregate.mockResolvedValue({ _sum: { points: 0 } });
    // step.findMany for carry-over steps
    prismaMock.step.findMany.mockResolvedValue([]);

    // generateTodayRollup: dayRollup.findUnique + upsert
    prismaMock.dayRollup.findUnique.mockResolvedValue(null);
    prismaMock.dayRollup.upsert.mockResolvedValue(ROLLUP_ROW);

    // getTodaySpark (called at end of generateTodayRollup)
    prismaMock.dailySpark.findUnique.mockResolvedValue({
      quote: "You got this.",
      source: SparkSource.Fallback,
    });

    getAnthropicSpy.mockImplementation(() => {
      throw new Error("getAnthropic must NOT be called for guests");
    });
  });

  it("guest workspace: getAnthropic is never called during rollup narrative generation", async () => {
    const { generateTodayRollup } = await import("@/lib/rollup");
    const rollup = await generateTodayRollup("guest-xyz");

    expect(getAnthropicSpy).not.toHaveBeenCalled();
    // The narrative should be present (from fallbackNarrative or the upsert stub)
    expect(rollup.narrative).toBeTruthy();
  });

  it("owner workspace: getAnthropic IS called during narrative generation", async () => {
    prismaMock.dayRollup.upsert.mockResolvedValue({ ...ROLLUP_ROW, workspaceId: "owner" });

    const { generateTodayRollup } = await import("@/lib/rollup");
    // getAnthropic throws → caught → fallbackNarrative is used instead
    await generateTodayRollup("owner");

    expect(getAnthropicSpy).toHaveBeenCalledTimes(1);
  });
});
