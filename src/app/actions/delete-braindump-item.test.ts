/**
 * Action tests for deleteBrainDumpItem — #64 (focus↔library data integrity).
 *
 * Root cause: deleting a BrainDumpItem used to delete only that row, leaving
 * its linked Task (+ Steps/BreakdownTurns) behind as a permanent orphan —
 * invisible to the Library (whose only source query is BrainDumpItem) but
 * still surfaced forever in the Focus launcher (which reads Task directly).
 * These tests pin the fix: deleting the last BrainDumpItem referencing a
 * Task must also delete that Task, inside one transaction.
 *
 * Mirrors the vi.mock shape used in complete.test.ts ($transaction support).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const { prismaMock, revalidatePathMock, currentWorkspaceIdMock } = vi.hoisted(
  () => {
    const prismaMock = {
      brainDumpItem: {
        findFirst: vi.fn(),
        deleteMany: vi.fn().mockResolvedValue({ count: 1 }),
        count: vi.fn().mockResolvedValue(0),
      },
      task: {
        deleteMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
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
  prismaMock.brainDumpItem.deleteMany.mockResolvedValue({ count: 1 });
  prismaMock.brainDumpItem.count.mockResolvedValue(0);
});

describe("deleteBrainDumpItem", () => {
  it("no-ops when the item is missing (workspace-scoped)", async () => {
    prismaMock.brainDumpItem.findFirst.mockResolvedValueOnce(null);
    const { deleteBrainDumpItem } = await import("./braindump");

    await deleteBrainDumpItem("nope");

    expect(prismaMock.$transaction).not.toHaveBeenCalled();
    expect(prismaMock.brainDumpItem.deleteMany).not.toHaveBeenCalled();
  });

  it("deletes a single-task item (no linked Task) without touching Task at all", async () => {
    prismaMock.brainDumpItem.findFirst.mockResolvedValueOnce({
      id: "i1",
      taskId: null,
    });
    const { deleteBrainDumpItem } = await import("./braindump");

    await deleteBrainDumpItem("i1");

    expect(prismaMock.brainDumpItem.deleteMany).toHaveBeenCalledWith({
      where: { id: "i1", workspaceId: "owner" },
    });
    expect(prismaMock.brainDumpItem.count).not.toHaveBeenCalled();
    expect(prismaMock.task.deleteMany).not.toHaveBeenCalled();
  });

  it("deletes the linked Task too when it was the last BrainDumpItem referencing it — no orphan left behind (#64)", async () => {
    prismaMock.brainDumpItem.findFirst.mockResolvedValueOnce({
      id: "i1",
      taskId: "t1",
    });
    prismaMock.brainDumpItem.count.mockResolvedValueOnce(0); // no other item still points at t1
    const { deleteBrainDumpItem } = await import("./braindump");

    await deleteBrainDumpItem("i1");

    expect(prismaMock.brainDumpItem.deleteMany).toHaveBeenCalledWith({
      where: { id: "i1", workspaceId: "owner" },
    });
    expect(prismaMock.brainDumpItem.count).toHaveBeenCalledWith({
      where: { taskId: "t1" },
    });
    expect(prismaMock.task.deleteMany).toHaveBeenCalledWith({
      where: { id: "t1", workspaceId: "owner" },
    });
  });

  it("keeps the linked Task when another BrainDumpItem still references it", async () => {
    prismaMock.brainDumpItem.findFirst.mockResolvedValueOnce({
      id: "i1",
      taskId: "t1",
    });
    prismaMock.brainDumpItem.count.mockResolvedValueOnce(1); // another item still points at t1
    const { deleteBrainDumpItem } = await import("./braindump");

    await deleteBrainDumpItem("i1");

    expect(prismaMock.task.deleteMany).not.toHaveBeenCalled();
  });

  it("runs the item delete + task cleanup inside one transaction", async () => {
    prismaMock.brainDumpItem.findFirst.mockResolvedValueOnce({
      id: "i1",
      taskId: "t1",
    });
    prismaMock.brainDumpItem.count.mockResolvedValueOnce(0);
    const { deleteBrainDumpItem } = await import("./braindump");

    await deleteBrainDumpItem("i1");

    expect(prismaMock.$transaction).toHaveBeenCalledTimes(1);
    expect(prismaMock.$transaction.mock.calls[0][0]).toBeInstanceOf(Function);
  });

  it("does not throw and skips Task cleanup when the item was already deleted concurrently (race between the read and the transaction)", async () => {
    // `existing` was found by the pre-transaction read (so we know its taskId),
    // but by the time the transaction's deleteMany runs, a concurrent
    // deleteBrainDumpItem call already removed the row — deleteMany matches
    // 0 rows instead of throwing (unlike `delete`, which would P2025 here).
    prismaMock.brainDumpItem.findFirst.mockResolvedValueOnce({
      id: "i1",
      taskId: "t1",
    });
    prismaMock.brainDumpItem.deleteMany.mockResolvedValueOnce({ count: 0 });
    const { deleteBrainDumpItem } = await import("./braindump");

    await expect(deleteBrainDumpItem("i1")).resolves.toBeUndefined();

    expect(prismaMock.brainDumpItem.count).not.toHaveBeenCalled();
    expect(prismaMock.task.deleteMany).not.toHaveBeenCalled();
  });

  it("still awards inbox-zero + revalidates after cleanup", async () => {
    prismaMock.brainDumpItem.findFirst.mockResolvedValueOnce({
      id: "i1",
      taskId: null,
    });
    const { deleteBrainDumpItem } = await import("./braindump");
    const rewards = await import("@/lib/rewards");

    await deleteBrainDumpItem("i1");

    expect(rewards.maybeAwardInboxZero).toHaveBeenCalledWith("owner");
    expect(revalidatePathMock).toHaveBeenCalledWith("/");
  });
});
