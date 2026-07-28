/**
 * Unit tests for rollup.ts's `generateNarrative()` AI path (exercised via the
 * exported `generateTodayRollup()`), migrated (#59) from the raw
 * `getAnthropic()` client to the provider-agnostic `getLLM().generate()` seam.
 * Covers what ai-scope-guards.test.ts doesn't: the actual success/failure
 * content mapping, not just the guest guard.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const { generateMock, prismaMock, getStreakMock } = vi.hoisted(() => ({
  generateMock: vi.fn(),
  prismaMock: {
    focusSession: { findMany: vi.fn() },
    rewardEvent: { aggregate: vi.fn() },
    step: { findMany: vi.fn() },
    dayRollup: { findUnique: vi.fn(), upsert: vi.fn() },
    dailySpark: { findUnique: vi.fn(), upsert: vi.fn() },
  },
  getStreakMock: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: prismaMock,
  getStreak: getStreakMock,
}));
// #35 Phase A — "is this a guest?" is a database lookup on Workspace.kind now,
// not a comparison against a magic id. These specs already express intent
// through the workspace id they pass in, so map that id back to a kind: the
// signed-in account's workspace here is "owner", everything else is a sandbox.
// The lookup itself is covered by src/lib/workspace-kind.test.ts.
vi.mock("@/lib/workspace-kind", () => ({
  isGuestWorkspace: (id: string) => Promise.resolve(id !== "owner"),
}));

vi.mock("@/lib/models", () => ({
  resolveUtilityModel: () => "claude-opus-4-8",
}));
vi.mock("@/lib/llm", () => ({ getLLM: () => ({ generate: generateMock }) }));

const TODAY = new Date().toISOString().slice(0, 10);

beforeEach(() => {
  vi.clearAllMocks();
  prismaMock.focusSession.findMany.mockResolvedValue([]);
  prismaMock.rewardEvent.aggregate.mockResolvedValue({ _sum: { points: 0 } });
  prismaMock.step.findMany.mockResolvedValue([]);
  getStreakMock.mockResolvedValue({ current: 0, freshStart: false });
  prismaMock.dayRollup.findUnique.mockResolvedValue(null);
  prismaMock.dailySpark.findUnique.mockResolvedValue({
    quote: "You got this.",
    source: "fallback",
  });
});

describe("rollup.ts › generateTodayRollup narrative", () => {
  it("owner: getLLM().generate() success uses the generated narrative text", async () => {
    generateMock.mockResolvedValue({
      text: "You showed up today. That counts.",
      toolCall: undefined,
    });
    prismaMock.dayRollup.upsert.mockImplementation(
      ({ create }: { create: Record<string, unknown> }) =>
        Promise.resolve({ ...create, date: TODAY, emailedAt: null }),
    );

    const { generateTodayRollup } = await import("@/lib/rollup");
    const rollup = await generateTodayRollup("owner");

    expect(rollup.narrative).toBe("You showed up today. That counts.");
    expect(generateMock).toHaveBeenCalledTimes(1);
  });

  it("owner: getLLM().generate() rejection falls back to the local narrative builder", async () => {
    generateMock.mockRejectedValue(new Error("boom"));
    prismaMock.dayRollup.upsert.mockImplementation(
      ({ create }: { create: Record<string, unknown> }) =>
        Promise.resolve({ ...create, date: TODAY, emailedAt: null }),
    );

    const { generateTodayRollup } = await import("@/lib/rollup");
    const rollup = await generateTodayRollup("owner");

    // Quiet-day fallback text from fallbackNarrative() (stepsDone===0 && focusMin===0).
    expect(rollup.narrative).toMatch(/Some days are for gathering/);
  });

  it("guest: never calls getLLM().generate(), narrative is the local fallback", async () => {
    prismaMock.dayRollup.upsert.mockImplementation(
      ({ create }: { create: Record<string, unknown> }) =>
        Promise.resolve({ ...create, date: TODAY, emailedAt: null }),
    );

    const { generateTodayRollup } = await import("@/lib/rollup");
    const rollup = await generateTodayRollup("guest-xyz");

    expect(generateMock).not.toHaveBeenCalled();
    expect(rollup.narrative).toMatch(/Some days are for gathering/);
  });
});
