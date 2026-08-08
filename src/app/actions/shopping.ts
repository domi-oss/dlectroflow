"use server";

import { revalidatePath } from "next/cache";
import { prisma, getSettings } from "@/lib/db";
import { currentWorkspaceId } from "@/lib/workspace";
import {
  MAX_SHOPPING_ITEMS,
  normaliseShoppingItemText,
  nextShoppingOrder,
} from "@/lib/shopping";

const SHOPPING_PATH = "/shopping";

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

  // One read serves both the cap and the next `order`. Only the column the order
  // needs is selected — the cap is `rows.length`, so a `count()` alongside this
  // would be a second round trip for a number this row set already carries.
  const existing = await prisma.shoppingItem.findMany({
    where: { workspaceId },
    select: { order: true },
  });
  // Checked, not clamped: silently dropping the write is what an unbounded table
  // would deserve, and the list is already 500 rows long, so there is nothing
  // useful to tell the person beyond "this list is full" — which the page says.
  if (existing.length >= MAX_SHOPPING_ITEMS) return;

  await prisma.shoppingItem.create({
    data: {
      text: trimmed,
      order: nextShoppingOrder(existing),
      workspaceId,
    },
  });
  revalidatePath(SHOPPING_PATH);
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
  revalidatePath(SHOPPING_PATH);
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
  await prisma.shoppingItem.updateMany({
    where: { id, workspaceId },
    data: { done: Boolean(done) },
  });
  revalidatePath(SHOPPING_PATH);
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
  await prisma.shoppingItem.updateMany({
    where: { id, workspaceId },
    data: { savedForLater: Boolean(savedForLater) },
  });
  revalidatePath(SHOPPING_PATH);
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
  revalidatePath(SHOPPING_PATH);
}
