import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { getGoogleStatus } from "@/lib/google";
import { getOwnFeedTimestamps } from "@/lib/calendar-feed";
import { getOwnAiUsageRow } from "@/lib/user-quota";
import type { ExportSnapshot } from "./types";

/**
 * #129 — read one workspace's entire contents, once.
 *
 * ## This is the only place authorization happens
 *
 * Everything else in the feature is a pure function over what this returns, so
 * there is exactly one line that decides whose data is in the archive: the
 * `workspaceId` filter, on every statement. `collectExport` takes that id as a
 * parameter and does NOT resolve it — `src/app/api/export/route.ts` is the only
 * caller in the app, it accepts NO route parameters, no query string and no body,
 * and it fills both arguments from `currentWorkspaceId()` and `currentUser()`. So
 * there is nothing in a request for a caller to point at somebody else's data.
 * That is `src/app/actions/account.ts` Rule 1 applied to a read: the safe shape
 * is the one with no id to supply, not the one with a check a refactor can drop.
 *
 * An export route is a uniquely attractive IDOR target — it returns everything
 * about an account in a single request — so the guarantee is proved rather than
 * argued: `collect.integration.test.ts` populates two workspaces and asserts that
 * none of one's private strings appear anywhere in the other's rendered archive.
 *
 * ## Why many statements in one transaction, not one nested query
 *
 * `prisma.workspace.findUnique({ include: { tasks: …, brainDumpItems: …, … } })`
 * would be one call and would be WRONG for this codebase, for a reason that has
 * nothing to do with SQL: `Workspace` carries no `workspaceId` column, so
 * `src/lib/__tests__/scoping.harness.test.ts` — which is what makes the scoping
 * invariant structural rather than aspirational — cannot see inside the include
 * and would report this file as clean while it read every one of these tables under a filter
 * nobody was checking. Written as separate `where: { workspaceId }` statements,
 * every one of them is policed by name.
 *
 * The array form of `$transaction` then buys back the property the nested read
 * would have had for free — but only at `RepeatableRead`, which is why the
 * isolation level is set explicitly. Postgres's default `READ COMMITTED` takes a
 * FRESH snapshot per statement even inside a transaction, so these statements
 * would each see a different state of the database and an export could
 * contain a brain-dump item pointing at a task that is not in the same archive.
 * `RepeatableRead` pins one snapshot for all of them. It costs nothing here: the
 * transaction is read-only, so it cannot hit the serialization failures that make
 * a higher isolation level expensive for writers.
 *
 * `Step` and `BreakdownTurn` are the exception, and cannot help it: neither
 * carries a `workspaceId`, so both are reached through the scoped `task` read as
 * an `include`. Same idiom as `src/app/api/ics/[taskId]/route.ts`.
 *
 * ## The account-scoped half, and why it was missing
 *
 * Everything above is workspace content. The reads after the transaction are the
 * records the app keeps ABOUT the account — `User`, the `Allowlist` invitation,
 * the `UserAiUsage` meter and the `CalendarFeed` timestamps — and until this
 * change three of those tables were absent from the export entirely while
 * `/privacy` disclosed holding all three.
 *
 * They were not forgotten by accident twice over. `__tests__/model-coverage.test.ts`
 * is the guard for exactly this failure, and its predicate was `declares
 * workspaceId`, so an account-scoped table could not appear in the list it checks.
 * A table hanging off `User` was invisible to the mechanism built to notice a
 * missing table. That predicate now has a second arm for relations to `User`, and
 * these reads are what satisfy it.
 *
 * ## It reads and does not write
 *
 * Deliberately NOT `getSettings()` / `getStreak()`, which create the row on first
 * use (#156). An export must not modify the thing it is exporting — and a
 * brand-new account that has never opened Settings has no row, which is a fact
 * about that account, not an error to paper over. Both are typed nullable and
 * every serialiser handles null.
 *
 * Stated precisely, because the claim is worth being exact about: nothing in THIS
 * function writes. The request around it does touch `Workspace.lastSeenAt`, since
 * `currentWorkspaceId()` upserts it for every request in the app — that is a fact
 * about being seen, not about the content being exported, and `collect.integration.test.ts`
 * asserts the settings and streak rows are still absent afterwards.
 */
export async function collectExport(input: {
  /** Resolved from the session by the caller. There is no request-controlled
   *  path to this parameter — see the note above. */
  workspaceId: string;
  /** The signed-in account, or null for a guest sandbox. */
  userId: string | null;
  /** Injectable so the archive's timestamps are deterministic under test. */
  now?: Date;
}): Promise<ExportSnapshot> {
  const { workspaceId, userId } = input;
  const exportedAt = input.now ?? new Date();

  const [
    workspace,
    settings,
    tasks,
    inbox,
    focusSessions,
    focusPlaylists,
    shoppingItems,
    streak,
    streakRecords,
    badges,
    rewardEvents,
    engagementDays,
    dayRollups,
    dailySparks,
  ] = await prisma.$transaction(
    [
      prisma.workspace.findUnique({
        where: { id: workspaceId },
        // `lastSeenAt` alongside the account's: the schema has two last-seen
        // columns and exporting one while withholding the other is the
        // partial-list defect this file's account read was fixed for. `userId`
        // stays out as a pure foreign key that repeats `account.id`.
        select: {
          id: true,
          kind: true,
          createdAt: true,
          lastSeenAt: true,
          expiresAt: true,
        },
      }),
      prisma.settings.findUnique({ where: { workspaceId } }),
      prisma.task.findMany({
        where: { workspaceId },
        // Steps and turns are reached through this scoped read; ordering is fixed
        // so two exports of unchanged data are byte-identical, which is what makes
        // an export diffable and a test assertable.
        include: {
          steps: { orderBy: { order: "asc" } },
          turns: { orderBy: { createdAt: "asc" } },
        },
        orderBy: { createdAt: "asc" },
      }),
      prisma.brainDumpItem.findMany({
        where: { workspaceId },
        orderBy: { createdAt: "asc" },
      }),
      prisma.focusSession.findMany({
        where: { workspaceId },
        orderBy: { startedAt: "asc" },
      }),
      // #185, added in review of #199 — see the note on `focusPlaylists` in
      // types.ts. This table was missing from the export entirely.
      prisma.focusPlaylist.findMany({
        where: { workspaceId },
        orderBy: { createdAt: "asc" },
      }),
      // #199 — the shopping list. Ordered by the same key the page renders in
      // (capture order, tie-broken on id) so two exports of unchanged data are
      // byte-identical, which is what makes an export diffable and assertable.
      prisma.shoppingItem.findMany({
        where: { workspaceId },
        orderBy: [{ order: "asc" }, { id: "asc" }],
      }),
      prisma.streak.findUnique({ where: { workspaceId } }),
      prisma.streakRecord.findMany({
        where: { workspaceId },
        orderBy: { startedAt: "asc" },
      }),
      prisma.badge.findMany({
        where: { workspaceId },
        orderBy: { earnedAt: "asc" },
      }),
      prisma.rewardEvent.findMany({
        where: { workspaceId },
        orderBy: { createdAt: "asc" },
      }),
      // #233 — the per-day engagement ledger. Ordered on `(day, id)` rather than
      // on `createdAt` alone: `day` is the key the table exists to be read by,
      // and the `id` tie-break is what makes two exports of unchanged data
      // byte-identical, which is the property every other read here maintains
      // and what makes an export diffable and assertable.
      prisma.engagementDay.findMany({
        where: { workspaceId },
        orderBy: [{ day: "asc" }, { id: "asc" }],
      }),
      prisma.dayRollup.findMany({
        where: { workspaceId },
        orderBy: { date: "asc" },
      }),
      prisma.dailySpark.findMany({
        where: { workspaceId },
        orderBy: { date: "asc" },
      }),
    ],
    // See the note above: at the default READ COMMITTED each of these statements
    // would get its own snapshot.
    { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
  );

  // ── The account, and the records that hang off it ─────────────────────────
  //
  // Outside the transaction because none of it is workspace content. Every one of
  // these is keyed by the id the session verified, so there is still nothing in a
  // request for a caller to point at somebody else's rows.
  //
  // THREE of these five reach their table through a named module rather than
  // through `prisma` here, and it is the same reason in all three cases:
  // `src/lib/__tests__/scoping.harness.test.ts` confines the whole
  // `prisma.googleAuth`, `prisma.calendarFeed` and `prisma.userAiUsage` surface to
  // one file each, as a compensating control against an IDOR on a user-keyed row.
  // `getGoogleStatus` was already the idiom; `getOwnFeedTimestamps` and
  // `getOwnAiUsageRow` follow it. `src/lib/export/__tests__/model-coverage.test.ts`
  // records the indirection and asserts each module really queries its model, so
  // the route stays checkable rather than becoming a place a read can go missing.
  //
  // `getGoogleStatus` returns three booleans — no token, encrypted or otherwise,
  // is reachable from here at all — and `getOwnFeedTimestamps` never selects the
  // feed token, so both credential surfaces are absent by construction rather
  // than by a serialiser remembering to drop something.
  const [account, invitation, aiUsage, calendarFeed, googleTasks] =
    await Promise.all([
      userId
        ? prisma.user.findUnique({
            where: { id: userId },
            // An explicit select, not the whole row: `llmKeyEnc` is one careless
            // spread away from a user's own encrypted API key ending up in a file
            // they are about to email to somebody.
            //
            // The cost of that decision is that a select silently omits any
            // column added later, and it was being paid — `providerSub`,
            // `status`, `lastSeenAt`, `revokedAt`, `llmProvider` and `purgeAfter`
            // were all held and unexported. So the list is now every column but
            // `llmKeyEnc`, and `model-coverage.test.ts` derives that from
            // `Prisma.dmmf` and fails when a new column is not here. Keep it
            // exhaustive; if a future column must be withheld, argue for it there.
            select: {
              id: true,
              provider: true,
              providerSub: true,
              handle: true,
              // #252 — the name they typed in themselves, which is personal data
              // they supplied and therefore squarely inside Art. 15/20.
              displayName: true,
              email: true,
              role: true,
              status: true,
              aiPolicy: true,
              aiQuota: true,
              llmProvider: true,
              createdAt: true,
              lastSeenAt: true,
              revokedAt: true,
              purgeAfter: true,
            },
          })
        : Promise.resolve(null),
      // The invitation that made this account possible. `claimedById` is the key
      // and it is `@unique`, so this is one row addressed by the verified session
      // id — NOT `identity`, which is a string the inviting owner typed and would
      // be a lookup by user-supplied value.
      //
      // Unlike the two below, `Allowlist` is not pinned to a module by the scoping
      // harness, because that harness keys on a `userId` COLUMN and this table
      // links to `User` through `claimedById`. It is read directly here for that
      // reason, and `model-coverage.test.ts`'s predicate uses the relation rather
      // than the column name precisely so this table cannot hide from it again.
      userId
        ? prisma.allowlist.findUnique({
            where: { claimedById: userId },
            // `id` and `claimedById` are omitted as carrying nothing a reader can
            // use: the first is an internal cuid and the second repeats
            // `account.id`, which is in the same file.
            select: {
              provider: true,
              identity: true,
              // The private note whoever invited them wrote. Free text ABOUT the
              // data subject, disclosed as collected on /privacy — which is what
              // makes withholding it from their own export indefensible rather
              // than merely untidy.
              note: true,
              isOwnerSeed: true,
              invitedAt: true,
              claimedAt: true,
            },
          })
        : Promise.resolve(null),
      userId ? getOwnAiUsageRow(userId) : Promise.resolve(null),
      userId ? getOwnFeedTimestamps(userId) : Promise.resolve(null),
      getGoogleStatus(userId),
    ]);

  return {
    exportedAt,
    // A workspace row always exists here — `currentWorkspaceId()` upserts it
    // before returning — but the type is nullable and inventing a fake id would
    // be worse than saying what was read.
    workspace: workspace ?? {
      id: workspaceId,
      kind: "unknown",
      createdAt: exportedAt,
      lastSeenAt: exportedAt,
      expiresAt: null,
    },
    account,
    // All three are null for a guest sandbox, which has no account for them to
    // hang off — the same reason `account` itself is nullable.
    accountRecords: { invitation, aiUsage, calendarFeed },
    settings,
    tasks,
    inbox,
    focusSessions,
    focusPlaylists,
    shoppingItems,
    gamification: {
      streak,
      streakRecords,
      badges,
      rewardEvents,
      engagementDays,
      dayRollups,
      dailySparks,
    },
    integrations: { googleTasks },
  };
}
