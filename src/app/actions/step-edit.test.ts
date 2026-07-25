/**
 * Action tests for the two step inline-editor actions added for the TaskSteps
 * row redesign: renameStep + updateStepEstimate. Both are workspace-scoped like
 * completeStep (findFirst gated on task.workspaceId). Mirrors the mock shape in
 * complete.test.ts so importing ./focus resolves cleanly.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { prismaMock, revalidatePathMock, currentWorkspaceIdMock } = vi.hoisted(
  () => {
    const prismaMock = {
      step: { findFirst: vi.fn(), update: vi.fn().mockResolvedValue({}) },
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
  logReward: vi.fn().mockResolvedValue(undefined),
  awardBadge: vi.fn().mockResolvedValue(true),
  rewardStepDone: vi.fn().mockResolvedValue(null),
}));
vi.mock("@/lib/google", () => ({
  getValidAccessToken: vi.fn().mockResolvedValue(null),
  patchGoogleTask: vi.fn().mockResolvedValue(undefined),
}));

beforeEach(() => {
  vi.clearAllMocks();
  currentWorkspaceIdMock.mockResolvedValue("owner");
  prismaMock.step.update.mockResolvedValue({});
});

describe("renameStep", () => {
  it("updates Step.text (trimmed) + revalidates, workspace-scoped", async () => {
    prismaMock.step.findFirst.mockResolvedValueOnce({
      id: "s1",
      taskId: "t1",
      text: "old",
    });
    const { renameStep } = await import("./focus");
    await renameStep("s1", "  new title  ");
    expect(prismaMock.step.findFirst.mock.calls[0][0].where).toEqual({
      id: "s1",
      task: { workspaceId: "owner" },
    });
    expect(prismaMock.step.update).toHaveBeenCalledWith({
      where: { id: "s1" },
      data: { text: "new title" },
    });
    expect(revalidatePathMock).toHaveBeenCalledWith("/tasks/t1");
    expect(revalidatePathMock).toHaveBeenCalledWith("/");
  });

  it("rejects when the step is not in the workspace (findFirst null)", async () => {
    prismaMock.step.findFirst.mockResolvedValueOnce(null);
    const { renameStep } = await import("./focus");
    await renameStep("nope", "whatever");
    expect(prismaMock.step.update).not.toHaveBeenCalled();
  });

  it("no-ops on an empty/whitespace title", async () => {
    prismaMock.step.findFirst.mockResolvedValueOnce({
      id: "s1",
      taskId: "t1",
      text: "old",
    });
    const { renameStep } = await import("./focus");
    await renameStep("s1", "   ");
    expect(prismaMock.step.update).not.toHaveBeenCalled();
  });

  it("no-ops when the trimmed title is unchanged", async () => {
    prismaMock.step.findFirst.mockResolvedValueOnce({
      id: "s1",
      taskId: "t1",
      text: "same",
    });
    const { renameStep } = await import("./focus");
    await renameStep("s1", "  same  ");
    expect(prismaMock.step.update).not.toHaveBeenCalled();
  });
});

describe("updateStepEstimate", () => {
  it("rounds + updates Step.estMinutes + revalidates, workspace-scoped", async () => {
    prismaMock.step.findFirst.mockResolvedValueOnce({
      id: "s1",
      taskId: "t1",
      estMinutes: 10,
    });
    const { updateStepEstimate } = await import("./focus");
    await updateStepEstimate("s1", 24.6);
    expect(prismaMock.step.findFirst.mock.calls[0][0].where).toEqual({
      id: "s1",
      task: { workspaceId: "owner" },
    });
    expect(prismaMock.step.update).toHaveBeenCalledWith({
      where: { id: "s1" },
      data: { estMinutes: 25 },
    });
    expect(revalidatePathMock).toHaveBeenCalledWith("/tasks/t1");
    expect(revalidatePathMock).toHaveBeenCalledWith("/");
  });

  it("rejects when the step is not in the workspace (findFirst null)", async () => {
    prismaMock.step.findFirst.mockResolvedValueOnce(null);
    const { updateStepEstimate } = await import("./focus");
    await updateStepEstimate("nope", 30);
    expect(prismaMock.step.update).not.toHaveBeenCalled();
  });

  it("clamps values above 480 down to 480", async () => {
    prismaMock.step.findFirst.mockResolvedValueOnce({
      id: "s1",
      taskId: "t1",
      estMinutes: 10,
    });
    const { updateStepEstimate } = await import("./focus");
    await updateStepEstimate("s1", 999);
    expect(prismaMock.step.update).toHaveBeenCalledWith({
      where: { id: "s1" },
      data: { estMinutes: 480 },
    });
  });

  it("clamps values below 1 up to 1", async () => {
    prismaMock.step.findFirst.mockResolvedValueOnce({
      id: "s1",
      taskId: "t1",
      estMinutes: 10,
    });
    const { updateStepEstimate } = await import("./focus");
    await updateStepEstimate("s1", 0);
    expect(prismaMock.step.update).toHaveBeenCalledWith({
      where: { id: "s1" },
      data: { estMinutes: 1 },
    });
  });
});
