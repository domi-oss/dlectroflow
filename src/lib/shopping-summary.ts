import { prisma } from "@/lib/db";
import { t, type Voice } from "@/lib/strings";

/**
 * #199 — the inbox's shopping-list summary.
 *
 * When the shopping list has something on it, the inbox carries one line reading
 * *"3 items on your shopping list"*, linking to `/shopping`. The owner chose a
 * **real, persisted row kept in sync** rather than a line derived on the fly,
 * knowing the cost — so this is that row, with the cost paid down as far as it
 * will go.
 *
 * ## The row stores WHETHER, never HOW MANY
 *
 * This is the whole design, and it is what makes "the count can never disagree
 * with the list" a structural fact rather than a maintenance promise. The row
 * carries no number and no text: only its existence, and whether it has been
 * dismissed. The count is `prisma.shoppingItem.count` at render time, from the
 * same predicate `/shopping` uses for its own header.
 *
 * ## What a missed sync can and cannot do
 *
 * The item write and this one are two statements, not one transaction, so a crash
 * between them — or a future writer that forgets to call
 * {@link syncShoppingSummary} — leaves them briefly disagreeing. Both directions of
 * that are stated here rather than left for someone to discover:
 *
 *  * **Row outlives the list.** {@link shoppingSummaryVisible} answers with NO
 *    summary, because the count it derives is zero. The line disappears; nothing
 *    wrong is displayed.
 *  * **List outlives the row.** No line is shown until the next shopping write,
 *    which re-runs this sync and creates it. Self-healing, and the failure is a
 *    missing nudge rather than a wrong one.
 *
 * Neither loses data and neither can display a number the list does not have,
 * because there is no second copy of the number to go stale. That is the whole
 * reason a transaction is not reached for here: the residual is a line that is
 * absent for a while, which is cheaper than wrapping every shopping write in one.
 *
 * ## Why its own table, and not a `BrainDumpItem`
 *
 * A generated row in `BrainDumpItem` would be visible to every one of the
 * eighteen files that query that table, and two of those are not cosmetic:
 *
 *  * `maybeAwardInboxZero` (`src/lib/rewards.ts`) counts un-triaged inbox items,
 *    so a permanent generated row would make **inbox zero unreachable** for
 *    anybody who keeps a shopping list — a badge and a daily reward silently
 *    switched off by an unrelated feature.
 *  * `bucketItems` / `libraryBuckets` (`src/components/inbox/bucket.ts`) place
 *    items by `status`, `snoozedUntil` and `completedAt`, so dismissing or
 *    snoozing the summary would file it into the Library's "saved for later" or
 *    "done" tabs, where it is not an item anybody can act on.
 *
 * Plus the freshness/aging machinery, the untriaged nav badge and the
 * daily-review nudge, each of which would need its own exclusion. Keeping the row
 * in its own table makes all of that true by construction instead of by seven
 * exclusions that a future query can forget — the same reasoning `ShoppingItem`
 * itself rests on (a separate table earns nothing by default because the code
 * that grants it cannot see the rows).
 *
 * It is still a real persisted row kept in sync, which is what was decided. What
 * it is not is a fake brain-dump capture.
 *
 * ## Not in the data export
 *
 * It is app-generated bookkeeping — the user never typed it, and it says nothing
 * their own `ShoppingItem` rows do not. It is listed in `DELIBERATELY_EXCLUDED` in
 * `src/lib/export/__tests__/model-coverage.test.ts` with that reason, and
 * `src/lib/export/json.test.ts` asserts its absence, so the exclusion can never be
 * mistaken for hiding real user data.
 */

/** The stored row, reduced to the only field a reader needs. Deliberately not the
 *  Prisma row: taking a structural type keeps the decision testable without a
 *  database. */
export type ShoppingSummaryRow = { clearedAt: Date | null };

/**
 * Should the inbox show a summary, and with what count?
 *
 * `null` means "show nothing", and it is the answer in four different situations
 * on purpose: no row, a dismissed row, an empty list, and a nonsensical count. The
 * caller has one thing to branch on rather than four.
 */
export function shoppingSummaryVisible(input: {
  row: ShoppingSummaryRow | null;
  /** How many items are still to buy — `shoppingRemainingCount`'s rule, counted
   *  in the database. */
  remaining: number;
}): { count: number } | null {
  const { row, remaining } = input;
  if (row === null || row.clearedAt !== null) return null;
  // `>= 1` and integral, rather than `> 0`: this value comes from a `count()`, so
  // anything else means the caller is wrong, and rendering "0.5 items" would be a
  // worse outcome than rendering nothing.
  if (!Number.isInteger(remaining) || remaining < 1) return null;
  return { count: remaining };
}

/**
 * The line the inbox shows.
 *
 * Composed from the counted-noun keys rather than a template with a placeholder:
 * `src/lib/strings.ts` is a flat label table with no interpolation (#86), and
 * `shopping.itemOne`/`shopping.itemMany` already serve the `/shopping` header — so
 * the two surfaces cannot come to disagree about what one item is called.
 */
export function shoppingSummaryLabel(count: number, voice: Voice): string {
  const noun = t(count === 1 ? "shopping.itemOne" : "shopping.itemMany", voice);
  return `${count} ${noun} ${t("shopping.summaryOn", voice)}`;
}

/**
 * Bring the summary row into line with the list. Called by every shopping write.
 *
 * ## `resurface` — when a dismissed summary comes back
 *
 * The issue's rule is that ticking the summary off clears it now and adding
 * another shopping item brings it back. Read literally that is "any change to the
 * list", but a change that cannot make the list LONGER is not a new reason to
 * remind anybody: dismissing the line and then ticking items off on the shopping
 * page would resurrect it as a reward for making progress.
 *
 * So `resurface` is true exactly for the three writes that can increase the count
 * — adding an item, un-ticking one, and pulling one back up from saved-for-later —
 * and false for ticking, saving for later, deleting and renaming. Each caller
 * knows which it is, which is why this is a parameter rather than something
 * inferred here from a stored previous count. Storing a previous count is the one
 * thing this design refuses to do.
 *
 * ## Why `upsert` on the primary key
 *
 * `workspaceId` IS the primary key, so two concurrent adds cannot create two
 * summary rows: the loser's insert collides and becomes an update. A
 * `findFirst`-then-`create` would need `Serializable` or an advisory lock to say
 * the same thing, and would still be one row per race in between.
 *
 * `deleteMany` rather than `delete` when the list empties, so a concurrent delete
 * of the same row is a 0-row no-op instead of a P2025 throw — the reason
 * `deleteBrainDumpItem` uses it too.
 */
export async function syncShoppingSummary(
  workspaceId: string,
  options: { resurface: boolean },
): Promise<void> {
  // The same predicate `shoppingRemainingCount` applies in memory, counted in the
  // database. Two spellings of one rule is a real risk, and the pure function is
  // the readable one — but the summary must not load the whole list to answer a
  // count, and the /shopping page must not issue a query to answer it from rows it
  // already holds. `shopping-summary.integration.test.ts` asserts the two agree.
  const remaining = await prisma.shoppingItem.count({
    where: { workspaceId, done: false, savedForLater: false },
  });

  if (remaining === 0) {
    await prisma.shoppingSummary.deleteMany({ where: { workspaceId } });
    return;
  }

  await prisma.shoppingSummary.upsert({
    where: { workspaceId },
    create: { workspaceId },
    // An empty `update` is deliberate and is NOT a no-op call to remove: it is
    // what "the row already exists and this write is not a reason to un-dismiss
    // it" looks like, and the upsert still has to run because the row may not
    // exist yet (the first add is `resurface: true`, but so is the first un-tick
    // of an item on a list whose summary was never created).
    update: options.resurface ? { clearedAt: null } : {},
  });
}

/**
 * Dismiss the summary until the list next grows.
 *
 * ONE control, not a tick and a snooze. The issue asks for "ticking it off clears
 * it from the inbox now" and for snoozing to "behave consistently with that" —
 * and the most consistent possible outcome is that there is one gesture with one
 * meaning. Two controls that did the same thing would be two things to explain and
 * a place for them to drift apart.
 *
 * `updateMany` with the workspace in the filter, so a row belonging to somebody
 * else is a 0-row no-op rather than an error (the scoping invariant's shape for a
 * write addressed by id).
 */
export async function clearShoppingSummary(workspaceId: string): Promise<void> {
  await prisma.shoppingSummary.updateMany({
    where: { workspaceId },
    data: { clearedAt: new Date() },
  });
}
