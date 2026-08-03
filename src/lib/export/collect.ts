import { prisma } from "@/lib/db";
import { getGoogleStatus } from "@/lib/google";
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
 * and would report this file as clean while it read ten tables under a filter
 * nobody was checking. Written as separate `where: { workspaceId }` statements,
 * every one of them is policed by name.
 *
 * The array form of `$transaction` then buys back the property the nested read
 * would have had for free: all ten statements see one snapshot, so the archive
 * cannot contain a task whose steps were written after the tasks were read.
 *
 * `Step` and `BreakdownTurn` are the exception, and cannot help it: neither
 * carries a `workspaceId`, so both are reached through the scoped `task` read as
 * an `include`. Same idiom as `src/app/api/ics/[taskId]/route.ts`.
 *
 * ## It reads and does not write
 *
 * Deliberately NOT `getSettings()` / `getStreak()`, which create the row on first
 * use (#156). An export must not modify the thing it is exporting — and a
 * brand-new account that has never opened Settings has no row, which is a fact
 * about that account, not an error to paper over. Both are typed nullable and
 * every serialiser handles null.
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
    streak,
    streakRecords,
    badges,
    rewardEvents,
    dayRollups,
    dailySparks,
  ] = await prisma.$transaction([
    prisma.workspace.findUnique({
      where: { id: workspaceId },
      select: { id: true, kind: true, createdAt: true, expiresAt: true },
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
    prisma.dayRollup.findMany({
      where: { workspaceId },
      orderBy: { date: "asc" },
    }),
    prisma.dailySpark.findMany({
      where: { workspaceId },
      orderBy: { date: "asc" },
    }),
  ]);

  // The account, and the integration metadata that hangs off it. Outside the
  // transaction because neither is workspace content: `User` is keyed by the id
  // the session verified, and `getGoogleStatus` is the ONLY read surface for the
  // credential table (the scoping harness pins that to src/lib/google.ts). What
  // it returns is three booleans — no token, encrypted or otherwise, is reachable
  // from here at all.
  const [account, googleTasks] = await Promise.all([
    userId
      ? prisma.user.findUnique({
          where: { id: userId },
          // An explicit select, not the whole row: `llmKeyEnc` is one careless
          // spread away from a user's own encrypted API key ending up in a file
          // they are about to email to somebody.
          select: {
            id: true,
            provider: true,
            handle: true,
            email: true,
            role: true,
            aiPolicy: true,
            aiQuota: true,
            createdAt: true,
          },
        })
      : Promise.resolve(null),
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
      expiresAt: null,
    },
    account,
    settings,
    tasks,
    inbox,
    focusSessions,
    gamification: {
      streak,
      streakRecords,
      badges,
      rewardEvents,
      dayRollups,
      dailySparks,
    },
    integrations: { googleTasks },
  };
}
