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
 * ## Two statements, because ONE of them cannot be an `upsert`
 *
 * `workspaceId` IS the primary key, so the write is naturally a single
 * `INSERT … ON CONFLICT` in both directions and neither can produce a second
 * summary row. Which conflict action differs, and so does how you have to ask
 * Prisma for it:
 *
 *  * **Growing write** — `upsert` with a non-empty `update`, which Prisma 6.19
 *    compiles to native `INSERT … ON CONFLICT ("workspaceId") DO UPDATE SET
 *    "clearedAt" = $1`. Atomic; the loser's insert becomes the update.
 *  * **Non-growing write** — `createMany` + `skipDuplicates`, which compiles to
 *    `INSERT … ON CONFLICT DO NOTHING`. Also atomic, and it says exactly what
 *    this branch means: put a row there if there isn't one, and do not touch
 *    `clearedAt` if there is.
 *
 * **This was one `upsert` with `update: options.resurface ? {…} : {}` and that
 * was a real defect, not a style point.** Prisma only takes the native path when
 * the `update` payload is non-empty; with `{}` it silently falls back to
 * `BEGIN; SELECT; INSERT; COMMIT` — the `findFirst`-then-`create` shape, at the
 * default READ COMMITTED, which is exactly the shape that needs `Serializable`
 * or an advisory lock to be safe. Two non-growing writes racing from the no-row
 * state therefore both saw nothing and both inserted, and the loser got P2002:
 * five trials of four concurrent callers produced 15 raised duplicates, every
 * time. The primary key still refused the second row — the failure was a THROW,
 * out of `settleShopping` and out of the server action, failing a rename or a
 * tick whose item write had already committed.
 *
 * Not merely caught, either: `log: ["error"]` in `src/lib/db.ts` prints a failed
 * query before any `catch` can reach it, so a recovered duplicate still looks
 * like an incident in production logs. #156 and #158 are that lesson, and
 * `skipDuplicates` is the shape they settled on.
 *
 * The window is narrow — it needs a non-empty list with no summary row, which is
 * the first-deploy and missed-sync state described below — but that is the
 * busiest possible moment for it, since every pre-existing list is in it at once.
 *
 * `deleteMany` rather than `delete` when the list empties, so a concurrent delete
 * of the same row is a 0-row no-op instead of a P2025 throw — the reason
 * `deleteBrainDumpItem` uses it too.
 *
 * ## Creating a row does not consult `resurface`, and that is the right answer
 *
 * `resurface` means "un-dismiss a summary that WAS dismissed", so it has nothing
 * to say about a row that does not exist: an absent row carries no dismissal to
 * preserve. Neither branch names `clearedAt` when it inserts, so a newly created
 * row is born SHOWING whichever flag the caller passed.
 *
 * That path is reachable in exactly two states, and showing is right in both:
 *
 *  * **The day this ships**, for any workspace that already has `ShoppingItem`
 *    rows from !294. Its list is non-empty and has never been dismissed, so the
 *    line belongs in the inbox. Waiting for a *growing* write instead would hide
 *    the feature from precisely the people who already keep a list — and hide it
 *    indefinitely, since a list nobody adds to would never earn its line.
 *  * **A missed sync** — the "list outlives the row" case `shopping-summary.ts`
 *    promises is self-healing. This is what heals it.
 *
 * No dismissal can be lost this way, because a row is only ever removed when the
 * count reaches zero and climbing back above zero takes a growing write, which is
 * `resurface: true` regardless. Gating the insert on the flag was tried against a
 * real database and breaks both bullets above, so it is refused rather than
 * merely unimplemented — `shopping-summary-sync.integration.test.ts` executes
 * these statements for real, which the colocated unit test cannot: it mocks the
 * delegate, so "row exists" and "no row yet" are the same test twice there.
 *
 * (Duo review on !295 asked whether the create path honours `resurface`. It does
 * not and should not, per the above — but checking that against a real database
 * is what exposed the P2002 race, so the question was worth its round.)
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

  if (options.resurface) {
    // ON CONFLICT DO UPDATE. `create` leaves `clearedAt` out on purpose — a row
    // that does not exist holds no dismissal, so there is nothing to clear.
    await prisma.shoppingSummary.upsert({
      where: { workspaceId },
      create: { workspaceId },
      update: { clearedAt: null },
    });
    return;
  }

  // ON CONFLICT DO NOTHING — "make sure there is a row, and leave any dismissal
  // exactly as it was". Deliberately NOT an `upsert` with an empty `update`,
  // which reads as the same thing and is not: see the doc above for the P2002
  // race that spelling loses. `count: 0` is the ordinary answer here and needs
  // no branch, because "somebody else already has a row" is success.
  await prisma.shoppingSummary.createMany({
    data: { workspaceId },
    skipDuplicates: true,
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
