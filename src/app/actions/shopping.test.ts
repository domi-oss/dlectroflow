/**
 * #199 — action tests for shopping-list mode.
 *
 * Four properties are worth pinning here, because each of them is a way the
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
 *  4. **A failed inbox-summary sync cannot change what the write reported.** The
 *     two halves of #199 land together — !294 gave every write a
 *     `ShoppingWriteResult`, !295 made the summary sync best-effort — and this is
 *     where they meet. A committed row must be reported as committed, and a real
 *     refusal must survive the wrapper that swallows the sync's failure.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  MAX_SHOPPING_ITEMS,
  SHOPPING_ITEM_TEXT_MAX_LENGTH,
  type ShoppingWriteResult,
} from "@/lib/shopping";

const {
  prismaMock,
  revalidatePathMock,
  currentWorkspaceIdMock,
  getSettingsMock,
  syncMock,
  clearMock,
} = vi.hoisted(() => {
  const prismaMock = {
    shoppingItem: {
      findMany: vi.fn().mockResolvedValue([]),
      // Duo review, !295 — `setShoppingItemDone` reads the row back to see whether
      // the un-tick actually put it on the to-buy list, so the default here is the
      // ordinary case: an active, un-ticked row.
      findFirst: vi
        .fn()
        .mockResolvedValue({ done: false, savedForLater: false }),
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
    syncMock: vi.fn().mockResolvedValue(undefined),
    clearMock: vi.fn().mockResolvedValue(undefined),
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
vi.mock("@/lib/shopping-summary-sync", () => ({
  syncShoppingSummary: syncMock,
  clearShoppingSummary: clearMock,
}));

beforeEach(() => {
  vi.clearAllMocks();
  currentWorkspaceIdMock.mockResolvedValue("ws-1");
  getSettingsMock.mockResolvedValue({ shoppingList: true });
  prismaMock.shoppingItem.findMany.mockResolvedValue([]);
  prismaMock.shoppingItem.findFirst.mockResolvedValue({
    done: false,
    savedForLater: false,
  });
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
    // And nothing syncs the inbox summary either: a refused write must not leave
    // the inbox advertising a list the feature is not running. This is the one
    // refusal that reaches the workspace and still must not settle — see
    // `settleShopping`, "Refusals reach here too".
    expect(syncMock).not.toHaveBeenCalled();
  });
});

/**
 * #199 — the inbox summary's sync, driven from every write.
 *
 * `resurface` is the half worth pinning. A dismissed summary comes back only for a
 * write that can make the list LONGER; ticking an item off, saving it for later,
 * deleting and renaming leave a dismissal alone, because otherwise dismissing the
 * line and then making progress on the shopping page would resurrect it as a
 * reward for the progress.
 */
describe("the inbox summary is kept in step with every write", () => {
  it.each([
    ["adding an item", true],
    ["un-ticking an item", true],
    ["pulling one back up from saved-for-later", true],
  ])("resurfaces a dismissed summary after %s", async (label, resurface) => {
    const mod = await load();
    if (label === "adding an item") await mod.addShoppingItem("Milk");
    else if (label === "un-ticking an item")
      await mod.setShoppingItemDone("s1", false);
    else await mod.setShoppingItemSavedForLater("s1", false);
    expect(syncMock).toHaveBeenCalledWith("ws-1", { resurface });
  });

  it.each([
    ["ticking an item off", "done-true"],
    ["saving one for later", "saved-true"],
    ["deleting one", "delete"],
    ["renaming one", "rename"],
  ])("leaves a dismissal alone after %s", async (_label, kind) => {
    const mod = await load();
    if (kind === "done-true") await mod.setShoppingItemDone("s1", true);
    else if (kind === "saved-true")
      await mod.setShoppingItemSavedForLater("s1", true);
    else if (kind === "delete") await mod.deleteShoppingItem("s1");
    else await mod.renameShoppingItem("s1", "Bread");
    expect(syncMock).toHaveBeenCalledWith("ws-1", { resurface: false });
  });

  /**
   * Duo review, !295 — `resurface` was passed on the REQUESTED direction rather than
   * the ACTUAL outcome, so three writes that changed nothing still un-dismissed the
   * summary. That directly contradicts the rule the whole design rests on: a
   * dismissed line comes back only when the list actually got longer.
   */
  it("does NOT resurface when a cap-blocked add wrote nothing", async () => {
    // The transaction body returns without creating when the list is full, and
    // returning is not throwing — so the retry loop breaks as a "success" and the
    // old code called settleShopping(true) for an add that never happened.
    prismaMock.shoppingItem.findMany.mockResolvedValue(
      Array.from({ length: MAX_SHOPPING_ITEMS }, (_, i) => ({ order: i + 1 })),
    );
    const { addShoppingItem } = await load();
    await addShoppingItem("one too many");
    expect(prismaMock.shoppingItem.create).not.toHaveBeenCalled();
    expect(syncMock).toHaveBeenCalledWith("ws-1", { resurface: false });
  });

  it("does NOT resurface when a give-up wrote nothing", async () => {
    const conflict = Object.assign(new Error("write conflict"), {
      code: "P2034",
    });
    prismaMock.$transaction.mockRejectedValue(conflict);
    const { addShoppingItem } = await load();
    await addShoppingItem("Milk");
    expect(syncMock).toHaveBeenCalledWith("ws-1", { resurface: false });
  });

  it("does NOT resurface when un-ticking a stale or foreign id", async () => {
    // `updateMany` with a workspace filter is a 0-row no-op for a row belonging to
    // somebody else, or one already deleted. Nothing got longer.
    prismaMock.shoppingItem.updateMany.mockResolvedValue({ count: 0 });
    const { setShoppingItemDone } = await load();
    await setShoppingItemDone("not-mine", false);
    expect(syncMock).toHaveBeenCalledWith("ws-1", { resurface: false });
  });

  it("does NOT resurface when pulling back up a stale or foreign id", async () => {
    prismaMock.shoppingItem.updateMany.mockResolvedValue({ count: 0 });
    const { setShoppingItemSavedForLater } = await load();
    await setShoppingItemSavedForLater("not-mine", false);
    expect(syncMock).toHaveBeenCalledWith("ws-1", { resurface: false });
  });

  it("still syncs after a no-op, because the list is whatever it is", async () => {
    // The sync itself is NOT skipped: it reads the current count and answers for
    // that, so calling it after a write that did nothing is correct — it is only
    // the RESURFACE flag that must reflect whether anything actually grew.
    prismaMock.shoppingItem.updateMany.mockResolvedValue({ count: 0 });
    const { setShoppingItemDone } = await load();
    await setShoppingItemDone("not-mine", false);
    expect(syncMock).toHaveBeenCalledTimes(1);
  });

  it("revalidates the inbox as well as the list, since the summary renders there", async () => {
    const { addShoppingItem } = await load();
    await addShoppingItem("Milk");
    expect(revalidatePathMock).toHaveBeenCalledWith("/shopping");
    expect(revalidatePathMock).toHaveBeenCalledWith("/");
  });
});

/**
 * Duo review, !295 — **a bookkeeping failure must not be reported as a failed
 * write**, and the merge of !294 is what lets this file say so precisely.
 *
 * `settleShopping` runs AFTER the primary write has committed, on every one of
 * the five writes in this file. When it threw, the whole server action rejected
 * for a row that is already in the database — and `addShoppingItem` is not
 * idempotent, so a client that treats a rejection as "that did not happen" and
 * retries captures the item TWICE. !294 hardened exactly that surface into an
 * error notice with a Retry button, so the two changes compose into a duplicate.
 *
 * With !294 merged the property is stronger than "it resolves". Every write now
 * answers a `ShoppingWriteResult`, so the assertion is the one that actually
 * matters to the page: the write reports `{ ok: true }` while the sync is on
 * fire. Resolving with a refusal would be the same duplicate bug wearing a
 * different hat — the Retry is offered on `conflict`, and `writeFailureRemedy`
 * would offer it again.
 *
 * The converse is pinned here too, because the swallow must not be greedy: a
 * write the database genuinely refused still answers with its refusal, sync
 * failure or no sync failure.
 *
 * The summary row is the recoverable half: it stores no count, the next shopping
 * write re-derives it, and the read side counts the items either way. So the
 * sync is best-effort — the same call `awardFirstSchedule` makes for rewards
 * after a calendar push has committed (`src/lib/scheduling/award.ts`).
 *
 * Swallowed is not the same as invisible. The failure gets one structured,
 * greppable line, the way `recordAuthFailure` and `logDisconnectFailure` do —
 * an error nobody can ever see would just move the defect into the logs.
 */
describe("a summary sync that fails cannot fail the primary write", () => {
  const writes: Array<
    [
      string,
      (m: Awaited<ReturnType<typeof load>>) => Promise<ShoppingWriteResult>,
    ]
  > = [
    ["addShoppingItem", (m) => m.addShoppingItem("Milk")],
    ["renameShoppingItem", (m) => m.renameShoppingItem("s1", "Bread")],
    ["setShoppingItemDone", (m) => m.setShoppingItemDone("s1", true)],
    [
      "setShoppingItemSavedForLater",
      (m) => m.setShoppingItemSavedForLater("s1", true),
    ],
    ["deleteShoppingItem", (m) => m.deleteShoppingItem("s1")],
  ];

  // `Once`, never a sticky `mockRejectedValue`: the outer `beforeEach` calls
  // `vi.clearAllMocks()`, which clears recorded calls but NOT implementations —
  // a sticky rejection would leak into every test declared after this block.
  const BOOM = "summary table is on fire";
  let errorLog: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => errorLog.mockRestore());

  // THE interaction, stated as bluntly as it can be: the row is in the database,
  // so the caller is told the row is in the database.
  it.each(writes)(
    "%s still answers ok, because the write itself landed",
    async (_name, run) => {
      syncMock.mockRejectedValueOnce(new Error(BOOM));
      await expect(run(await load())).resolves.toEqual({ ok: true });
    },
  );

  it("the item the user asked for is still written", async () => {
    syncMock.mockRejectedValueOnce(new Error(BOOM));
    const { addShoppingItem } = await load();
    await addShoppingItem("Milk");
    expect(prismaMock.shoppingItem.create).toHaveBeenCalledTimes(1);
  });

  // The other direction, and the reason `settleShopping` takes the result as an
  // argument instead of deciding one: the swallow covers the sync, not the write.
  // A `full` that came back as `{ ok: true }` would have the page clear the typed
  // words for an item it never stored.
  it("a refusal is still a refusal — the cap survives a failed sync", async () => {
    syncMock.mockRejectedValueOnce(new Error(BOOM));
    prismaMock.shoppingItem.findMany.mockResolvedValue(
      Array.from({ length: MAX_SHOPPING_ITEMS }, (_, i) => ({ order: i + 1 })),
    );
    const { addShoppingItem } = await load();
    await expect(addShoppingItem("one too many")).resolves.toEqual({
      ok: false,
      refused: "full",
    });
  });

  it("a refusal is still a refusal — a missing row survives a failed sync", async () => {
    syncMock.mockRejectedValueOnce(new Error(BOOM));
    prismaMock.shoppingItem.updateMany.mockResolvedValue({ count: 0 });
    const { renameShoppingItem } = await load();
    await expect(renameShoppingItem("not-mine", "Bread")).resolves.toEqual({
      ok: false,
      refused: "missing",
    });
  });

  // The write landed, so /shopping is stale until something invalidates it.
  // Letting the sync's failure skip the revalidation would turn one absent inbox
  // line into a shopping page that does not show the item just added.
  it("still revalidates both surfaces", async () => {
    syncMock.mockRejectedValueOnce(new Error(BOOM));
    const { addShoppingItem } = await load();
    await addShoppingItem("Milk");
    expect(revalidatePathMock).toHaveBeenCalledWith("/shopping");
    expect(revalidatePathMock).toHaveBeenCalledWith("/");
  });

  it("says so in the log, with a greppable tag and the workspace", async () => {
    syncMock.mockRejectedValueOnce(new Error(BOOM));
    const { addShoppingItem } = await load();
    await addShoppingItem("Milk");
    expect(errorLog).toHaveBeenCalledTimes(1);
    const line = JSON.parse(String(errorLog.mock.calls[0][0])) as {
      tag: string;
      workspaceId: string;
      message: string;
    };
    expect(line.tag).toBe("shopping_summary_sync_failed");
    expect(line.workspaceId).toBe("ws-1");
    expect(line.message).toContain(BOOM);
  });

  // The control: a healthy sync logs nothing, so the line above means something.
  it("logs nothing when the sync succeeds", async () => {
    const { addShoppingItem } = await load();
    await addShoppingItem("Milk");
    expect(errorLog).not.toHaveBeenCalled();
  });

  /**
   * The other half of the rule, and the reason this is not "catch everything".
   * `clearShoppingSummary` IS the write `dismissShoppingSummary` was called to
   * make — there is no primary result standing behind it — so it must keep
   * rejecting, and the card surfaces that (Duo review, !295, the sibling
   * finding). Swallowing it here would leave the user told nothing at all.
   */
  it("but dismissShoppingSummary still rejects, because that IS the write", async () => {
    clearMock.mockRejectedValueOnce(new Error(BOOM));
    const { dismissShoppingSummary } = await load();
    await expect(dismissShoppingSummary()).rejects.toThrow(BOOM);
  });
});

describe("dismissShoppingSummary", () => {
  it("clears the summary for the resolved workspace and refreshes the inbox", async () => {
    const { dismissShoppingSummary } = await load();
    await dismissShoppingSummary();
    expect(clearMock).toHaveBeenCalledWith("ws-1");
    expect(revalidatePathMock).toHaveBeenCalledWith("/");
  });

  it("does nothing while the feature is off", async () => {
    getSettingsMock.mockResolvedValue({ shoppingList: false });
    const { dismissShoppingSummary } = await load();
    await dismissShoppingSummary();
    expect(clearMock).not.toHaveBeenCalled();
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
    // Not even the summary: this path returns before the workspace is resolved.
    expect(syncMock).not.toHaveBeenCalled();
  });

  it("refuses text over the bound rather than truncating it", async () => {
    // Truncating would silently store something the user did not write.
    const { addShoppingItem } = await load();
    await addShoppingItem("x".repeat(SHOPPING_ITEM_TEXT_MAX_LENGTH + 1));
    expect(prismaMock.shoppingItem.create).not.toHaveBeenCalled();
    expect(syncMock).not.toHaveBeenCalled();
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

  /**
   * A DELIBERATE divergence from part 1, and the one place the two branches of
   * #199 asserted opposite things — recorded here rather than left as a test that
   * quietly changed.
   *
   * `!294` round 3 asked for a cap-hit to return before `revalidatePath`, because
   * every other no-op path in that action did and nothing had been written; its
   * spec was "does not revalidate when the cap blocked the insert". Correct while
   * `/shopping` was the only surface. Once !295 lands, the tail calls
   * `settleShopping`, and the sync inside it READS the current count and can
   * itself change state — it deletes a summary row that outlived its list — so on
   * a no-op there IS something to re-render, and the revalidation is earned. !294's
   * own client agrees: `declineWrite` calls `router.refresh()` on exactly this
   * refusal, because "the server knows something the rendered items do not".
   *
   * What must NOT happen on a no-op is the resurface, which is asserted
   * separately above; and what must not change is the ANSWER, which is asserted
   * here so the two facts cannot drift apart.
   */
  it("still syncs and revalidates when the cap blocked the insert", async () => {
    prismaMock.shoppingItem.findMany.mockResolvedValue(
      Array.from({ length: MAX_SHOPPING_ITEMS }, (_, i) => ({ order: i + 1 })),
    );
    const { addShoppingItem } = await load();
    const result = await addShoppingItem("one too many");
    expect(prismaMock.shoppingItem.create).not.toHaveBeenCalled();
    // The sync runs — it is self-healing — but with resurface FALSE.
    expect(syncMock).toHaveBeenCalledWith("ws-1", { resurface: false });
    expect(revalidatePathMock).toHaveBeenCalledWith("/shopping");
    expect(revalidatePathMock).toHaveBeenCalledWith("/");
    // …and settling did not soften the refusal into a success.
    expect(result).toEqual({ ok: false, refused: "full" });
  });

  // The same reversal for the other no-op tail. !294 asserted "does not revalidate
  // after giving up on a write conflict"; the settle now runs for the reason above,
  // and the caller is still told to retry.
  it("still syncs and revalidates after giving up on a write conflict", async () => {
    prismaMock.$transaction.mockRejectedValue(
      Object.assign(new Error("write conflict"), { code: "P2034" }),
    );
    const { addShoppingItem } = await load();
    const result = await addShoppingItem("Milk");
    expect(syncMock).toHaveBeenCalledWith("ws-1", { resurface: false });
    expect(revalidatePathMock).toHaveBeenCalledWith("/shopping");
    expect(revalidatePathMock).toHaveBeenCalledWith("/");
    expect(result).toEqual({ ok: false, refused: "conflict" });
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
    expect(syncMock).not.toHaveBeenCalled();
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

  /**
   * Duo review, !295 — `resurface` read the tick direction and the matched-row
   * count, and neither can see the item's OTHER flag. `done` and `savedForLater`
   * are independent booleans and the combination is reachable in two taps from
   * `/shopping` (tick a row, then Save for later; or tick a row already in the
   * pile — every row in both sections renders a live checkbox). Un-ticking such an
   * item left it excluded from the count by `savedForLater`, so the list did not
   * grow — and a dismissed summary came back anyway.
   */
  it("does NOT resurface when un-ticking an item that is still saved for later", async () => {
    prismaMock.shoppingItem.findFirst.mockResolvedValue({
      done: false,
      savedForLater: true,
    });
    const { setShoppingItemDone } = await load();
    await setShoppingItemDone("s1", false);
    expect(syncMock).toHaveBeenCalledWith("ws-1", { resurface: false });
  });

  it("resurfaces when un-ticking an item that is on the active list", async () => {
    const { setShoppingItemDone } = await load();
    await setShoppingItemDone("s1", false);
    expect(syncMock).toHaveBeenCalledWith("ws-1", { resurface: true });
  });

  it("does NOT resurface when the row is gone by the time it is read back", async () => {
    // A concurrent delete between the write and the read. Nothing is on the list
    // to bring an inbox line back for.
    prismaMock.shoppingItem.findFirst.mockResolvedValue(null);
    const { setShoppingItemDone } = await load();
    await setShoppingItemDone("s1", false);
    expect(syncMock).toHaveBeenCalledWith("ws-1", { resurface: false });
  });

  // The read-back decides the inbox line, not the answer. The `updateMany` matched
  // a row, so the write the user asked for happened and is reported as happening —
  // a vanished row here is only a reason to leave a dismissal alone.
  it("still answers ok when the row is gone by the read-back", async () => {
    prismaMock.shoppingItem.findFirst.mockResolvedValue(null);
    const { setShoppingItemDone } = await load();
    await expect(setShoppingItemDone("s1", false)).resolves.toEqual({
      ok: true,
    });
  });

  it("reads the row back scoped to the workspace, and only the two flags", async () => {
    const { setShoppingItemDone } = await load();
    await setShoppingItemDone("s1", false);
    expect(prismaMock.shoppingItem.findFirst).toHaveBeenCalledWith({
      where: { id: "s1", workspaceId: "ws-1" },
      select: { done: true, savedForLater: true },
    });
  });

  it("costs no read at all when TICKING, which cannot lengthen the list", async () => {
    const { setShoppingItemDone } = await load();
    await setShoppingItemDone("s1", true);
    expect(prismaMock.shoppingItem.findFirst).not.toHaveBeenCalled();
  });

  it("costs no read when the write matched no row", async () => {
    prismaMock.shoppingItem.updateMany.mockResolvedValue({ count: 0 });
    const { setShoppingItemDone } = await load();
    await setShoppingItemDone("not-mine", false);
    expect(prismaMock.shoppingItem.findFirst).not.toHaveBeenCalled();
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

  it("keeps `done` when an item goes DOWN into the pile", async () => {
    // "I already bought this" and "not this trip" stay independent in this
    // direction — clearing the tick here would resurrect a bought item as unbought.
    const { setShoppingItemSavedForLater } = await load();
    await setShoppingItemSavedForLater("s1", true);
    expect(prismaMock.shoppingItem.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: { savedForLater: true } }),
    );
  });

  /**
   * Duo review, !295 — the mirrored half of the `resurface` finding, and the
   * defect underneath it. This write set `savedForLater` alone, so an item ticked
   * before it was sent down came back STILL TICKED: it sat in the active section
   * struck through, and `shoppingRemainingCount` went on excluding it, so the
   * to-buy count did not move. "Pull it back up" is the gesture for *I want to buy
   * this*, so the tick goes with it.
   *
   * This supersedes !294's "pulls it back up, and does not touch `done` or `order`
   * either way": `order` is still untouched in both directions, `done` is now
   * cleared on the way UP only, and the two branches asserted opposite payloads
   * for that one direction.
   */
  it("pulls it back up UN-TICKED, so it lands on the to-buy list", async () => {
    // `order` is still untouched: the item returns to where it was in capture
    // order rather than jumping to the end of the list.
    const { setShoppingItemSavedForLater } = await load();
    await setShoppingItemSavedForLater("s1", false);
    expect(prismaMock.shoppingItem.updateMany).toHaveBeenCalledWith({
      where: { id: "s1", workspaceId: "ws-1" },
      data: { savedForLater: false, done: false },
    });
  });

  it("needs no read-back to know the item is now countable", async () => {
    // Unlike the un-tick above: this write sets BOTH flags, so the row it matched
    // is on the to-buy list by construction and there is nothing left to ask.
    const { setShoppingItemSavedForLater } = await load();
    await setShoppingItemSavedForLater("s1", false);
    expect(prismaMock.shoppingItem.findFirst).not.toHaveBeenCalled();
    expect(syncMock).toHaveBeenCalledWith("ws-1", { resurface: true });
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
 *
 * Post-merge with !295, that answer is threaded THROUGH `settleShopping` rather
 * than returned around it, so the block above and this one are two views of one
 * invariant: the inbox bookkeeping cannot rewrite what the write reported, in
 * either direction.
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
      // The second place the two branches disagreed. !294 asserted no
      // revalidation here, on the same "nothing was written" reasoning as the
      // cap-hit above; !295's `settleShopping` revalidates both surfaces. The
      // reversal is deliberate and this is the stronger position: a `missing`
      // means the page is rendering a row the database does not have, so it is
      // the refusal MOST in need of a re-read — which is why !294's own
      // `declineWrite` already fired `router.refresh()` for it. The argument is
      // in `settleShopping`, under "Refusals reach here too".
      expect(revalidatePathMock).toHaveBeenCalledWith("/shopping");
      expect(revalidatePathMock).toHaveBeenCalledWith("/");
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
   * does not have and offer a retry that can only fail. The settle still runs,
   * because the row the page is showing is the thing that is wrong.
   */
  it("treats deleting an already-gone row as done, not as a refusal", async () => {
    prismaMock.shoppingItem.deleteMany.mockResolvedValue({ count: 0 });
    const { deleteShoppingItem } = await load();
    await expect(deleteShoppingItem("s1")).resolves.toEqual({ ok: true });
    expect(revalidatePathMock).toHaveBeenCalledWith("/shopping");
    expect(revalidatePathMock).toHaveBeenCalledWith("/");
  });
});
