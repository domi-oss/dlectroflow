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
  shoppingItemTextError,
  shoppingSavedForLaterUpdate,
  type ShoppingWriteResult,
} from "@/lib/shopping";
import {
  clearShoppingSummary,
  syncShoppingSummary,
} from "@/lib/shopping-summary-sync";

const SHOPPING_PATH = "/shopping";
/** The inbox, where the summary line renders (#199). */
const INBOX_PATH = "/";

/**
 * One structured, greppable line when bookkeeping behind a committed write gives
 * up.
 *
 * The workspace id and nothing else — enough to find the row, and the same
 * pseudonymous key `logDisconnectFailure` and the purge job already log. The
 * item text is not in here: it is the user's own words and the log is not the
 * place for them.
 *
 * `error`, not `warn`: unlike a declined sign-in this is not a handled outcome
 * anybody chose, and the whole reason it is safe to swallow is that it lands
 * somewhere a grep can find it.
 *
 * The tag is a parameter because there are two such failures and they want
 * telling apart: the sync itself, and the read-back that decides what to tell it
 * (#199, raised in review of !295). One tag for both would make a grep for either
 * return the other.
 */
function logShoppingBookkeepingFailure(
  tag: "shopping_summary_sync_failed" | "shopping_readback_failed",
  workspaceId: string,
  error: unknown,
): void {
  try {
    const e = error as { message?: unknown } | undefined;
    console.error(
      JSON.stringify({
        tag,
        workspaceId,
        message: typeof e?.message === "string" ? e.message : String(error),
        ts: new Date().toISOString(),
      }),
    );
  } catch {
    // Observability must never take the request down with it — the same guard
    // `recordLLMFailure` and `recordAuthFailure` carry, and it matters more here
    // because this catch block exists precisely to keep a committed write from
    // being reported as failed.
  }
}

/**
 * #199 — bring the inbox summary into line, invalidate both surfaces, and hand
 * the write's own answer back untouched.
 *
 * Every write in this file ends here, so there is one place that decides what a
 * shopping write means for the inbox rather than six. `resurface` says whether
 * this write could make the list LONGER — see `syncShoppingSummary` for why that,
 * and not "did the list change", is the rule that brings a dismissed summary back.
 *
 * Both paths are revalidated because the feature now renders on two: the list at
 * /shopping, and the summary line on the inbox. Revalidating only /shopping was
 * the bug this helper exists to make impossible.
 *
 * ## The sync is BEST-EFFORT, and that is a data-integrity decision
 *
 * Duo review, !295. Every caller reaches this line with its primary write already
 * committed, so a `syncShoppingSummary` that threw rejected the whole server
 * action for a row that is in the database. `addShoppingItem` is not idempotent:
 * a client that reads a rejection as "that did not happen" and retries captures
 * the item TWICE — and !294 has just given the capture surfaces a Retry, so the
 * two changes compose into exactly that duplicate.
 *
 * The two halves are not symmetrical, which is what decides this:
 *
 *  * A **failed sync** is recoverable and self-healing. The row stores no count,
 *    so there is no stale number to correct; the next shopping write re-derives
 *    it, including a write that changes nothing (see `addShoppingItem`'s tail),
 *    and the read side counts the items directly either way. The whole cost is
 *    an inbox line absent, or present, until then — the residual
 *    `shopping-summary.ts` already documents as acceptable.
 *  * A **duplicated item** is not recoverable. It needs the person to notice and
 *    delete it.
 *
 * So the bookkeeping is not allowed to report the primary write as failed. This
 * is the call `awardFirstSchedule` makes for the same reason
 * (`src/lib/scheduling/award.ts`): "scheduling has already committed and must
 * not be retried", rewards logged rather than thrown.
 *
 * **Not folded into the write's transaction instead.** All-or-nothing is the
 * other coherent answer and it is the wrong one here: four of the five writes
 * are a single statement with no transaction to join, and `addShoppingItem`'s
 * comment already gives the reason its SERIALIZABLE block ends before this call.
 * More to the point, an atomic pairing would let a fault in the summary table
 * REFUSE a shopping write — trading a self-healing cosmetic residual for a lost
 * one, which is the trade backwards.
 *
 * **Swallowed is not invisible.** The failure gets one greppable line, so
 * "the summary sync is failing for everybody" is a thing somebody can find out.
 *
 * The revalidations run either way, deliberately: the item write landed, so
 * skipping them would turn one absent inbox line into a /shopping page that does
 * not show the item just added.
 *
 * ## `result` passes THROUGH, which is where !294 and !295 meet
 *
 * The two halves of #199 rewrote every write in this file at once. !294 gave
 * them all a {@link ShoppingWriteResult}, so the page can tell a real write from
 * a silent decline; !295 made this sync best-effort. The rule where they meet is
 * that **a failed sync can never change the answer** — the row is committed, so
 * the caller must be told it is committed.
 *
 * Taking the result as an argument and returning it is what makes that
 * structural rather than remembered. There is no branch in here that can see the
 * sync's outcome, so none can rewrite `result`; and a caller cannot accidentally
 * settle without returning its answer, because the answer is what this returns.
 *
 * The converse is the same mechanism read the other way, and it matters as much:
 * a genuine refusal stays a refusal. `result` is decided from the write itself
 * before this is called, so a *healthy* sync cannot promote a `missing` or a
 * `full` into an `ok` either.
 *
 * ## Refusals reach here too, provided the write reached the database
 *
 * This is the one place the two halves genuinely disagreed. !294 round 3 had a
 * cap-hit — and, later, every `missing` — return before `revalidatePath`, on the
 * grounds that nothing was written so there was nothing to re-render. That
 * reasoning does not survive !295, and !294's own client is the evidence:
 * `declineWrite` in `shopping-list.tsx` calls `router.refresh()` on exactly
 * `full` and `missing`, because "the server knows something the rendered items
 * do not". Those are the two paths where the page is MOST stale, not the least.
 *
 * The sync is not a no-op on them either. It re-derives from the list as it now
 * stands rather than from what this request intended, so it is what removes a
 * summary row that outlived its list — the self-heal `shopping-summary.ts`
 * promises. A cap-hit on a list whose items have all been ticked off leaves a
 * stale inbox line, and this is what clears it.
 *
 * So the line is drawn at the database, not at the refusal: `settleShopping`
 * runs iff the action resolved a workspace and issued its write. The refusals
 * that return before it — blank or over-long text, and the feature switched
 * off — never got that far. The text ones have no workspace resolved yet (a
 * blank submit is the commonest input on a capture field and should cost no
 * query at all), and the gate one must not touch the summary at all, or a
 * workspace with the feature OFF would be left with an inbox line advertising it.
 *
 * None of this touches `resurface`, which stays exactly what it was: did the
 * list actually get LONGER. A refused write never did.
 *
 * `dismissShoppingSummary` does NOT come through here, and must not — its
 * `clearShoppingSummary` IS the write it was called to make, with no primary
 * result standing behind it, so it keeps rejecting and the card says so.
 */
async function settleShopping(
  workspaceId: string,
  resurface: boolean,
  result: ShoppingWriteResult,
): Promise<ShoppingWriteResult> {
  try {
    await syncShoppingSummary(workspaceId, { resurface });
  } catch (error) {
    logShoppingBookkeepingFailure(
      "shopping_summary_sync_failed",
      workspaceId,
      error,
    );
  }
  revalidatePath(SHOPPING_PATH);
  revalidatePath(INBOX_PATH);
  return result;
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
 *
 * That answer is threaded through {@link settleShopping} rather than returned
 * around it, so the inbox bookkeeping cannot rewrite what the write reported.
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
          // blocked add as a success — and the summary would be un-dismissed for
          // an add that never happened.
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

  // `added`, not `true`: an add is the write that CAN lengthen the list, and this
  // says whether it DID. A cap-blocked body and a give-up after two write conflicts
  // both wrote nothing and both leave it false (Duo review, !295 — passing `true`
  // here un-dismissed the summary for writes that never happened), which is why the
  // same flag is handed to all three tails below.
  //
  // OUTSIDE the transaction above, deliberately. The summary sync reads the item
  // count and writes at most one row in another table, so pulling it inside would
  // widen a SERIALIZABLE transaction's predicate-lock footprint for a row whose
  // exactness does not matter: `syncShoppingSummary` stores no count, so the worst
  // a lost sync can do is leave the inbox line absent until the next shopping
  // write, and the read side derives the number from the items either way. See the
  // module doc on src/lib/shopping-summary.ts.
  //
  // It settles even when nothing was written, which is correct rather than sloppy:
  // whatever the list now holds is what the inbox should say about it, and the sync
  // reads that rather than assuming this request changed anything. So a cap-hit is
  // also self-healing — a full list whose items have all been ticked off carries a
  // summary row that no longer belongs, and this is the call that deletes it. The
  // reasoning is in `settleShopping`, under "Refusals reach here too".
  if (full) {
    return settleShopping(workspaceId, added, { ok: false, refused: "full" });
  }
  if (!added) {
    return settleShopping(workspaceId, added, {
      ok: false,
      refused: "conflict",
    });
  }
  return settleShopping(workspaceId, added, { ok: true });
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
  const result: ShoppingWriteResult =
    count === 0 ? { ok: false, refused: "missing" } : { ok: true };
  // A rename cannot change the count, so it is not a reason to un-dismiss.
  return settleShopping(workspaceId, false, result);
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
  const ticked = Boolean(done);
  const { count } = await prisma.shoppingItem.updateMany({
    where: { id, workspaceId },
    data: { done: ticked },
  });
  const result: ShoppingWriteResult =
    count === 0 ? { ok: false, refused: "missing" } : { ok: true };
  // Un-ticking puts something back on the list, so it resurfaces a dismissed
  // summary; ticking off is progress, and resurrecting the line as a reward for
  // progress is precisely what the `resurface` rule exists to avoid.
  //
  // `count > 0` as well as the direction (Duo review, !295): a stale id, or one
  // belonging to another workspace, is a 0-row no-op — nothing came back onto the
  // list, so nothing should come back into the inbox. It is the same `count` the
  // `missing` above is read from, which is why the two cannot disagree.
  //
  // And then the row itself (Duo review round 5, !295). The direction and the
  // matched-row count together still cannot see the item's OTHER flag: `done` and
  // `savedForLater` are independent, and the combination is two taps away on
  // /shopping, because every row in BOTH sections renders a live checkbox. Un-tick
  // something sitting in the saved-for-later pile and the list has not grown —
  // `savedForLater` keeps it out of the count either way — so the summary must
  // stay dismissed. Asking `isStillToBuy` of the row as it now stands is the same
  // predicate the count filters on, applied to one row rather than restated.
  return settleShopping(
    workspaceId,
    !ticked && count > 0 && (await isOnTheToBuyList(id, workspaceId)),
    result,
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
  // Guarded HERE rather than by the caller, because the caller evaluates this in
  // `settleShopping`'s argument list — before the call, and therefore outside the
  // best-effort catch inside it. A rejected read would reject a write that had
  // already committed, which is the one shape `settleShopping` exists to prevent,
  // arriving through the single door it could not cover (#199, review of !295).
  //
  // `false` is not a guess: it is the same conservative answer a vanished row
  // gives below. Both mean "no reason to resurface a dismissed summary", and the
  // next shopping write re-derives the line anyway.
  try {
    const row = await prisma.shoppingItem.findFirst({
      where: { id, workspaceId },
      select: { done: true, savedForLater: true },
    });
    return row !== null && isStillToBuy(row);
  } catch (error) {
    logShoppingBookkeepingFailure(
      "shopping_readback_failed",
      workspaceId,
      error,
    );
    return false;
  }
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
): Promise<ShoppingWriteResult> {
  const workspaceId = await shoppingWorkspace();
  if (!workspaceId) return { ok: false, refused: "unavailable" };
  const saved = Boolean(savedForLater);
  const { count } = await prisma.shoppingItem.updateMany({
    where: { id, workspaceId },
    data: shoppingSavedForLaterUpdate(saved),
  });
  const result: ShoppingWriteResult =
    count === 0 ? { ok: false, refused: "missing" } : { ok: true };
  // Pulling an item back up lengthens the to-buy list; moving one down shortens it.
  // `count > 0` for the same reason as the tick above: a 0-row no-op lengthened
  // nothing (Duo review, !295).
  //
  // No read-back here, unlike `setShoppingItemDone` — and that asymmetry is the
  // fix, not an oversight. The un-tick can only see one of the two flags it
  // depends on; this write sets BOTH, so a matched row is on the to-buy list by
  // construction and there is nothing left to ask the database.
  return settleShopping(workspaceId, !saved && count > 0, result);
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
 * again. The settle still runs unconditionally, because in that case the row the
 * page is showing is exactly the thing that is wrong.
 */
export async function deleteShoppingItem(
  id: string,
): Promise<ShoppingWriteResult> {
  const workspaceId = await shoppingWorkspace();
  if (!workspaceId) return { ok: false, refused: "unavailable" };
  await prisma.shoppingItem.deleteMany({ where: { id, workspaceId } });
  // A delete can only shorten the list. It can also EMPTY it, which is what
  // removes the summary row altogether — handled inside syncShoppingSummary
  // rather than here, so "the list is empty" has one definition.
  return settleShopping(workspaceId, false, { ok: true });
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
 *
 * **Deliberately not a {@link ShoppingWriteResult}, and deliberately still able
 * to reject.** Its `clearShoppingSummary` IS the write the user asked for, with
 * no primary result standing behind it, so there is nothing here for a failure
 * to be reported *instead of* — the reason `settleShopping`'s catch exists does
 * not apply, and swallowing the failure would leave the person told nothing at
 * all. `shopping-summary-card.tsx` renders the rejection.
 */
export async function dismissShoppingSummary() {
  const workspaceId = await shoppingWorkspace();
  if (!workspaceId) return;
  await clearShoppingSummary(workspaceId);
  revalidatePath(INBOX_PATH);
}
