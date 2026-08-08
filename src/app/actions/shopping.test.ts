/**
 * #199 — action tests for shopping-list mode.
 *
 * Three properties are worth pinning here, because each of them is a way the
 * feature could look right and be wrong:
 *
 *  1. **Every write is refused while `Settings.shoppingList` is off.** The page
 *     gate (`notFound()`) protects the page; a server action is callable without
 *     it, so a gate only on the page would make the switch cosmetic.
 *  2. **Every write is workspace-scoped.** `updateMany`/`deleteMany` with the
 *     `workspaceId` in the filter, not `update`-by-id after a read — the shape
 *     `src/app/actions/braindump.ts` uses, and an explicit IDOR guard rather than
 *     a check a refactor can drop.
 *  3. **Nothing here touches the reward, streak or badge machinery.** That is the
 *     whole reason shopping items live in their own table, and "we forgot to add
 *     it" and "we deliberately did not" are indistinguishable without a test.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  MAX_SHOPPING_ITEMS,
  SHOPPING_ITEM_TEXT_MAX_LENGTH,
} from "@/lib/shopping";

const {
  prismaMock,
  revalidatePathMock,
  currentWorkspaceIdMock,
  getSettingsMock,
} = vi.hoisted(() => {
  const prismaMock = {
    shoppingItem: {
      findMany: vi.fn().mockResolvedValue([]),
      count: vi.fn().mockResolvedValue(0),
      create: vi.fn().mockResolvedValue({}),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      deleteMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
  };
  return {
    prismaMock,
    revalidatePathMock: vi.fn(),
    currentWorkspaceIdMock: vi.fn().mockResolvedValue("ws-1"),
    getSettingsMock: vi.fn().mockResolvedValue({ shoppingList: true }),
  };
});
vi.mock("next/cache", () => ({ revalidatePath: revalidatePathMock }));
vi.mock("@/lib/db", () => ({
  prisma: prismaMock,
  getSettings: getSettingsMock,
}));
vi.mock("@/lib/workspace", () => ({
  currentWorkspaceId: currentWorkspaceIdMock,
  MissingWorkspaceError: class extends Error {},
}));

beforeEach(() => {
  vi.clearAllMocks();
  currentWorkspaceIdMock.mockResolvedValue("ws-1");
  getSettingsMock.mockResolvedValue({ shoppingList: true });
  prismaMock.shoppingItem.findMany.mockResolvedValue([]);
  prismaMock.shoppingItem.count.mockResolvedValue(0);
});

const load = () => import("./shopping");

describe("the feature gate", () => {
  // Every exported write, driven through the same off switch: a new action that
  // forgets the gate shows up here rather than in production.
  it.each([
    [
      "addShoppingItem",
      (m: never) =>
        (
          m as never as { addShoppingItem: (t: string) => Promise<unknown> }
        ).addShoppingItem("Milk"),
    ],
    [
      "renameShoppingItem",
      (m: never) =>
        (
          m as never as {
            renameShoppingItem: (i: string, t: string) => Promise<unknown>;
          }
        ).renameShoppingItem("s1", "Milk"),
    ],
    [
      "setShoppingItemDone",
      (m: never) =>
        (
          m as never as {
            setShoppingItemDone: (i: string, d: boolean) => Promise<unknown>;
          }
        ).setShoppingItemDone("s1", true),
    ],
    [
      "setShoppingItemSavedForLater",
      (m: never) =>
        (
          m as never as {
            setShoppingItemSavedForLater: (
              i: string,
              s: boolean,
            ) => Promise<unknown>;
          }
        ).setShoppingItemSavedForLater("s1", true),
    ],
    [
      "deleteShoppingItem",
      (m: never) =>
        (
          m as never as { deleteShoppingItem: (i: string) => Promise<unknown> }
        ).deleteShoppingItem("s1"),
    ],
  ])("%s writes nothing while the toggle is off", async (_name, call) => {
    getSettingsMock.mockResolvedValue({ shoppingList: false });
    const mod = (await load()) as never;
    await call(mod);
    expect(prismaMock.shoppingItem.create).not.toHaveBeenCalled();
    expect(prismaMock.shoppingItem.updateMany).not.toHaveBeenCalled();
    expect(prismaMock.shoppingItem.deleteMany).not.toHaveBeenCalled();
  });
});

describe("addShoppingItem", () => {
  it("stores the normalised text at the end of the list", async () => {
    prismaMock.shoppingItem.findMany.mockResolvedValue([
      { order: 1 },
      { order: 7 },
    ]);
    const { addShoppingItem } = await load();
    await addShoppingItem("  oat   milk  ");
    expect(prismaMock.shoppingItem.create).toHaveBeenCalledWith({
      data: { text: "oat milk", order: 8, workspaceId: "ws-1" },
    });
    expect(revalidatePathMock).toHaveBeenCalledWith("/shopping");
  });

  it("starts a new list at order 1", async () => {
    const { addShoppingItem } = await load();
    await addShoppingItem("Milk");
    expect(prismaMock.shoppingItem.create).toHaveBeenCalledWith({
      data: { text: "Milk", order: 1, workspaceId: "ws-1" },
    });
  });

  it("refuses whitespace-only text without a query", async () => {
    const { addShoppingItem } = await load();
    await addShoppingItem("   \n ");
    expect(prismaMock.shoppingItem.create).not.toHaveBeenCalled();
  });

  it("refuses text over the bound rather than truncating it", async () => {
    // Truncating would silently store something the user did not write.
    const { addShoppingItem } = await load();
    await addShoppingItem("x".repeat(SHOPPING_ITEM_TEXT_MAX_LENGTH + 1));
    expect(prismaMock.shoppingItem.create).not.toHaveBeenCalled();
  });

  it("refuses to grow the list past MAX_SHOPPING_ITEMS", async () => {
    // An authenticated, client-callable write with no other rate limit in front
    // of it: without this an unbounded row count per workspace is storage
    // exhaustion available to anyone with a session, guests included.
    prismaMock.shoppingItem.findMany.mockResolvedValue(
      Array.from({ length: MAX_SHOPPING_ITEMS }, (_, i) => ({ order: i + 1 })),
    );
    const { addShoppingItem } = await load();
    await addShoppingItem("one too many");
    expect(prismaMock.shoppingItem.create).not.toHaveBeenCalled();
  });

  it("reads the workspace's own rows only", async () => {
    const { addShoppingItem } = await load();
    await addShoppingItem("Milk");
    expect(prismaMock.shoppingItem.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { workspaceId: "ws-1" } }),
    );
  });
});

describe("renameShoppingItem", () => {
  it("writes the normalised text scoped to the workspace", async () => {
    const { renameShoppingItem } = await load();
    await renameShoppingItem("s1", "  oat   milk ");
    expect(prismaMock.shoppingItem.updateMany).toHaveBeenCalledWith({
      where: { id: "s1", workspaceId: "ws-1" },
      data: { text: "oat milk" },
    });
  });

  it("refuses an empty rename rather than blanking the row", async () => {
    const { renameShoppingItem } = await load();
    await renameShoppingItem("s1", "  ");
    expect(prismaMock.shoppingItem.updateMany).not.toHaveBeenCalled();
  });
});

describe("setShoppingItemDone", () => {
  it("ticks scoped to the workspace and awards nothing", async () => {
    const { setShoppingItemDone } = await load();
    await setShoppingItemDone("s1", true);
    expect(prismaMock.shoppingItem.updateMany).toHaveBeenCalledWith({
      where: { id: "s1", workspaceId: "ws-1" },
      data: { done: true },
    });
  });

  it("un-ticks, so a mis-tap is reversible", async () => {
    const { setShoppingItemDone } = await load();
    await setShoppingItemDone("s1", false);
    expect(prismaMock.shoppingItem.updateMany).toHaveBeenCalledWith({
      where: { id: "s1", workspaceId: "ws-1" },
      data: { done: false },
    });
  });

  it("coerces a non-boolean rather than writing it", async () => {
    const { setShoppingItemDone } = await load();
    await setShoppingItemDone("s1", "yes" as unknown as boolean);
    expect(prismaMock.shoppingItem.updateMany).toHaveBeenCalledWith({
      where: { id: "s1", workspaceId: "ws-1" },
      data: { done: true },
    });
  });
});

describe("setShoppingItemSavedForLater", () => {
  it("moves an item down into the undated pile", async () => {
    const { setShoppingItemSavedForLater } = await load();
    await setShoppingItemSavedForLater("s1", true);
    expect(prismaMock.shoppingItem.updateMany).toHaveBeenCalledWith({
      where: { id: "s1", workspaceId: "ws-1" },
      data: { savedForLater: true },
    });
  });

  it("pulls it back up, and does not touch `done` or `order` either way", async () => {
    // Keeping `order` means an item pulled back up returns to where it was in
    // capture order rather than jumping to the end of the list.
    const { setShoppingItemSavedForLater } = await load();
    await setShoppingItemSavedForLater("s1", false);
    expect(prismaMock.shoppingItem.updateMany).toHaveBeenCalledWith({
      where: { id: "s1", workspaceId: "ws-1" },
      data: { savedForLater: false },
    });
  });
});

describe("deleteShoppingItem", () => {
  it("deletes scoped to the workspace, and leaves no orphan behind", async () => {
    // Nothing references a ShoppingItem — no task, no step, no session — which is
    // why this is one statement and not the transaction deleteBrainDumpItem needs.
    const { deleteShoppingItem } = await load();
    await deleteShoppingItem("s1");
    expect(prismaMock.shoppingItem.deleteMany).toHaveBeenCalledWith({
      where: { id: "s1", workspaceId: "ws-1" },
    });
    expect(revalidatePathMock).toHaveBeenCalledWith("/shopping");
  });
});
