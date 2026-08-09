import { describe, it, expect } from "vitest";
import {
  MAX_SHOPPING_ITEMS,
  SHOPPING_ITEM_TEXT_MAX_LENGTH,
  normaliseShoppingItemText,
  shoppingItemTextError,
  splitShoppingList,
  shoppingRemainingCount,
  nextShoppingOrder,
} from "@/lib/shopping";

/** The stored shape the pure helpers take — deliberately not the Prisma row. */
const item = (
  over: Partial<Parameters<typeof splitShoppingList>[0][number]> = {},
) => ({
  id: "a",
  text: "Milk",
  done: false,
  savedForLater: false,
  order: 1,
  ...over,
});

describe("normaliseShoppingItemText", () => {
  it("trims and collapses internal whitespace runs", () => {
    expect(normaliseShoppingItemText("  oat   milk \n")).toBe("oat milk");
  });

  it("refuses whitespace-only text", () => {
    expect(normaliseShoppingItemText("   \t \n ")).toBeNull();
  });

  it("accepts text exactly at the bound", () => {
    const at = "x".repeat(SHOPPING_ITEM_TEXT_MAX_LENGTH);
    expect(normaliseShoppingItemText(at)).toBe(at);
  });

  it("refuses text one character over the bound", () => {
    expect(
      normaliseShoppingItemText("x".repeat(SHOPPING_ITEM_TEXT_MAX_LENGTH + 1)),
    ).toBeNull();
  });

  // Same reasoning as FOCUS_PLAYLIST_NAME_MAX_LENGTH (#185): a UTF-16 length
  // would reject an all-emoji entry half the length of the Latin one beside it.
  it("counts code points, not UTF-16 units", () => {
    const emoji = "🥑".repeat(SHOPPING_ITEM_TEXT_MAX_LENGTH);
    expect(normaliseShoppingItemText(emoji)).toBe(emoji);
  });

  it("collapses before measuring, so padding costs no characters", () => {
    const padded = `  ${"x".repeat(SHOPPING_ITEM_TEXT_MAX_LENGTH)}  `;
    expect(normaliseShoppingItemText(padded)).toHaveLength(
      SHOPPING_ITEM_TEXT_MAX_LENGTH,
    );
  });
});

describe("shoppingItemTextError", () => {
  it("tells empty apart from too-long", () => {
    expect(shoppingItemTextError("  ")).toBe("empty");
    expect(
      shoppingItemTextError("x".repeat(SHOPPING_ITEM_TEXT_MAX_LENGTH + 1)),
    ).toBe("too-long");
    expect(shoppingItemTextError("Milk")).toBeNull();
  });
});

describe("splitShoppingList", () => {
  it("splits on savedForLater and keeps capture order in both sections", () => {
    const items = [
      item({ id: "c", order: 3 }),
      item({ id: "a", order: 1, savedForLater: true }),
      item({ id: "b", order: 2 }),
      item({ id: "d", order: 4, savedForLater: true }),
    ];
    const { active, savedForLater } = splitShoppingList(items);
    expect(active.map((i) => i.id)).toEqual(["b", "c"]);
    expect(savedForLater.map((i) => i.id)).toEqual(["a", "d"]);
  });

  it("keeps ticked items in the active section", () => {
    const { active, savedForLater } = splitShoppingList([
      item({ id: "a", done: true }),
    ]);
    expect(active.map((i) => i.id)).toEqual(["a"]);
    expect(savedForLater).toEqual([]);
  });

  // Two concurrent adds can allocate the same `order` (see nextShoppingOrder),
  // so the tie-break has to be deterministic or the list reshuffles on reload.
  it("breaks an order tie on id so the order is stable across reads", () => {
    const { active } = splitShoppingList([
      item({ id: "b", order: 1 }),
      item({ id: "a", order: 1 }),
    ]);
    expect(active.map((i) => i.id)).toEqual(["a", "b"]);
  });
});

describe("shoppingRemainingCount", () => {
  // The count answers "things I still need to buy", so a ticked item is bought
  // and a saved-for-later item is explicitly not this trip.
  it("counts only un-ticked items that are not saved for later", () => {
    expect(
      shoppingRemainingCount([
        item({ id: "a" }),
        item({ id: "b", done: true }),
        item({ id: "c", savedForLater: true }),
        item({ id: "d", done: true, savedForLater: true }),
        item({ id: "e" }),
      ]),
    ).toBe(2);
  });

  it("is zero for an empty list", () => {
    expect(shoppingRemainingCount([])).toBe(0);
  });
});

describe("nextShoppingOrder", () => {
  it("is 1 for an empty list", () => {
    expect(nextShoppingOrder([])).toBe(1);
  });

  it("is one past the highest order, not the count", () => {
    expect(nextShoppingOrder([{ order: 1 }, { order: 7 }, { order: 3 }])).toBe(
      8,
    );
  });
});

describe("bounds", () => {
  it("caps items per workspace, because the write is client-callable", () => {
    expect(MAX_SHOPPING_ITEMS).toBeGreaterThan(0);
    expect(Number.isInteger(MAX_SHOPPING_ITEMS)).toBe(true);
  });
});
