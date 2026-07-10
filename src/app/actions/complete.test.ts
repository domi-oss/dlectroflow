import { describe, it, expect, vi, beforeEach } from "vitest";

const { prismaMock, revalidatePathMock, currentWorkspaceIdMock } = vi.hoisted(() => {
  const prismaMock = {
    brainDumpItem: {
      findFirst: vi.fn(),
      update: vi.fn().mockResolvedValue({}),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    step: { updateMany: vi.fn().mockResolvedValue({ count: 0 }), update: vi.fn(), findFirst: vi.fn() },
    task: { update: vi.fn().mockResolvedValue({}) },
    rewardEvent: { create: vi.fn().mockResolvedValue({}), count: vi.fn().mockResolvedValue(0) },
    badge: { findUnique: vi.fn().mockResolvedValue(null), create: vi.fn().mockResolvedValue({}) },
    streak: {}, settings: {}, streakRecord: {},
  };
  return { prismaMock, revalidatePathMock: vi.fn(), currentWorkspaceIdMock: vi.fn().mockResolvedValue("owner") };
});
vi.mock("next/cache", () => ({ revalidatePath: revalidatePathMock }));
vi.mock("@/lib/db", () => ({ prisma: prismaMock }));
vi.mock("@/lib/workspace", () => ({
  currentWorkspaceId: currentWorkspaceIdMock,
  isOwnerRequest: vi.fn().mockResolvedValue(true),
  MissingWorkspaceError: class extends Error {},
}));
// keep reward side-effects simple + observable
vi.mock("@/lib/rewards", () => ({
  logReward: vi.fn().mockResolvedValue(undefined),
  awardBadge: vi.fn().mockResolvedValue(true),
  rewardStepDone: vi.fn().mockResolvedValue(null),
  touchStreakOnCompletion: vi.fn().mockResolvedValue(null),
  maybeAwardInboxZero: vi.fn().mockResolvedValue(undefined),
}));
import { logReward, awardBadge } from "@/lib/rewards";

beforeEach(() => {
  vi.clearAllMocks();
  currentWorkspaceIdMock.mockResolvedValue("owner");
});

describe("completeItem", () => {
  it("no-ops when the item is missing or already completed", async () => {
    prismaMock.brainDumpItem.findFirst.mockResolvedValueOnce(null);
    const { completeItem } = await import("./braindump");
    await completeItem("x");
    expect(prismaMock.brainDumpItem.update).not.toHaveBeenCalled();

    prismaMock.brainDumpItem.findFirst.mockResolvedValueOnce({ id: "i1", completedAt: new Date(), task: null });
    await completeItem("i1");
    expect(prismaMock.brainDumpItem.update).not.toHaveBeenCalled();
  });

  it("stamps completedAt + awards TaskComplete for a single-task item (no task)", async () => {
    prismaMock.brainDumpItem.findFirst.mockResolvedValueOnce({ id: "i1", completedAt: null, task: null });
    const { completeItem } = await import("./braindump");
    await completeItem("i1");
    const upd = prismaMock.brainDumpItem.update.mock.calls[0][0];
    expect(upd.where).toEqual({ id: "i1" });
    expect(upd.data.completedAt).toBeInstanceOf(Date);
    expect(logReward).toHaveBeenCalledWith("owner", "task_complete");
    expect(awardBadge).toHaveBeenCalledWith("owner", "task_complete");
  });

  it("completes a multi-step task: all steps + task done, credits StepDone per not-done step", async () => {
    prismaMock.brainDumpItem.findFirst.mockResolvedValueOnce({
      id: "i2", completedAt: null,
      task: { id: "t1", steps: [{ id: "s1", done: true }, { id: "s2", done: false }, { id: "s3", done: false }] },
    });
    const { completeItem } = await import("./braindump");
    await completeItem("i2");
    expect(prismaMock.step.updateMany).toHaveBeenCalledWith({ where: { taskId: "t1" }, data: { done: true } });
    expect(prismaMock.task.update).toHaveBeenCalledWith({ where: { id: "t1" }, data: { status: "done" } });
    // 2 not-done steps → 2 StepDone + 1 TaskComplete
    const stepDoneCalls = (logReward as unknown as ReturnType<typeof vi.fn>).mock.calls.filter((c) => c[1] === "step_done");
    expect(stepDoneCalls).toHaveLength(2);
    expect(logReward).toHaveBeenCalledWith("owner", "task_complete");
  });

  it("is workspace-scoped (findFirst gated on workspaceId)", async () => {
    prismaMock.brainDumpItem.findFirst.mockResolvedValueOnce({ id: "i1", completedAt: null, task: null });
    const { completeItem } = await import("./braindump");
    await completeItem("i1");
    expect(prismaMock.brainDumpItem.findFirst.mock.calls[0][0].where).toEqual({ id: "i1", workspaceId: "owner" });
  });
});
