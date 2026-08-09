"use server";

import { revalidatePath } from "next/cache";
import { Prisma } from "@prisma/client";
import { prisma, getSettings } from "@/lib/db";
import { currentWorkspaceId } from "@/lib/workspace";
import {
  MAX_SHOPPING_ITEMS,
  normaliseShoppingItemText,
  nextShoppingOrder,
  shoppingItemTextError,
  type ShoppingWriteResult,
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
 *
 * ## Every write says whether it wrote
 *
 * Duo review round 5, !294. All five of these used to resolve to `undefined`
 * whether they wrote or not, which left the page one signal — "it did not
 * throw" — to cover both. That is not theoretical: the cap check below `return`s
 * from inside its transaction, so a blocked add resolved exactly like a stored
 * one and the page cleared the typed words for both.
 *
 * They now answer {@link ShoppingWriteResult}, and a refusal carries its reason,
 * because the right response differs per reason: at the cap a retry can never
 * work, after a write conflict it is the only thing that can. The vocabulary is
 * `ShoppingWriteRefusal` in `@/lib/shopping`, shared with the client so the two
 * cannot drift.
 *
 * Note what a workspace-scoped filter makes of this. `updateMany` matching no
 * rows still means "the row is not yours to change", exactly as the paragraph
 * above says — the answer is `missing` either way, which tells the caller nothing
 * about whether a row with that id exists elsewhere.
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
export async function addShoppingItem(
  text: string,
): Promise<ShoppingWriteResult> {
  const trimmed = normaliseShoppingItemText(text);
  // Before resolving the workspace: a blank submit is the commonest input on a
  // capture field and it should cost no query at all.
  if (trimmed === null) {
    // Which rule broke, not just "no". `shoppingItemTextError` is the same
    // predicate the normaliser applies, so it cannot answer null here; the
    // fallback exists only because the two calls are opaque to the compiler.
    return { ok: false, refused: shoppingItemTextError(text) ?? "empty" };
  }
  const workspaceId = await shoppingWorkspace();
  if (!workspaceId) return { ok: false, refused: "unavailable" };

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
  // Tracked apart from `added`, because "the list is full" and "we lost the race
  // twice" are the two ways this loop writes nothing and the caller's only
  // sensible responses to them are opposites (Duo review round 5, !294).
  let full = false;
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
          // nothing useful to tell the person beyond "this list is full" — which
          // the page usually says before the action is ever called, and which it
          // can only say afterwards because of the flag set here.
          if (existing.length >= MAX_SHOPPING_ITEMS) {
            full = true;
            return;
          }
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
      full = false;
      if (attempt === 1) break;
    }
  }

  // Duo review round 3, !294 — every other no-op path in this action returns before
  // the revalidation (blank text, gate closed, retries exhausted), and a cap-hit did
  // not, because the transaction body returns rather than throws. Nothing was
  // written, so there is nothing for the page to re-render.
  if (full) return { ok: false, refused: "full" };
  if (!added) return { ok: false, refused: "conflict" };
  revalidatePath(SHOPPING_PATH);
  return { ok: true };
}

/** Edit an entry in place. An empty rename is refused rather than blanking the
 *  row — the row's text is the only thing distinguishing it from its neighbours,
 *  and `ShoppingItem_text_check` would refuse it at the database anyway. */
export async function renameShoppingItem(
  id: string,
  text: string,
): Promise<ShoppingWriteResult> {
  const trimmed = normaliseShoppingItemText(text);
  if (trimmed === null) {
    return { ok: false, refused: shoppingItemTextError(text) ?? "empty" };
  }
  const workspaceId = await shoppingWorkspace();
  if (!workspaceId) return { ok: false, refused: "unavailable" };
  const { count } = await prisma.shoppingItem.updateMany({
    where: { id, workspaceId },
    data: { text: trimmed },
  });
  if (count === 0) return { ok: false, refused: "missing" };
  revalidatePath(SHOPPING_PATH);
  return { ok: true };
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
export async function setShoppingItemDone(
  id: string,
  done: boolean,
): Promise<ShoppingWriteResult> {
  const workspaceId = await shoppingWorkspace();
  if (!workspaceId) return { ok: false, refused: "unavailable" };
  const { count } = await prisma.shoppingItem.updateMany({
    where: { id, workspaceId },
    data: { done: Boolean(done) },
  });
  if (count === 0) return { ok: false, refused: "missing" };
  revalidatePath(SHOPPING_PATH);
  return { ok: true };
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
): Promise<ShoppingWriteResult> {
  const workspaceId = await shoppingWorkspace();
  if (!workspaceId) return { ok: false, refused: "unavailable" };
  const { count } = await prisma.shoppingItem.updateMany({
    where: { id, workspaceId },
    data: { savedForLater: Boolean(savedForLater) },
  });
  if (count === 0) return { ok: false, refused: "missing" };
  revalidatePath(SHOPPING_PATH);
  return { ok: true };
}

/**
 * Remove an item.
 *
 * One statement, not the transaction `deleteBrainDumpItem` needs: nothing
 * references a `ShoppingItem` — no task, no step, no focus session, no calendar
 * artefact — so there is no orphan to clean up. That is a consequence of the
 * model decision rather than a coincidence, and it is why this file is short.
 *
 * **The one sibling where a zero-row match is not a refusal** (Duo review round
 * 5, !294). Its three neighbours all answer `missing` when `count` is 0, because
 * a rename or a tick asks for a row to be changed and there is no row. A delete
 * asks for an OUTCOME, and the outcome already holds — telling the user "that
 * item is not on the list any more" about an item they just asked to remove
 * would name a problem they do not have, and offer a retry that can only refuse
 * again. The revalidation still runs unconditionally, because in that case the
 * row the page is showing is exactly the thing that is wrong.
 */
export async function deleteShoppingItem(
  id: string,
): Promise<ShoppingWriteResult> {
  const workspaceId = await shoppingWorkspace();
  if (!workspaceId) return { ok: false, refused: "unavailable" };
  await prisma.shoppingItem.deleteMany({ where: { id, workspaceId } });
  revalidatePath(SHOPPING_PATH);
  return { ok: true };
}
