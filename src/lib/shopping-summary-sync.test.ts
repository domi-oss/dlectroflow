import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * #199 — the summary's writes. Its own file because the module is, and the module is
 * split because the pure half is imported by a `"use client"` component: see the
 * doc on `shopping-summary-sync.ts`, and `client-server-boundary.test.ts` for the
 * gate that keeps the split honest.
 *
 * `upsert` is MOCKED here, so everything below asserts a payload. That is the right
 * shape for the branch logic and the wrong one for the `create`/`update` split: a
 * mocked upsert has neither a row nor an absent row, so "the row exists" and "no row
 * yet" are the same test twice. Anything that depends on which clause actually ran
 * belongs in `shopping-summary-sync.integration.test.ts` instead (Duo review, !295).
 */

const { prismaMock } = vi.hoisted(() => ({
  prismaMock: {
    shoppingItem: { count: vi.fn() },
    shoppingSummary: {
      upsert: vi.fn().mockResolvedValue({}),
      deleteMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
  },
}));
vi.mock("@/lib/db", () => ({ prisma: prismaMock }));

beforeEach(() => {
  vi.clearAllMocks();
  prismaMock.shoppingItem.count.mockResolvedValue(2);
});

describe("syncShoppingSummary", () => {
  const load = () => import("@/lib/shopping-summary-sync");

  it("counts only what is still to buy", async () => {
    const { syncShoppingSummary } = await load();
    await syncShoppingSummary("ws-1", { resurface: false });
    expect(prismaMock.shoppingItem.count).toHaveBeenCalledWith({
      where: { workspaceId: "ws-1", done: false, savedForLater: false },
    });
  });

  it("creates the row when the list becomes non-empty", async () => {
    const { syncShoppingSummary } = await load();
    await syncShoppingSummary("ws-1", { resurface: true });
    expect(prismaMock.shoppingSummary.upsert).toHaveBeenCalledWith({
      where: { workspaceId: "ws-1" },
      create: { workspaceId: "ws-1" },
      update: { clearedAt: null },
    });
  });

  // The upsert is keyed on the PRIMARY KEY, which is the whole concurrency story:
  // two adds racing cannot create two summary rows, because the loser's insert
  // collides and becomes an update. A findFirst-then-create would need
  // Serializable or an advisory lock to say the same thing.
  it("leaves a dismissal alone for a write that cannot increase the count", async () => {
    const { syncShoppingSummary } = await load();
    await syncShoppingSummary("ws-1", { resurface: false });
    expect(prismaMock.shoppingSummary.upsert).toHaveBeenCalledWith({
      where: { workspaceId: "ws-1" },
      create: { workspaceId: "ws-1" },
      update: {},
    });
  });

  it("removes the row when the list empties", async () => {
    prismaMock.shoppingItem.count.mockResolvedValue(0);
    const { syncShoppingSummary } = await load();
    await syncShoppingSummary("ws-1", { resurface: true });
    expect(prismaMock.shoppingSummary.deleteMany).toHaveBeenCalledWith({
      where: { workspaceId: "ws-1" },
    });
    expect(prismaMock.shoppingSummary.upsert).not.toHaveBeenCalled();
  });

  it("removes it when everything is ticked off, not only when rows are deleted", async () => {
    // "Nothing left to buy" is the same fact whether the items were deleted or
    // ticked, and the summary is about the former list, not the table.
    prismaMock.shoppingItem.count.mockResolvedValue(0);
    const { syncShoppingSummary } = await load();
    await syncShoppingSummary("ws-1", { resurface: false });
    expect(prismaMock.shoppingSummary.deleteMany).toHaveBeenCalled();
  });
});
