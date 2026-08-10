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
 *    missing nudge rather than a wrong one. Proved rather than promised, against
 *    a real database, in `shopping-summary-sync.integration.test.ts` — the same
 *    branch a first deploy over a pre-existing list takes.
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
 * ## This module is CLIENT-SAFE, and that is enforced
 *
 * `shopping-summary-card.tsx` is a `"use client"` component and imports
 * {@link shoppingSummaryLabel} from here, so this module must not reach the
 * database — `src/lib/db.ts` constructs `new PrismaClient()` at module scope, so one
 * import of it from a client graph bundles the whole Prisma client into the browser
 * (measured: two chunks of 156 KB carrying "unable to run in this browser") and
 * throws when that chunk is evaluated. `next build` is green either way.
 *
 * The first draft of this feature did exactly that, because the sync lived here too.
 * The writes are now in `shopping-summary-sync.ts` and
 * `src/lib/client-server-boundary.test.ts` fails the suite if any client component's
 * transitive imports ever reach the database client again — so this is a guarantee
 * rather than a note asking the next person to be careful. `strings.ts` carries the
 * same promise in prose at the top of the file; this one has a gate behind it.
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
