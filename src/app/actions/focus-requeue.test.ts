import { describe, it, expect, vi, beforeEach } from "vitest";
import { revalidatePath } from "next/cache";

// Unit test for issue #21 P5.4: requeueFocus must not blow up on a corrupt
// Step.estimateHistory. JSON.parse of malformed JSON was uncaught, breaking the
// whole requeue; it should fall back to [] and still append the current estimate.
const { prismaMock, currentWorkspaceIdMock } = vi.hoisted(() => {
  const prismaMock = {
    focusSession: { findFirst: vi.fn(), update: vi.fn() },
    step: { findFirst: vi.fn(), update: vi.fn().mockResolvedValue({}) },
    task: { findFirst: vi.fn() },
  };
  return {
    prismaMock,
    currentWorkspaceIdMock: vi.fn().mockResolvedValue("owner"),
  };
});

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/db", () => ({ prisma: prismaMock }));
vi.mock("@/lib/workspace", () => ({
  currentWorkspaceId: currentWorkspaceIdMock,
  isOwnerRequest: vi.fn().mockResolvedValue(true),
  MissingWorkspaceError: class extends Error {},
}));
vi.mock("@/lib/rewards", () => ({
  logReward: vi.fn(),
  awardBadge: vi.fn(),
  rewardStepDone: vi.fn(),
}));
vi.mock("@/lib/google", () => ({
  getValidAccessToken: vi.fn().mockResolvedValue(null),
  patchGoogleTask: vi.fn(),
}));

function stepWith(estimateHistory: string | null) {
  return {
    id: "s1",
    taskId: "t1",
    order: 1,
    total: 3,
    text: "do the thing",
    subtaskEmoji: null,
    estMinutes: 20,
    estimateHistory,
    googleTaskId: null,
    googleTaskListId: null,
  };
}

function lastUpdateHistory(): number[] {
  const call = prismaMock.step.update.mock.calls.at(-1)![0];
  return JSON.parse(call.data.estimateHistory) as number[];
}

beforeEach(() => {
  vi.clearAllMocks();
  prismaMock.step.update.mockResolvedValue({});
  prismaMock.step.findFirst.mockResolvedValue({
    id: "s1",
    task: { workspaceId: "owner" },
  });
  prismaMock.focusSession.findFirst.mockResolvedValue({
    id: "sess",
    workspaceId: "owner",
  });
});

describe("requeueFocus — estimateHistory JSON guard", () => {
  it("malformed estimateHistory → requeues without throwing, writes a valid history", async () => {
    prismaMock.focusSession.update.mockResolvedValue({
      step: stepWith("{not valid json"),
    });
    const { requeueFocus } = await import("./focus");
    await expect(
      requeueFocus("sess", { durationMin: 25, addedMin: 0, newEstMinutes: 30 }),
    ).resolves.toEqual({ ok: true });
    expect(lastUpdateHistory()).toEqual([20]); // corrupt → [] then push estMinutes
    expect(prismaMock.step.update.mock.calls.at(-1)![0].data.estMinutes).toBe(
      30,
    );
  });

  it("valid estimateHistory → appends the current estimate", async () => {
    prismaMock.focusSession.update.mockResolvedValue({
      step: stepWith("[10,15]"),
    });
    const { requeueFocus } = await import("./focus");
    await requeueFocus("sess", {
      durationMin: 25,
      addedMin: 0,
      newEstMinutes: 30,
    });
    expect(lastUpdateHistory()).toEqual([10, 15, 20]);
  });

  it("valid JSON that isn't an array → falls back to []", async () => {
    prismaMock.focusSession.update.mockResolvedValue({ step: stepWith("42") });
    const { requeueFocus } = await import("./focus");
    await requeueFocus("sess", {
      durationMin: 25,
      addedMin: 0,
      newEstMinutes: 30,
    });
    expect(lastUpdateHistory()).toEqual([20]);
  });
});

/**
 * #139 — a requeue wrote the new estimate correctly and then left `/` showing
 * the old one. `requeueFocus` revalidated `/tasks/{id}` and nothing else, while
 * every sibling mutation in this file also revalidates `/` — and `/` is exactly
 * where the estimate is rendered. The production database read
 * (`estMinutes` 10 → 60, `estimateHistory` `[10]`) proved the write landed, so
 * only the invalidation was missing: the feature looked broken while working.
 *
 * Asserted on the paths rather than on a rendered list because that is the
 * actual contract between the action and the router — a test that only checks
 * the database passes against this bug, which is how it reached production.
 */
describe("requeueFocus — cache invalidation (#139)", () => {
  beforeEach(() => {
    prismaMock.focusSession.update.mockResolvedValue({
      step: stepWith("[10]"),
    });
  });

  async function revalidatedPaths(): Promise<string[]> {
    const { requeueFocus } = await import("./focus");
    await requeueFocus("sess", {
      durationMin: 25,
      addedMin: 0,
      newEstMinutes: 60,
    });
    return vi.mocked(revalidatePath).mock.calls.map(([p]) => p);
  }

  it("revalidates the home list, where the estimate is displayed", async () => {
    expect(await revalidatedPaths()).toContain("/");
  });

  it("revalidates the dashboard, matching completeFocus", async () => {
    expect(await revalidatedPaths()).toContain("/dashboard");
  });

  it("still revalidates the task page", async () => {
    expect(await revalidatedPaths()).toContain("/tasks/t1");
  });

  it("does not revalidate when the ownership guard rejects the step", async () => {
    prismaMock.step.findFirst.mockResolvedValue(null);
    const { requeueFocus } = await import("./focus");
    await expect(
      requeueFocus("sess", { durationMin: 25, addedMin: 0, newEstMinutes: 60 }),
    ).resolves.toEqual({ ok: false });
    expect(vi.mocked(revalidatePath)).not.toHaveBeenCalled();
  });
});
