/**
 * #199 — the shopping summary's WRITES. Server-only.
 *
 * Split out of `shopping-summary.ts` so that module stays client-safe: the inbox
 * card is a `"use client"` component and imports `shoppingSummaryLabel`, and
 * `src/lib/db.ts` constructs `new PrismaClient()` at module scope — so holding both
 * halves in one file pulled the whole Prisma client into the browser bundle (two
 * chunks of 156 KB, carrying "unable to run in this browser") and would have thrown
 * the moment that chunk was evaluated. `next build` was green.
 *
 * `src/lib/client-server-boundary.test.ts` now fails the suite if any client
 * component's transitive imports reach the database client, so the split is enforced
 * rather than remembered.
 *
 * Read `shopping-summary.ts` first: it holds the decision this file implements, and
 * in particular WHY the row stores no count.
 */

import { prisma } from "@/lib/db";

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
