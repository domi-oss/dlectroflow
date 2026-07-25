/**
 * Action tests for renameItem (✎ edit title on any inbox row).
 * Renaming keeps a linked task's title in sync (editor/timer never show a
 * stale name); empty/whitespace input is a no-op.
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
        update: vi.fn().mockResolvedValue({}),
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

describe("renameItem", () => {
  it("no-ops on empty / whitespace-only input", async () => {
    const { renameItem } = await import("./braindump");
    await renameItem("i1", "   ");
    expect(prismaMock.brainDumpItem.findFirst).not.toHaveBeenCalled();
    expect(prismaMock.brainDumpItem.update).not.toHaveBeenCalled();
  });

  it("no-ops when the item is missing (workspace-scoped)", async () => {
    prismaMock.brainDumpItem.findFirst.mockResolvedValueOnce(null);
    const { renameItem } = await import("./braindump");
    await renameItem("nope", "new name");
    expect(prismaMock.brainDumpItem.update).not.toHaveBeenCalled();
  });

  it("renames the item (trimmed) and revalidates /", async () => {
    prismaMock.brainDumpItem.findFirst.mockResolvedValueOnce({
      id: "i1",
      taskId: null,
    });
    const { renameItem } = await import("./braindump");
    await renameItem("i1", "  new name  ");
    expect(prismaMock.brainDumpItem.update).toHaveBeenCalledWith({
      where: { id: "i1" },
      data: { text: "new name" },
    });
    expect(prismaMock.task.update).not.toHaveBeenCalled();
    expect(revalidatePathMock).toHaveBeenCalledWith("/");
  });

  it("keeps a linked task's title in sync and revalidates its page", async () => {
    prismaMock.brainDumpItem.findFirst.mockResolvedValueOnce({
      id: "i1",
      taskId: "t1",
    });
    const { renameItem } = await import("./braindump");
    await renameItem("i1", "new name");
    expect(prismaMock.task.update).toHaveBeenCalledWith({
      where: { id: "t1" },
      data: { title: "new name" },
    });
    expect(revalidatePathMock).toHaveBeenCalledWith("/tasks/t1");
    expect(revalidatePathMock).toHaveBeenCalledWith("/");
  });
});
