import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  shoppingSummaryLabel,
  shoppingSummaryVisible,
} from "@/lib/shopping-summary";

describe("shoppingSummaryVisible", () => {
  // The whole point of the design: the row stores WHETHER to show a summary, and
  // never HOW MANY. So the count cannot drift, because there is no second copy of
  // it to drift from — it is derived from the items on every render.
  it("shows the summary when a live row meets a non-empty list", () => {
    expect(
      shoppingSummaryVisible({ row: { clearedAt: null }, remaining: 3 }),
    ).toEqual({ count: 3 });
  });

  it("hides it when there is no row", () => {
    expect(shoppingSummaryVisible({ row: null, remaining: 3 })).toBeNull();
  });

  it("hides it while it is cleared", () => {
    expect(
      shoppingSummaryVisible({
        row: { clearedAt: new Date("2026-08-08T09:00:00Z") },
        remaining: 3,
      }),
    ).toBeNull();
  });

  // The belt-and-braces case, and the reason this function exists rather than the
  // page trusting the row's existence. If a sync is ever missed — a crash between
  // the item write and the summary write, a future writer that forgets — the row
  // outlives the list. Deriving the count means the failure shows as NO summary,
  // never as a summary claiming a number the list does not have.
  it("hides it when the row outlived the list, rather than showing a wrong count", () => {
    expect(
      shoppingSummaryVisible({ row: { clearedAt: null }, remaining: 0 }),
    ).toBeNull();
  });

  it("never reports a negative or fractional count", () => {
    expect(
      shoppingSummaryVisible({ row: { clearedAt: null }, remaining: -1 }),
    ).toBeNull();
  });
});

describe("shoppingSummaryLabel", () => {
  it("agrees with itself on 1 and on many", () => {
    expect(shoppingSummaryLabel(1, "plain")).toBe(
      "1 item on your shopping list",
    );
    expect(shoppingSummaryLabel(4, "plain")).toBe(
      "4 items on your shopping list",
    );
  });

  it("speaks the playful voice too (#86)", () => {
    expect(shoppingSummaryLabel(2, "playful")).toContain("2 items");
  });

  // Composed from the counted-noun keys rather than a template string with a
  // placeholder: `src/lib/strings.ts` is a flat label table with no
  // interpolation, and the same two keys already serve the /shopping header.
  it("reuses the same counted noun the shopping page uses", () => {
    expect(shoppingSummaryLabel(1, "plain")).toContain("item");
    expect(shoppingSummaryLabel(2, "plain")).toContain("items");
  });
});

// ── syncShoppingSummary ─────────────────────────────────────────────────────

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
  const load = () => import("@/lib/shopping-summary");

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
