/**
 * Action tests for ensureFocusStep (▶ Focus on a single to-do).
 *
 * The focus timer is step-based, so the action guarantees the item has a
 * task with at least one step (created idempotently, mirroring the item's
 * text, 10-minute default) and returns the first not-done step id.
 *
 * Mirrors the vi.mock shape used in request-breakdown.test.ts.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const { prismaMock, revalidatePathMock, currentWorkspaceIdMock } = vi.hoisted(
  () => {
    const prismaMock = {
      brainDumpItem: {
        findFirst: vi.fn(),
        update: vi.fn().mockResolvedValue({}),
      },
      task: {
        create: vi.fn().mockResolvedValue({ id: "t-new" }),
      },
      step: {
        create: vi.fn().mockResolvedValue({ id: "s-new" }),
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
  MissingWorkspaceError: class extends Error {},
}));
vi.mock("@/lib/rewards", () => ({
  maybeAwardInboxZero: vi.fn().mockResolvedValue(undefined),
  maybeAwardTenStepsDay: vi.fn().mockResolvedValue(undefined),
  logReward: vi.fn().mockResolvedValue(undefined),
  awardBadge: vi.fn().mockResolvedValue(undefined),
  touchStreakOnCompletion: vi.fn().mockResolvedValue(null),
}));

beforeEach(() => {
  vi.clearAllMocks();
  currentWorkspaceIdMock.mockResolvedValue("owner");
  prismaMock.task.create.mockResolvedValue({ id: "t-new" });
  prismaMock.step.create.mockResolvedValue({ id: "s-new" });
});

describe("ensureFocusStep", () => {
  it("returns null when the item is missing", async () => {
    prismaMock.brainDumpItem.findFirst.mockResolvedValueOnce(null);
    const { ensureFocusStep } = await import("./braindump");
    expect(await ensureFocusStep("nope")).toBeNull();
    expect(prismaMock.step.create).not.toHaveBeenCalled();
  });

  it("item with no task: creates task + one 10-minute step mirroring the text", async () => {
    prismaMock.brainDumpItem.findFirst.mockResolvedValueOnce({
      id: "i1",
      text: "call the bank",
      taskId: null,
      task: null,
    });
    const { ensureFocusStep } = await import("./braindump");
    const stepId = await ensureFocusStep("i1");

    expect(prismaMock.task.create).toHaveBeenCalledTimes(1);
    expect(prismaMock.brainDumpItem.update).toHaveBeenCalledWith({
      where: { id: "i1" },
      data: { taskId: "t-new" },
    });
    expect(prismaMock.step.create).toHaveBeenCalledWith({
      data: {
        taskId: "t-new",
        text: "call the bank",
        order: 1,
        total: 1,
        estMinutes: 10,
      },
    });
    expect(stepId).toBe("s-new");
    expect(revalidatePathMock).toHaveBeenCalledWith("/");
  });

  it("item with a task but no steps: creates only the step", async () => {
    prismaMock.brainDumpItem.findFirst.mockResolvedValueOnce({
      id: "i1",
      text: "call the bank",
      taskId: "t1",
      task: { id: "t1", steps: [] },
    });
    const { ensureFocusStep } = await import("./braindump");
    const stepId = await ensureFocusStep("i1");
    expect(prismaMock.task.create).not.toHaveBeenCalled();
    expect(prismaMock.step.create).toHaveBeenCalledWith({
      data: {
        taskId: "t1",
        text: "call the bank",
        order: 1,
        total: 1,
        estMinutes: 10,
      },
    });
    expect(stepId).toBe("s-new");
  });

  it("item with existing steps: idempotent — returns the first not-done step, creates nothing", async () => {
    prismaMock.brainDumpItem.findFirst.mockResolvedValueOnce({
      id: "i1",
      text: "x",
      taskId: "t1",
      task: {
        id: "t1",
        steps: [
          { id: "s1", done: true },
          { id: "s2", done: false },
        ],
      },
    });
    const { ensureFocusStep } = await import("./braindump");
    expect(await ensureFocusStep("i1")).toBe("s2");
    expect(prismaMock.step.create).not.toHaveBeenCalled();
    expect(prismaMock.task.create).not.toHaveBeenCalled();
  });
});
