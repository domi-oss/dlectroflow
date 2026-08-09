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
    // Duo review, !294 — the cap is now taken inside a SERIALIZABLE transaction, so
    // this mock has to model the callback form. It hands the same delegate object
    // through as `tx`, which is what makes the assertions below able to see the
    // read and the write regardless of which handle they were made on.
    $transaction: vi.fn(),
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
  // `clearAllMocks` drops recorded calls but keeps a `mockResolvedValue`, and the
  // row-count specs below set these to 0 — put the matched-a-row default back so
  // a later spec does not inherit "nothing matched".
  prismaMock.shoppingItem.updateMany.mockResolvedValue({ count: 1 });
  prismaMock.shoppingItem.deleteMany.mockResolvedValue({ count: 1 });
  prismaMock.$transaction.mockImplementation(
    async (fn: (tx: typeof prismaMock) => Promise<unknown>) => fn(prismaMock),
  );
});

const load = () => import("./shopping");

/**
 * One typical call per exported write, so a table-driven spec can drive all five
 * without repeating the cast five times.
 *
 * The cast is `never` because `it.each` erases the module type through its own
 * tuple inference; the shapes below are the real signatures, and `tsc` still
 * checks the actions themselves at their definitions.
 */
const call = (m: never) => {
  const mod = m as never as {
    addShoppingItem: (t: string) => Promise<unknown>;
    renameShoppingItem: (i: string, t: string) => Promise<unknown>;
    setShoppingItemDone: (i: string, d: boolean) => Promise<unknown>;
    setShoppingItemSavedForLater: (i: string, s: boolean) => Promise<unknown>;
    deleteShoppingItem: (i: string) => Promise<unknown>;
  };
  return {
    add: () => mod.addShoppingItem("Milk"),
    rename: () => mod.renameShoppingItem("s1", "Milk"),
    done: () => mod.setShoppingItemDone("s1", true),
    saved: () => mod.setShoppingItemSavedForLater("s1", true),
    remove: () => mod.deleteShoppingItem("s1"),
  };
};

describe("the feature gate", () => {
  // Every exported write, driven through the same off switch: a new action that
  // forgets the gate shows up here rather than in production.
  it.each([
    ["addShoppingItem", (m: never) => call(m).add()],
    ["renameShoppingItem", (m: never) => call(m).rename()],
    ["setShoppingItemDone", (m: never) => call(m).done()],
    ["setShoppingItemSavedForLater", (m: never) => call(m).saved()],
    ["deleteShoppingItem", (m: never) => call(m).remove()],
  ])("%s writes nothing while the toggle is off", async (_name, invoke) => {
    getSettingsMock.mockResolvedValue({ shoppingList: false });
    const mod = (await load()) as never;
    await invoke(mod);
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

  /**
   * Duo review, !294 — the cap had a TOCTOU race, and the finding is right that it
   * mattered: this file's own doc calls the cap "the only thing standing between an
   * authenticated session and storage exhaustion", and a raceable check is no such
   * thing. A burst of parallel requests would all read the same count and all
   * insert, so the cap held only against a client that queued its writes.
   *
   * The read and the insert now happen in ONE transaction at SERIALIZABLE, which is
   * what makes the pair atomic with respect to another add: Postgres takes a
   * predicate lock on the count, so a concurrent transaction that also counted and
   * inserted is aborted rather than allowed past the cap.
   */
  it("takes the cap and the insert in one serializable transaction", async () => {
    const { addShoppingItem } = await load();
    await addShoppingItem("Milk");
    expect(prismaMock.$transaction).toHaveBeenCalledTimes(1);
    expect(prismaMock.$transaction.mock.calls[0][1]).toEqual({
      isolationLevel: "Serializable",
    });
  });

  it("retries once when the serialization check aborts it, then gives up", async () => {
    // A retry, not a loop: one retry turns the ordinary two-way race into a
    // success, and an unbounded retry under a deliberate burst is the amplification
    // the cap exists to prevent. A give-up writes nothing, which is the same
    // outcome as hitting the cap — and the page re-reads from the database, so the
    // person is never shown an item that is not there.
    const serializationFailure = Object.assign(new Error("write conflict"), {
      code: "P2034",
    });
    prismaMock.$transaction
      .mockRejectedValueOnce(serializationFailure)
      .mockImplementationOnce(
        async (fn: (tx: typeof prismaMock) => Promise<unknown>) =>
          fn(prismaMock),
      );
    const { addShoppingItem } = await load();
    await addShoppingItem("Milk");
    expect(prismaMock.$transaction).toHaveBeenCalledTimes(2);
    expect(prismaMock.shoppingItem.create).toHaveBeenCalledTimes(1);
  });

  // Gives up without throwing AT the UI — but not without telling it, which is
  // what "what a write answers" below pins. A rejection here would surface as an
  // unhandled error for a case the cap already treats as ordinary.
  it("gives up after a second conflict rather than throwing at the UI", async () => {
    const serializationFailure = Object.assign(new Error("write conflict"), {
      code: "P2034",
    });
    prismaMock.$transaction.mockRejectedValue(serializationFailure);
    const { addShoppingItem } = await load();
    await expect(addShoppingItem("Milk")).resolves.not.toThrow();
    expect(prismaMock.$transaction).toHaveBeenCalledTimes(2);
  });

  it("still surfaces an error that is NOT a serialization conflict", async () => {
    // Swallowing every failure would turn a broken database into a silently
    // vanishing item. Only the one retryable code is absorbed.
    prismaMock.$transaction.mockRejectedValue(
      Object.assign(new Error("connection lost"), { code: "P1001" }),
    );
    const { addShoppingItem } = await load();
    await expect(addShoppingItem("Milk")).rejects.toThrow(/connection lost/);
  });

  // Duo review round 3, !294 — every other no-op path in this action returns before
  // `revalidatePath` (blank text, gate closed, retries exhausted). A cap-hit did
  // not, because the transaction body `return`s without throwing, so the loop
  // `break`s as a success and fell through to the revalidation.
  it("does not revalidate when the cap blocked the insert", async () => {
    prismaMock.shoppingItem.findMany.mockResolvedValue(
      Array.from({ length: MAX_SHOPPING_ITEMS }, (_, i) => ({ order: i + 1 })),
    );
    const { addShoppingItem } = await load();
    await addShoppingItem("one too many");
    expect(prismaMock.shoppingItem.create).not.toHaveBeenCalled();
    expect(revalidatePathMock).not.toHaveBeenCalled();
  });

  it("does not revalidate after giving up on a write conflict", async () => {
    prismaMock.$transaction.mockRejectedValue(
      Object.assign(new Error("write conflict"), { code: "P2034" }),
    );
    const { addShoppingItem } = await load();
    await addShoppingItem("Milk");
    expect(revalidatePathMock).not.toHaveBeenCalled();
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

/**
 * Duo review round 5, !294 — **what the caller is told.**
 *
 * Every action here used to resolve to `undefined` whether it wrote or not, so a
 * client had exactly one signal — "it did not throw" — to cover both. That is not
 * a cosmetic gap: `addShoppingItem`'s cap check `return`s from inside the
 * transaction, so a blocked add and a stored one were the same answer, and the
 * page cleared the typed words for both.
 *
 * Each action now answers `{ ok: true }` or `{ ok: false, refused }`, and the
 * refusal is NAMED because a bare `false` collapses "this list is full" (retrying
 * cannot help, and the page has words for it already) with "two write conflicts
 * in a row" (retrying is exactly the right thing). The vocabulary is
 * `ShoppingWriteRefusal` in `@/lib/shopping`, which extends the
 * `ShoppingItemTextError` the surface already had rather than starting a second
 * one.
 */
describe("what a write answers", () => {
  it("says ok when the item was created", async () => {
    const { addShoppingItem } = await load();
    await expect(addShoppingItem("Milk")).resolves.toEqual({ ok: true });
  });

  // The finding: this path and the one above were indistinguishable.
  it("names the cap instead of answering like a success", async () => {
    prismaMock.shoppingItem.findMany.mockResolvedValue(
      Array.from({ length: MAX_SHOPPING_ITEMS }, (_, i) => ({ order: i + 1 })),
    );
    const { addShoppingItem } = await load();
    await expect(addShoppingItem("one too many")).resolves.toEqual({
      ok: false,
      refused: "full",
    });
  });

  // A give-up is NOT a cap hit: the list has room, the write simply lost twice,
  // and a retry is the one thing that could work. Collapsing the two into one
  // `false` would offer a retry at 500 items and withhold it here.
  it("tells a give-up apart from a cap hit", async () => {
    prismaMock.$transaction.mockRejectedValue(
      Object.assign(new Error("write conflict"), { code: "P2034" }),
    );
    const { addShoppingItem } = await load();
    await expect(addShoppingItem("Milk")).resolves.toEqual({
      ok: false,
      refused: "conflict",
    });
  });

  it.each([
    ["whitespace only", "   \n ", "empty"],
    [
      "over the bound",
      "x".repeat(SHOPPING_ITEM_TEXT_MAX_LENGTH + 1),
      "too-long",
    ],
  ])("names which text rule broke — %s", async (_label, text, refused) => {
    const { addShoppingItem } = await load();
    await expect(addShoppingItem(text)).resolves.toEqual({
      ok: false,
      refused,
    });
  });

  // The switch is a real reason a write does nothing, and one the page cannot
  // predict: another tab can turn it off between render and submit.
  it.each([
    ["addShoppingItem", (m: never) => call(m).add()],
    ["renameShoppingItem", (m: never) => call(m).rename()],
    ["setShoppingItemDone", (m: never) => call(m).done()],
    ["setShoppingItemSavedForLater", (m: never) => call(m).saved()],
    ["deleteShoppingItem", (m: never) => call(m).remove()],
  ])(
    "%s says the feature is unavailable while the toggle is off",
    async (_name, invoke) => {
      getSettingsMock.mockResolvedValue({ shoppingList: false });
      const mod = (await load()) as never;
      await expect(invoke(mod)).resolves.toEqual({
        ok: false,
        refused: "unavailable",
      });
    },
  );

  // `updateMany` matching nothing is the siblings' version of the same fault: it
  // resolves, it reports `{ count: 0 }`, and the row the user acted on is gone.
  it.each([
    ["renameShoppingItem", (m: never) => call(m).rename()],
    ["setShoppingItemDone", (m: never) => call(m).done()],
    ["setShoppingItemSavedForLater", (m: never) => call(m).saved()],
  ])(
    "%s says the row is missing when nothing matched",
    async (_name, invoke) => {
      prismaMock.shoppingItem.updateMany.mockResolvedValue({ count: 0 });
      const mod = (await load()) as never;
      await expect(invoke(mod)).resolves.toEqual({
        ok: false,
        refused: "missing",
      });
      expect(revalidatePathMock).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["renameShoppingItem", (m: never) => call(m).rename()],
    ["setShoppingItemDone", (m: never) => call(m).done()],
    ["setShoppingItemSavedForLater", (m: never) => call(m).saved()],
    ["deleteShoppingItem", (m: never) => call(m).remove()],
  ])("%s says ok when a row did match", async (_name, invoke) => {
    const mod = (await load()) as never;
    await expect(invoke(mod)).resolves.toEqual({ ok: true });
  });

  /**
   * The one sibling where a zero-row match is NOT a refusal.
   *
   * "Delete this" asks for an outcome, not for a row to be touched, and the
   * outcome already holds — reporting a failure would name a problem the user
   * does not have and offer a retry that can only fail. The revalidation still
   * runs, because the row the page is showing is the thing that is wrong.
   */
  it("treats deleting an already-gone row as done, not as a refusal", async () => {
    prismaMock.shoppingItem.deleteMany.mockResolvedValue({ count: 0 });
    const { deleteShoppingItem } = await load();
    await expect(deleteShoppingItem("s1")).resolves.toEqual({ ok: true });
    expect(revalidatePathMock).toHaveBeenCalledWith("/shopping");
  });
});
