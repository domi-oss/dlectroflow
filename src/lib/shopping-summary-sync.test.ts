import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * #199 — the summary's writes. Its own file because the module is, and the module is
 * split because the pure half is imported by a `"use client"` component: see the
 * doc on `shopping-summary-sync.ts`, and `client-server-boundary.test.ts` for the
 * gate that keeps the split honest.
 *
 * The delegate is MOCKED here, so everything below asserts a payload — which
 * branch was taken and with what arguments. That is the right shape for the branch
 * logic and the wrong one for anything about a ROW: a mocked write has neither a
 * row nor an absent row, so "the row exists" and "no row yet" are the same test
 * twice, and a payload assertion cannot see what SQL Prisma compiles it to.
 *
 * Both of those blind spots hid a real P2002 race behind assertions that passed
 * (Duo review, !295). Anything that depends on a row, on concurrency, or on the
 * emitted statement belongs in `shopping-summary-sync.integration.test.ts`.
 */

const { prismaMock } = vi.hoisted(() => ({
  prismaMock: {
    shoppingItem: { count: vi.fn() },
    shoppingSummary: {
      upsert: vi.fn().mockResolvedValue({}),
      createMany: vi.fn().mockResolvedValue({ count: 1 }),
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

  // A growing write is the only one that may touch `clearedAt`, and it is an
  // upsert precisely because a NON-EMPTY `update` is what makes Prisma compile it
  // to native ON CONFLICT DO UPDATE.
  it("un-dismisses the row when the write can lengthen the list", async () => {
    const { syncShoppingSummary } = await load();
    await syncShoppingSummary("ws-1", { resurface: true });
    expect(prismaMock.shoppingSummary.upsert).toHaveBeenCalledWith({
      where: { workspaceId: "ws-1" },
      create: { workspaceId: "ws-1" },
      update: { clearedAt: null },
    });
    expect(prismaMock.shoppingSummary.createMany).not.toHaveBeenCalled();
  });

  // The other branch is a different STATEMENT, not a different payload, and
  // `skipDuplicates` is the load-bearing flag: it is what makes Prisma emit
  // INSERT ... ON CONFLICT DO NOTHING, so two of these racing from the no-row
  // state cannot raise P2002. Written as `upsert` with `update: {}` it raised one
  // 15 times out of 20 — see `shopping-summary-sync.integration.test.ts`, which
  // is where that can actually be proved. This assertion only guards the shape.
  it("leaves a dismissal alone for a write that cannot increase the count", async () => {
    const { syncShoppingSummary } = await load();
    await syncShoppingSummary("ws-1", { resurface: false });
    expect(prismaMock.shoppingSummary.createMany).toHaveBeenCalledWith({
      data: { workspaceId: "ws-1" },
      skipDuplicates: true,
    });
    expect(prismaMock.shoppingSummary.upsert).not.toHaveBeenCalled();
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
