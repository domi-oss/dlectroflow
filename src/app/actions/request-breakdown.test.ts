/**
 * Action tests for requestBreakdown + breakdownRequestedAt lifecycle.
 *
 * Dropping onto Multi-step moves the item immediately: triaged +
 * breakdownRequestedAt stamped, so it sits in the Multi-step bucket with a
 * "Break into steps now?" call-to-action instead of a blocking prompt.
 * Any move to another bucket (triage / snooze / moveToReview / complete /
 * keepAsTask) clears the stamp — moving out means you changed your mind.
 *
 * Mirrors the vi.mock shape used in snooze.test.ts.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const { prismaMock, revalidatePathMock, currentWorkspaceIdMock } = vi.hoisted(
  () => {
    const prismaMock = {
      brainDumpItem: {
        findFirst: vi.fn(),
        update: vi.fn().mockResolvedValue({}),
        updateMany: vi.fn().mockResolvedValue({}),
      },
      task: {
        create: vi.fn().mockResolvedValue({ id: "t1" }),
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
});

describe("requestBreakdown", () => {
  it("no-ops when the item is missing", async () => {
    prismaMock.brainDumpItem.findFirst.mockResolvedValueOnce(null);
    const { requestBreakdown } = await import("./braindump");
    await requestBreakdown("nope");
    expect(prismaMock.brainDumpItem.update).not.toHaveBeenCalled();
  });

  it("triages + stamps breakdownRequestedAt + clears snoozedUntil", async () => {
    prismaMock.brainDumpItem.findFirst.mockResolvedValueOnce({ id: "i1" });
    const { requestBreakdown } = await import("./braindump");
    await requestBreakdown("i1");

    const call = prismaMock.brainDumpItem.update.mock.calls[0][0];
    expect(call.where).toEqual({ id: "i1" });
    expect(call.data.status).toBe("triaged");
    expect(call.data.triagedAt).toBeInstanceOf(Date);
    expect(call.data.breakdownRequestedAt).toBeInstanceOf(Date);
    expect(call.data.snoozedUntil).toBeNull();
    expect(revalidatePathMock).toHaveBeenCalledWith("/inbox");
  });
});

describe("breakdownRequestedAt is cleared by every move out of Multi-step", () => {
  it("triageBrainDumpItem (→ Single-task) clears it", async () => {
    prismaMock.brainDumpItem.findFirst.mockResolvedValueOnce({ id: "i1" });
    const { triageBrainDumpItem } = await import("./braindump");
    await triageBrainDumpItem("i1");
    expect(
      prismaMock.brainDumpItem.update.mock.calls[0][0].data
        .breakdownRequestedAt,
    ).toBeNull();
  });

  it("snoozeBrainDumpItem (→ Saved for later) clears it", async () => {
    prismaMock.brainDumpItem.findFirst.mockResolvedValueOnce({ id: "i1" });
    const { snoozeBrainDumpItem } = await import("./braindump");
    await snoozeBrainDumpItem("i1", 60);
    expect(
      prismaMock.brainDumpItem.update.mock.calls[0][0].data
        .breakdownRequestedAt,
    ).toBeNull();
  });

  it("moveToReview (→ Needs review) clears it", async () => {
    prismaMock.brainDumpItem.findFirst.mockResolvedValueOnce({ id: "i1" });
    const { moveToReview } = await import("./braindump");
    await moveToReview("i1");
    expect(
      prismaMock.brainDumpItem.updateMany.mock.calls[0][0].data
        .breakdownRequestedAt,
    ).toBeNull();
  });

  it("completeItem (→ Completed) clears it", async () => {
    prismaMock.brainDumpItem.findFirst.mockResolvedValueOnce({
      id: "i1",
      completedAt: null,
      task: null,
    });
    const { completeItem } = await import("./braindump");
    await completeItem("i1");
    expect(
      prismaMock.brainDumpItem.update.mock.calls[0][0].data
        .breakdownRequestedAt,
    ).toBeNull();
  });

  it("keepAsTask (→ Single-task with a task) clears it", async () => {
    prismaMock.brainDumpItem.findFirst.mockResolvedValueOnce({
      id: "i1",
      text: "x",
    });
    const { keepAsTask } = await import("./braindump");
    await keepAsTask("i1");
    expect(
      prismaMock.brainDumpItem.update.mock.calls[0][0].data
        .breakdownRequestedAt,
    ).toBeNull();
  });
});
