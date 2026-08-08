"use server";

import { revalidatePath } from "next/cache";
import { Prisma } from "@prisma/client";
import { prisma, getSettings } from "@/lib/db";
import { currentWorkspaceId } from "@/lib/workspace";
import {
  MAX_SHOPPING_ITEMS,
  normaliseShoppingItemText,
  nextShoppingOrder,
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
          // Set INSIDE the transaction, after the create: the cap check above
          // `return`s without throwing, so the loop below would otherwise treat a
          // blocked add as a success.
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

  // The write that CAN lengthen the list, so `added` says whether it DID (Duo review,
  // !295 — passing `true` here un-dismissed the summary for a cap-blocked add and for
  // a give-up after two write conflicts, both of which wrote nothing).
  //
  // OUTSIDE the transaction above, deliberately. The summary sync reads the item
  // count and writes at most one row in another table, so pulling it inside would
  // widen a SERIALIZABLE transaction's predicate-lock footprint for a row whose
  // exactness does not matter: `syncShoppingSummary` stores no count, so the worst
  // a lost sync can do is leave the inbox line absent until the next shopping
  // write, and the read side derives the number from the items either way. See the
  // module doc on src/lib/shopping-summary.ts.
  //
  // Unlike part 1's tail, this is NOT skipped when nothing was written, and the
  // difference is that there is now something to do on a no-op: the sync reads the
  // current count and can itself change state — deleting a summary row that outlived
  // its list — so the revalidation it triggers is earned rather than wasted. Part 1
  // had nothing to sync, which is why a cap-hit returned early there (round 3, !294).
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
  await prisma.shoppingItem.updateMany({
    where: { id, workspaceId },
    data: { done: ticked },
  });
  // Un-ticking puts something back on the list, so it resurfaces a dismissed
  // summary; ticking off is progress, and resurrecting the line as a reward for
  // progress is precisely what the `resurface` rule exists to avoid.
  await settleShopping(workspaceId, !ticked);
}

/**
 * Move an item down into the undated saved-for-later pile, or pull it back up.
 *
 * Writes ONLY `savedForLater`. `order` is deliberately untouched, so an item
 * pulled back up returns to its place in capture order instead of jumping to the
 * end of the list; and `done` is untouched because "I already bought this" and "I
 * am not buying this today" are independent facts.
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
  await prisma.shoppingItem.updateMany({
    where: { id, workspaceId },
    data: { savedForLater: saved },
  });
  // Pulling an item back up lengthens the to-buy list; moving one down shortens it.
  await settleShopping(workspaceId, !saved);
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
