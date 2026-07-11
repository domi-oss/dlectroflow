/**
 * Action tests for snoozeBrainDumpItem ("Save for later").
 *
 * Final-review fix: snoozing must also un-triage the item (status → inbox,
 * triagedAt → null) so a triaged single-task/multi-step to-do actually lands
 * in the Saved-for-later bucket (bucket.ts's savedLater rule requires
 * status === "inbox"). Before this fix, snoozing a triaged item was a silent
 * no-op from the user's point of view — it stayed in its original bucket.
 *
 * Mirrors the vi.mock shape used in moveToReview.test.ts.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const { prismaMock, revalidatePathMock, currentWorkspaceIdMock } = vi.hoisted(() => {
  const prismaMock = {
    brainDumpItem: {
      findFirst: vi.fn(),
      update: vi.fn().mockResolvedValue({}),
    },
  };
  return {
    prismaMock,
    revalidatePathMock: vi.fn(),
    currentWorkspaceIdMock: vi.fn().mockResolvedValue("owner"),
  };
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

describe("snoozeBrainDumpItem", () => {
  it("no-ops when the item is missing", async () => {
    prismaMock.brainDumpItem.findFirst.mockResolvedValueOnce(null);
    const { snoozeBrainDumpItem } = await import("./braindump");
    await snoozeBrainDumpItem("nope", 60);
    expect(prismaMock.brainDumpItem.update).not.toHaveBeenCalled();
  });

  it("un-triages into Saved-for-later: status=inbox, triagedAt=null, remindedAt=null, snoozedUntil in the future", async () => {
    prismaMock.brainDumpItem.findFirst.mockResolvedValueOnce({ id: "i1" });
    const { snoozeBrainDumpItem } = await import("./braindump");
    const before = Date.now();
    await snoozeBrainDumpItem("i1", 60);

    expect(prismaMock.brainDumpItem.update).toHaveBeenCalledTimes(1);
    const call = prismaMock.brainDumpItem.update.mock.calls[0][0];
    expect(call.where).toEqual({ id: "i1" });
    expect(call.data.status).toBe("inbox");
    expect(call.data.triagedAt).toBeNull();
    expect(call.data.remindedAt).toBeNull();
    expect(call.data.snoozedUntil).toBeInstanceOf(Date);
    expect(call.data.snoozedUntil.getTime()).toBeGreaterThan(before);
  });

  it("revalidates /inbox", async () => {
    prismaMock.brainDumpItem.findFirst.mockResolvedValueOnce({ id: "i1" });
    const { snoozeBrainDumpItem } = await import("./braindump");
    await snoozeBrainDumpItem("i1", 60);
    expect(revalidatePathMock).toHaveBeenCalledWith("/inbox");
  });
});
