/**
 * Unit tests for focus.ts's `proposeNewEstimate()` AI path, migrated (#59)
 * from the raw `getAnthropic()` client to the provider-agnostic
 * `getLLM().generate()` seam. Covers what ai-scope-guards.test.ts doesn't:
 * the actual `{"minutes":N}` extraction from `.text`, not just the guest
 * guard. Kept minimal/localized to `proposeNewEstimate` — focus.ts is being
 * edited concurrently elsewhere (#27) for unrelated pause/resume work.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const { generateMock, prismaMock, currentWorkspaceIdMock } = vi.hoisted(() => ({
  generateMock: vi.fn(),
  prismaMock: { step: { findFirst: vi.fn() } },
  currentWorkspaceIdMock: vi.fn().mockResolvedValue("owner"),
}));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/db", () => ({ prisma: prismaMock }));
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
vi.mock("@/lib/workspace", () => ({
  currentWorkspaceId: currentWorkspaceIdMock,
  MissingWorkspaceError: class extends Error {},
}));
vi.mock("@/lib/google", () => ({
  getValidAccessToken: vi.fn().mockResolvedValue(null),
  patchGoogleTask: vi.fn().mockResolvedValue(false),
}));
vi.mock("@/lib/rewards", () => ({
  logReward: vi.fn(),
  awardBadge: vi.fn(),
  rewardStepDone: vi.fn(),
}));

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
  currentWorkspaceIdMock.mockResolvedValue("owner");
  prismaMock.step.findFirst.mockResolvedValue(STEP);
});

describe("focus.ts › proposeNewEstimate", () => {
  it('owner: getLLM().generate() success extracts {"minutes":N} from .text', async () => {
    generateMock.mockResolvedValue({
      text: 'Sure thing! {"minutes": 35}',
      toolCall: undefined,
    });
    const { proposeNewEstimate } = await import("./focus");

    const result = await proposeNewEstimate("step-1");

    expect(result).toBe(35);
    expect(generateMock).toHaveBeenCalledTimes(1);
  });

  it("owner: getLLM().generate() rejection falls back to estMinutes + 10", async () => {
    generateMock.mockRejectedValue(new Error("boom"));
    const { proposeNewEstimate } = await import("./focus");

    const result = await proposeNewEstimate("step-1");

    expect(result).toBe(STEP.estMinutes + 10);
  });

  it("guest: never calls getLLM().generate(), falls back to estMinutes + 10", async () => {
    currentWorkspaceIdMock.mockResolvedValue("guest-xyz");
    const { proposeNewEstimate } = await import("./focus");

    const result = await proposeNewEstimate("step-1");

    expect(generateMock).not.toHaveBeenCalled();
    expect(result).toBe(STEP.estMinutes + 10);
  });
});
