/**
 * Action tests for setItemEstimate (workspace-scoped, clamped time estimate).
 *
 * Mirrors the vi.mock shape used in snooze.test.ts / moveToReview.test.ts —
 * importing anything from braindump.ts loads the whole module, which pulls
 * in @/lib/rewards and @/lib/constants at the top level. The mock surface
 * has to satisfy that full module graph, not just the function under test.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const { prismaMock, revalidatePathMock, currentWorkspaceIdMock } = vi.hoisted(
  () => {
    const prismaMock = {
      brainDumpItem: {
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
    };
    return {
      prismaMock,
      revalidatePathMock: vi.fn(),
      currentWorkspaceIdMock: vi.fn().mockResolvedValue("ws1"),
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
  currentWorkspaceIdMock.mockResolvedValue("ws1");
  prismaMock.brainDumpItem.updateMany.mockResolvedValue({ count: 1 });
});

describe("setItemEstimate", () => {
  it("scopes the update to the current workspace", async () => {
    const { setItemEstimate } = await import("./braindump");
    await setItemEstimate("i1", 25);
    expect(prismaMock.brainDumpItem.updateMany).toHaveBeenCalledWith({
      where: { id: "i1", workspaceId: "ws1" },
      data: { estMinutes: 25 },
    });
  });

  it("clamps to [1, 600] and rounds", async () => {
    const { setItemEstimate } = await import("./braindump");
    await setItemEstimate("i1", 0);
    expect(prismaMock.brainDumpItem.updateMany).toHaveBeenLastCalledWith(
      expect.objectContaining({ data: { estMinutes: 1 } }),
    );
    await setItemEstimate("i1", 9999);
    expect(prismaMock.brainDumpItem.updateMany).toHaveBeenLastCalledWith(
      expect.objectContaining({ data: { estMinutes: 600 } }),
    );
    await setItemEstimate("i1", 12.6);
    expect(prismaMock.brainDumpItem.updateMany).toHaveBeenLastCalledWith(
      expect.objectContaining({ data: { estMinutes: 13 } }),
    );
  });

  it("ignores non-finite input", async () => {
    const { setItemEstimate } = await import("./braindump");
    await setItemEstimate("i1", Number.NaN);
    expect(prismaMock.brainDumpItem.updateMany).not.toHaveBeenCalled();
  });

  it("revalidates / and /library", async () => {
    const { setItemEstimate } = await import("./braindump");
    await setItemEstimate("i1", 25);
    expect(revalidatePathMock).toHaveBeenCalledWith("/");
    expect(revalidatePathMock).toHaveBeenCalledWith("/library");
  });
});
