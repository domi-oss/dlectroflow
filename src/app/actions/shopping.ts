"use server";

import { revalidatePath } from "next/cache";
import { Prisma } from "@prisma/client";
import { prisma, getSettings } from "@/lib/db";
import { currentWorkspaceId } from "@/lib/workspace";
import {
  MAX_SHOPPING_ITEMS,
  isStillToBuy,
  normaliseShoppingItemText,
  nextShoppingOrder,
  shoppingSavedForLaterUpdate,
} from "@/lib/shopping";
import {
  clearShoppingSummary,
  syncShoppingSummary,
} from "@/lib/shopping-summary-sync";

const SHOPPING_PATH = "/shopping";
/** The inbox, where the summary line renders (#199). */
const INBOX_PATH = "/";

/**
 * #199 — bring the inbox summary into line, then invalidate both surfaces.
 *
 * Every write in this file ends here, so there is one place that decides what a
 * shopping write means for the inbox rather than six. `resurface` says whether
 * this write could make the list LONGER — see `syncShoppingSummary` for why that,
 * and not "did the list change", is the rule that brings a dismissed summary back.
 *
 * Both paths are revalidated because the feature now renders on two: the list at
 * /shopping, and the summary line on the inbox. Revalidating only /shopping was
 * the bug this helper exists to make impossible.
 */
async function settleShopping(
  workspaceId: string,
  resurface: boolean,
): Promise<void> {
  await syncShoppingSummary(workspaceId, { resurface });
  revalidatePath(SHOPPING_PATH);
  revalidatePath(INBOX_PATH);
}

/**
 * #199 — the shopping list's writes.
 *
 * ## The feature gate is here as well as on the page
 *
 * `/shopping` refuses to render with `notFound()` when `Settings.shoppingList` is
 * off, which is what the issue asks for. It is not sufficient on its own: a server
 * action is a POST endpoint the client can call without ever loading that page, so
 * a gate only on the page would make the switch cosmetic — "off" would mean "the
 * link is hidden" rather than "the feature is not running".
 *
 * This is defence in depth, not an authorization boundary: the rows belong to the
 * caller's own workspace either way, so nothing here protects one person's data
 * from another (that is the `workspaceId` filter below). It protects the *promise*
 * the switch makes.
 *
 * `getSettings()` creates the row on first use (#156), which is fine in a write
 * path — unlike the export, which must not modify what it is exporting.
 *
 * ## Every write carries the workspace in its filter
 *
 * `updateMany` / `deleteMany` with `{ id, workspaceId }`, never `update({ where:
 * { id } })` after a scoped read. Two reasons, both of them the codebase's
 * existing ones (`setItemEstimate`, `freshenItem`): the scoping harness can see
 * the filter, and a read-then-write pair is a check a later refactor can drop
 * while the write keeps working. A row belonging to someone else is a 0-row no-op
 * rather than an error, which is the correct outcome — there is nothing to tell
 * the caller about a row they are not allowed to know exists.
 *
 * ## Nothing here awards anything
 *
 * No `logReward`, no `touchStreakOnEngagement`, no `awardBadge`. Ticking off
 * shopping earns nothing, by the owner's decision, and because `ShoppingItem` is
 * its own table that is implemented by writing no reward code at all rather than
 * by subtracting one. `shopping.test.ts` pins it, because "deliberately absent"
 * and "forgotten" look identical in a diff.
 */
async function shoppingWorkspace(): Promise<string | null> {
  const workspaceId = await currentWorkspaceId();
  const settings = await getSettings(workspaceId);
  return settings.shoppingList ? workspaceId : null;
}

/**
 * Capture an item at the end of the list.
 *
 * Refuses rather than truncates on over-long text: truncating would silently
 * store something the person did not write, and `shoppingItemTextError` exists so
 * the field can say which rule was broken instead of the add appearing to do
 * nothing.
 */
export async function addShoppingItem(text: string) {
  const trimmed = normaliseShoppingItemText(text);
  // Before resolving the workspace: a blank submit is the commonest input on a
  // capture field and it should cost no query at all.
  if (trimmed === null) return;
  const workspaceId = await shoppingWorkspace();
  if (!workspaceId) return;

  // ── Why this is a transaction, at SERIALIZABLE ────────────────────────────
  //
  // Duo review, !294, and the finding was right for a reason worth writing down.
  // The check used to be a plain read followed by a plain insert, and this file
  // calls the cap "the only thing standing between an authenticated session and
  // storage exhaustion" — but a read-then-write pair is not that. A client firing
  // a burst of parallel requests has them all read the same count, all pass the
  // check, and all insert, so the cap held only against a caller polite enough to
  // queue its writes. Overshoot was bounded by the burst size, i.e. not bounded.
  //
  // At SERIALIZABLE Postgres takes a predicate lock on the count, so a concurrent
  // transaction that also counted and inserted is ABORTED rather than allowed
  // past. That makes the pair atomic with respect to another add, which is the
  // property the cap needs and the only one it needs — the `order` duplication the
  // read side tolerates is a separate, genuinely cosmetic matter (and one this
  // isolation level now also happens to prevent on this path; `splitShoppingList`
  // keeps its tie-break for rows written before this change and for any future
  // writer).
  //
  // ONE retry, deliberately. A retry turns the ordinary two-way race into a
  // success; an unbounded retry loop under a deliberate burst is the request
  // amplification the cap exists to prevent. Giving up writes nothing, which is
  // the same outcome as hitting the cap, and the page re-reads from the database
  // on the next render — so nobody is ever shown an item that is not there.
  let added = false;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await prisma.$transaction(
        async (tx) => {
          // One read serves both the cap and the next `order`. Only the column the
          // order needs is selected — the cap is `rows.length`, so a `count()`
          // alongside this would be a second round trip for a number this row set
          // already carries.
          const existing = await tx.shoppingItem.findMany({
            where: { workspaceId },
            select: { order: true },
          });
          // Checked, not clamped: the list is already at the cap, so there is
          // nothing useful to tell the person beyond "this list is full", which the
          // page says before the action is ever called.
          if (existing.length >= MAX_SHOPPING_ITEMS) return;
          await tx.shoppingItem.create({
            data: {
              text: trimmed,
              order: nextShoppingOrder(existing),
              workspaceId,
            },
          });
          // Set INSIDE the transaction and after the create: the cap check above
          // `return`s without throwing, so the loop below would otherwise treat a
          // blocked add as a success — and the summary would be un-dismissed for an
          // add that never happened.
          added = true;
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      );
      break;
    } catch (e) {
      // P2034 is Prisma's "transaction failed due to a write conflict or a
      // deadlock" — the serialization failure this isolation level exists to
      // raise. Only that code is absorbed: swallowing every failure would turn a
      // broken database into an item that silently vanishes, which is the failure
      // mode the whole capture surface is written to avoid.
      const retryable = (e as { code?: string }).code === "P2034";
      if (!retryable) throw e;
      // A retried attempt starts over, so anything the aborted one set is void.
      added = false;
      if (attempt === 1) break;
    }
  }

  // `added`, not `true`: an add is the write that CAN lengthen the list, and this
  // says whether it DID. A cap-blocked body and a give-up after two write conflicts
  // both wrote nothing and both leave it false (Duo review, !295 — passing `true`
  // here un-dismissed the summary for writes that never happened).
  //
  // OUTSIDE the transaction above, deliberately. The summary sync reads the item
  // count and writes at most one row in another table, so pulling it inside would
  // widen a SERIALIZABLE transaction's predicate-lock footprint for a row whose
  // exactness does not matter: `syncShoppingSummary` stores no count, so the worst
  // a lost sync can do is leave the inbox line absent until the next shopping
  // write, and the read side derives the number from the items either way. See the
  // module doc on src/lib/shopping-summary.ts.
  //
  // It runs even when nothing was written, which is correct rather than sloppy:
  // whatever the list now holds is what the inbox should say about it, and this call
  // reads that rather than assuming this request changed anything. So it is also
  // self-healing — a no-op add whose workspace carries a summary row that outlived
  // its list will delete that row, which is why the revalidation it triggers is
  // earned here. That is the one place this differs from part 1's tail, where a
  // cap-hit returns early because there was nothing to sync (round 3, !294).
  await settleShopping(workspaceId, added);
}

/** Edit an entry in place. An empty rename is refused rather than blanking the
 *  row — the row's text is the only thing distinguishing it from its neighbours,
 *  and `ShoppingItem_text_check` would refuse it at the database anyway. */
export async function renameShoppingItem(id: string, text: string) {
  const trimmed = normaliseShoppingItemText(text);
  if (trimmed === null) return;
  const workspaceId = await shoppingWorkspace();
  if (!workspaceId) return;
  await prisma.shoppingItem.updateMany({
    where: { id, workspaceId },
    data: { text: trimmed },
  });
  // A rename cannot change the count, so it is not a reason to un-dismiss.
  await settleShopping(workspaceId, false);
}

/**
 * Tick or un-tick.
 *
 * Both directions in one action, so a mis-tap is reversible without a second
 * endpoint that could disagree with this one. `Boolean(done)` is the only
 * validation a plain boolean column needs (the `focusShuffle` precedent, #68) —
 * the value arrives from a client-callable action, so it is coerced rather than
 * trusted.
 */
export async function setShoppingItemDone(id: string, done: boolean) {
  const workspaceId = await shoppingWorkspace();
  if (!workspaceId) return;
  const ticked = Boolean(done);
  const { count } = await prisma.shoppingItem.updateMany({
    where: { id, workspaceId },
    data: { done: ticked },
  });
  // Un-ticking puts something back on the list, so it resurfaces a dismissed
  // summary; ticking off is progress, and resurrecting the line as a reward for
  // progress is precisely what the `resurface` rule exists to avoid.
  //
  // `count > 0` as well as the direction (Duo review, !295): a stale id, or one
  // belonging to another workspace, is a 0-row no-op — nothing came back onto the
  // list, so nothing should come back into the inbox.
  //
  // And then the row itself (Duo review round 5, !295). The direction and the
  // matched-row count together still cannot see the item's OTHER flag: `done` and
  // `savedForLater` are independent, and the combination is two taps away on
  // /shopping, because every row in BOTH sections renders a live checkbox. Un-tick
  // something sitting in the saved-for-later pile and the list has not grown —
  // `savedForLater` keeps it out of the count either way — so the summary must
  // stay dismissed. Asking `isStillToBuy` of the row as it now stands is the same
  // predicate the count filters on, applied to one row rather than restated.
  await settleShopping(
    workspaceId,
    !ticked && count > 0 && (await isOnTheToBuyList(id, workspaceId)),
  );
}

/**
 * Is that row, as it now stands, one of the things still to buy?
 *
 * A read AFTER the write, not a read-then-write guard: the write above is already
 * workspace-scoped, and this only decides whether the inbox line comes back. It is
 * scoped anyway, so a foreign id answers "no" rather than leaking whether the row
 * exists — and so the scoping harness can see the filter.
 *
 * Racing a concurrent write costs at most a summary line that is absent until the
 * next shopping write, or present when it need not be; `shopping-summary.ts`
 * documents why that residual is acceptable and a transaction is not reached for.
 */
async function isOnTheToBuyList(
  id: string,
  workspaceId: string,
): Promise<boolean> {
  const row = await prisma.shoppingItem.findFirst({
    where: { id, workspaceId },
    select: { done: true, savedForLater: true },
  });
  return row !== null && isStillToBuy(row);
}

/**
 * Move an item down into the undated saved-for-later pile, or pull it back up.
 *
 * `order` is deliberately untouched in both directions, so an item pulled back up
 * returns to its place in capture order instead of jumping to the end of the list.
 * What the two directions write is asymmetric, and {@link shoppingSavedForLaterUpdate}
 * holds that rule: going down writes `savedForLater` alone, coming back up clears
 * `done` with it, because "pull this back up" is the gesture for *I want to buy
 * this* and an item returned to the list still ticked is not on it (Duo review,
 * !295 — the round trip shipped broken).
 *
 * There is no date and no scheduler here on purpose: nothing in this pile
 * reappears on its own. `BrainDumpItem` uses `snoozedUntil` for the same-named
 * bucket, which enrols it in the freshness and reminder machinery — exactly what
 * shopping-list mode is not.
 */
export async function setShoppingItemSavedForLater(
  id: string,
  savedForLater: boolean,
) {
  const workspaceId = await shoppingWorkspace();
  if (!workspaceId) return;
  const saved = Boolean(savedForLater);
  const { count } = await prisma.shoppingItem.updateMany({
    where: { id, workspaceId },
    data: shoppingSavedForLaterUpdate(saved),
  });
  // Pulling an item back up lengthens the to-buy list; moving one down shortens it.
  // `count > 0` for the same reason as the tick above: a 0-row no-op lengthened
  // nothing (Duo review, !295).
  //
  // No read-back here, unlike `setShoppingItemDone` — and that asymmetry is the
  // fix, not an oversight. The un-tick can only see one of the two flags it
  // depends on; this write sets BOTH, so a matched row is on the to-buy list by
  // construction and there is nothing left to ask the database.
  await settleShopping(workspaceId, !saved && count > 0);
}

/**
 * Remove an item.
 *
 * One statement, not the transaction `deleteBrainDumpItem` needs: nothing
 * references a `ShoppingItem` — no task, no step, no focus session, no calendar
 * artefact — so there is no orphan to clean up. That is a consequence of the
 * model decision rather than a coincidence, and it is why this file is short.
 */
export async function deleteShoppingItem(id: string) {
  const workspaceId = await shoppingWorkspace();
  if (!workspaceId) return;
  await prisma.shoppingItem.deleteMany({ where: { id, workspaceId } });
  // A delete can only shorten the list. It can also EMPTY it, which is what
  // removes the summary row altogether — handled inside syncShoppingSummary
  // rather than here, so "the list is empty" has one definition.
  await settleShopping(workspaceId, false);
}

/**
 * #199 — dismiss the inbox summary line.
 *
 * It comes back the next time the list grows (see `syncShoppingSummary`), so this
 * is a "not now" rather than a delete — which is why the card says so next to the
 * control. Only the inbox is revalidated: /shopping never renders the summary.
 *
 * Behind the same feature gate as every other write here. Without it, a client
 * could keep writing `clearedAt` to a workspace whose owner has switched the
 * feature off, which is a row being touched for a feature that is not running.
 */
export async function dismissShoppingSummary() {
  const workspaceId = await shoppingWorkspace();
  if (!workspaceId) return;
  await clearShoppingSummary(workspaceId);
  revalidatePath(INBOX_PATH);
}
