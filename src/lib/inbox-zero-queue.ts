import type { Prisma } from "@prisma/client";
import { BrainDumpStatus } from "@/lib/constants";

/**
 * What "still needs triage" means — the ONE definition of the queue
 * `maybeAwardInboxZero` measures (#251 review).
 *
 * A row is in it when it is still in the Inbox bucket, is not completed, and is
 * not snoozed into the future. Three terms, and every caller needs all three:
 * `deleteBrainDumpItem` used to gate its award on the completion alone, which is
 * one of them, and so paid a fresh `inbox_zero` for deleting a TRIAGED row that
 * had never been in the count at all — measured at 10 points taken back and 15
 * paid out, plus a once-ever badge, on the call whose job is to take a payout
 * back.
 *
 * ── Two shapes, and why that is not two copies ───────────────────────────────
 *
 * The award asks "how many rows are in the queue", which is SQL. A caller
 * deciding whether the row it just deleted was one of them has only a snapshot in
 * memory, because by the time it asks, its own guarded `updateMany` has already
 * cleared `completedAt`. Those are genuinely different questions and no single
 * expression answers both — so the two shapes live here, side by side, and
 * `inbox-zero-queue.integration.test.ts` runs them over the same rows and fails
 * if they ever disagree. That is what makes this one definition rather than two
 * copies: the drift the delete's own comment was right to fear is now mechanical
 * to catch instead of something to be careful about.
 *
 * ── Its own module, with no `@/lib/db` ──────────────────────────────────────
 *
 * The same shape every hygiene parser in this repo uses, for the same reason: a
 * predicate that can only be reached through `rewards.ts` drags the Prisma
 * singleton into every test that wants it, and five action tests mock
 * `@/lib/rewards` wholesale — so putting it there would have meant each of them
 * listing a pure function in a mock factory, which is exactly how a fourth copy
 * gets written. `rewards.ts` and `braindump.ts` both import from here.
 *
 * `now` is a parameter rather than a default so both shapes can be asked about
 * the same instant; a default would let the agreement test compare two clocks.
 */
export function inboxZeroQueueWhere(
  workspaceId: string,
  now: Date,
): Prisma.BrainDumpItemWhereInput {
  return {
    workspaceId,
    status: BrainDumpStatus.Inbox,
    completedAt: null,
    OR: [{ snoozedUntil: null }, { snoozedUntil: { lte: now } }],
  };
}

/**
 * The same three terms, against a row already in hand. See above.
 *
 * `snoozedUntil <= now` mirrors the `lte` in the `where` and not a `<`: a snooze
 * that has just elapsed is back in the queue, and the two shapes disagreeing on
 * that boundary is precisely what the agreement test's `snooze=now` case exists
 * to catch.
 */
export function countsTowardInboxZero(
  row: { status: string; completedAt: Date | null; snoozedUntil: Date | null },
  now: Date,
): boolean {
  return (
    row.status === BrainDumpStatus.Inbox &&
    row.completedAt === null &&
    (row.snoozedUntil === null || row.snoozedUntil <= now)
  );
}
