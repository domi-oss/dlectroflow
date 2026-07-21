/**
 * Decision 1 (#8 Phase 7): the streak advances on ANY qualifying action —
 * a capture, a breakdown-confirm, and a focus-step completion. This asserts
 * each of the three actions routes into the shared engagement fn, plus the
 * action-triggered badges FirstBreakdown + FirstFocus.
 * (FirstSchedule → ics-schedule.test.ts; TaskComplete → complete.test.ts;
 *  Streak5/Comeback/InboxZero → rewards-streak.test.ts.)
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { prismaMock, revalidatePathMock, currentWorkspaceIdMock } = vi.hoisted(
  () => {
    const prismaMock = {
      brainDumpItem: {
        create: vi.fn().mockResolvedValue({ id: "item-1" }),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      task: {
        findFirst: vi.fn().mockResolvedValue({ id: "t1" }),
        update: vi.fn().mockResolvedValue({}),
      },
      step: {
        findFirst: vi.fn(),
        update: vi.fn().mockResolvedValue({}),
        deleteMany: vi.fn().mockResolvedValue({}),
        createMany: vi.fn().mockResolvedValue({}),
      },
      focusSession: { create: vi.fn().mockResolvedValue({ id: "sess" }) },
      $transaction: vi.fn(),
    };
    prismaMock.$transaction.mockImplementation((arg: unknown) =>
      typeof arg === "function"
        ? (arg as (tx: unknown) => unknown)(prismaMock)
        : Promise.all(arg as Promise<unknown>[]),
    );
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
  MissingWorkspaceError: class extends Error {},
}));
vi.mock("@/lib/google", () => ({
  getValidAccessToken: vi.fn().mockResolvedValue(null),
  patchGoogleTask: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/rewards", () => ({
  logReward: vi.fn().mockResolvedValue(undefined),
  awardBadge: vi.fn().mockResolvedValue(true),
  rewardStepDone: vi.fn().mockResolvedValue(null),
  touchStreakOnEngagement: vi.fn().mockResolvedValue(null),
  touchStreakOnCompletion: vi.fn().mockResolvedValue(null),
  maybeAwardInboxZero: vi.fn().mockResolvedValue(undefined),
  maybeAwardTenStepsDay: vi.fn().mockResolvedValue(undefined),
}));

import {
  touchStreakOnEngagement,
  awardBadge,
  rewardStepDone,
} from "@/lib/rewards";
import { BadgeKey } from "@/lib/constants";

beforeEach(() => {
  vi.clearAllMocks();
  currentWorkspaceIdMock.mockResolvedValue("owner");
  prismaMock.task.findFirst.mockResolvedValue({ id: "t1" });
  prismaMock.brainDumpItem.create.mockResolvedValue({ id: "item-1" });
  prismaMock.focusSession.create.mockResolvedValue({ id: "sess" });
});

describe("streak engagement — the three qualifying actions", () => {
  it("capture (createBrainDumpItem) advances the streak", async () => {
    const { createBrainDumpItem } = await import("./braindump");
    await createBrainDumpItem("buy milk");
    expect(prismaMock.brainDumpItem.create).toHaveBeenCalledTimes(1);
    expect(touchStreakOnEngagement).toHaveBeenCalledWith("owner");
  });

  it("an empty capture does NOT advance the streak", async () => {
    const { createBrainDumpItem } = await import("./braindump");
    await createBrainDumpItem("   ");
    expect(touchStreakOnEngagement).not.toHaveBeenCalled();
  });

  it("breakdown-confirm (confirmBreakdown) advances the streak", async () => {
    const { confirmBreakdown } = await import("./breakdown");
    await confirmBreakdown("t1", {
      parentEmoji: "🚀",
      steps: [{ text: "step one", estMinutes: 10, subtaskEmoji: "📝" }],
    });
    expect(touchStreakOnEngagement).toHaveBeenCalledWith("owner");
  });

  it("focus-step completion (completeStep) advances the streak via rewardStepDone", async () => {
    prismaMock.step.findFirst.mockResolvedValueOnce({
      id: "s1",
      taskId: "t1",
      done: false,
      task: {
        id: "t1",
        steps: [
          { id: "s1", done: false },
          { id: "s2", done: false },
        ],
      },
    });
    const { completeStep } = await import("./focus");
    await completeStep("s1");
    expect(rewardStepDone).toHaveBeenCalledWith("owner");
  });
});

describe("action-triggered badges", () => {
  it("confirmBreakdown awards FirstBreakdown", async () => {
    const { confirmBreakdown } = await import("./breakdown");
    await confirmBreakdown("t1", {
      parentEmoji: "🚀",
      steps: [{ text: "step one", estMinutes: 10, subtaskEmoji: "📝" }],
    });
    expect(awardBadge).toHaveBeenCalledWith("owner", BadgeKey.FirstBreakdown);
  });

  it("beginFocus awards FirstFocus (fires each begin — dedup is awardBadge's job)", async () => {
    prismaMock.step.findFirst.mockResolvedValue({ id: "s1", taskId: "t1" });
    const { beginFocus } = await import("./focus");
    await beginFocus("s1", 25);
    await beginFocus("s1", 25);
    const focusCalls = (
      awardBadge as unknown as ReturnType<typeof vi.fn>
    ).mock.calls.filter((c) => c[1] === BadgeKey.FirstFocus);
    expect(focusCalls).toHaveLength(2);
    expect(focusCalls[0]).toEqual(["owner", BadgeKey.FirstFocus]);
  });
});
