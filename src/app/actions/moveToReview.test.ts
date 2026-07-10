import { describe, it, expect, vi, beforeEach } from "vitest";

const { prismaMock, revalidatePathMock, currentWorkspaceIdMock } = vi.hoisted(() => {
  const prismaMock = {
    brainDumpItem: {
      findFirst: vi.fn(),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      update: vi.fn().mockResolvedValue({}),
    },
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

describe("moveToReview", () => {
  it("no-ops when the item is missing", async () => {
    prismaMock.brainDumpItem.findFirst.mockResolvedValueOnce(null);
    const { moveToReview } = await import("./braindump");
    await moveToReview("nope");
    expect(prismaMock.brainDumpItem.updateMany).not.toHaveBeenCalled();
  });

  it("un-triages: status=inbox, clears triagedAt/snoozedUntil/completedAt, keeps taskId", async () => {
    prismaMock.brainDumpItem.findFirst.mockResolvedValueOnce({ id: "i1", taskId: "t1" });
    const { moveToReview } = await import("./braindump");
    await moveToReview("i1");
    expect(prismaMock.brainDumpItem.updateMany).toHaveBeenCalledWith({
      where: { id: "i1", workspaceId: "owner" },
      data: { status: "inbox", triagedAt: null, snoozedUntil: null, completedAt: null },
    });
    // taskId is NOT in the data payload → left intact
    const data = prismaMock.brainDumpItem.updateMany.mock.calls[0][0].data;
    expect("taskId" in data).toBe(false);
    expect(revalidatePathMock).toHaveBeenCalledWith("/inbox");
  });

  it("is workspace-scoped (findFirst gated on workspaceId)", async () => {
    prismaMock.brainDumpItem.findFirst.mockResolvedValueOnce({ id: "i1", taskId: null });
    const { moveToReview } = await import("./braindump");
    await moveToReview("i1");
    expect(prismaMock.brainDumpItem.findFirst.mock.calls[0][0].where).toEqual({ id: "i1", workspaceId: "owner" });
  });
});
