import { describe, it, expect, vi, beforeEach } from "vitest";

const { tx, db } = vi.hoisted(() => {
  const tx = {
    brainDumpItem: { deleteMany: vi.fn() },
    step: { deleteMany: vi.fn() },
    breakdownTurn: { deleteMany: vi.fn() },
    focusSession: { deleteMany: vi.fn() },
    dayRollup: { deleteMany: vi.fn() },
    rewardEvent: { deleteMany: vi.fn() },
    streak: { deleteMany: vi.fn() },
    streakRecord: { deleteMany: vi.fn() },
    badge: { deleteMany: vi.fn() },
    dailySpark: { deleteMany: vi.fn() },
    settings: { deleteMany: vi.fn() },
    task: { deleteMany: vi.fn() },
    workspace: { delete: vi.fn() },
  };
  const db = {
    $transaction: vi.fn(async (fn: any) => fn(tx)),
    workspace: { findMany: vi.fn() },
  };
  return { tx, db };
});

vi.mock("@/lib/db", () => ({ prisma: db }));

import { purgeWorkspace, purgeExpiredGuests } from "./purge";

beforeEach(() => vi.clearAllMocks());

describe("purgeWorkspace", () => {
  it("refuses to purge the owner workspace", async () => {
    await expect(purgeWorkspace("owner")).rejects.toThrow();
    expect(db.$transaction).not.toHaveBeenCalled();
  });
  it("deletes across scoped models then the workspace row", async () => {
    await purgeWorkspace("guest-123");
    expect(tx.task.deleteMany).toHaveBeenCalledWith({ where: { workspaceId: "guest-123" } });
    expect(tx.workspace.delete).toHaveBeenCalledWith({ where: { id: "guest-123" } });
  });
});

describe("purgeExpiredGuests", () => {
  it("purges each expired guest and returns the count", async () => {
    db.workspace.findMany.mockResolvedValue([{ id: "g1" }, { id: "g2" }]);
    const n = await purgeExpiredGuests();
    expect(n).toBe(2);
  });
});
