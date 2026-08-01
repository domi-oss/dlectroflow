import { PrismaClient, Prisma } from "@prisma/client";
import type { Settings, Streak } from "@prisma/client";

// Reuse a single PrismaClient across dev HMR reloads to avoid exhausting
// connections (Next.js re-imports modules on every change in development).
const globalForPrisma = globalThis as unknown as {
  prisma?: PrismaClient;
};

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    // Prisma's own client-level logger, and the reason `firstUseByWorkspace`
    // below goes to the trouble of never raising (#156): this prints the
    // moment a query fails, which is strictly *before* the exception reaches
    // any of our `catch` blocks. A failure we fully handle would still print
    // at error level, indistinguishable from an incident. Keeping this channel
    // truthful is worth more than the convenience of catching, so nothing here
    // filters or downgrades it — a `prisma:error` line means a real failure.
    log: process.env.NODE_ENV === "development" ? ["error", "warn"] : ["error"],
  });

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = prisma;

/**
 * True when the error is a Prisma unique-constraint violation (P2002).
 *
 * Matches on the code alone, deliberately: `meta.target` names the columns,
 * and a caller that filtered on it would have to know whether the PK or the
 * unique index lost — which differs between Postgres versions and between
 * single- and multi-column conflicts. Callers that tolerate a duplicate
 * tolerate any duplicate (src/lib/rewards.ts, guest-quota.ts, user-quota.ts,
 * src/app/actions/people.ts).
 */
export function isUniqueViolation(e: unknown): boolean {
  return (
    e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002"
  );
}

/** Every per-workspace singleton row keys its PK to the workspace id. */
type WorkspaceSingletonRow = { id: string; workspaceId: string };

/**
 * The two delegate methods `firstUseByWorkspace` calls, structurally.
 *
 * Prisma's generated delegates are generic over `select`/`include`, so they
 * cannot be named directly in a reusable signature. Describing only the exact
 * two calls we make — neither of which passes `select`, so the whole row always
 * comes back — lets one implementation serve both tables: the real delegates
 * are structurally assignable to this, and `Row` infers to `Settings` /
 * `Streak` with no cast. Worth the indirection, because the alternative is the
 * same twenty lines written twice, which is how Streak came to carry the #156
 * bug alongside Settings in the first place.
 */
type WorkspaceSingletonDelegate<Row extends WorkspaceSingletonRow> = {
  findUnique(args: { where: { workspaceId: string } }): Promise<Row | null>;
  createManyAndReturn(args: {
    data: WorkspaceSingletonRow;
    skipDuplicates: boolean;
  }): Promise<Row[]>;
};

/**
 * Read the workspace's row from a per-workspace singleton table, creating it
 * on first use, **without ever raising on a concurrent first use** (#156).
 *
 * Read → create-if-absent → read is the classic shape, and the classic shape
 * races: two callers can both see nothing and both insert. What makes this one
 * quiet is `createManyAndReturn` + `skipDuplicates`, the only Prisma API that
 * compiles to `INSERT ... ON CONFLICT DO NOTHING`. The loser inserts no row and
 * gets an empty array back — no exception, and so nothing for Prisma's client
 * logger to print. `upsert` cannot do this here: the create sets both the `id`
 * PK and the unique `workspaceId`, which Prisma cannot express as one atomic
 * statement, so it genuinely inserts and genuinely fails with P2002.
 *
 * Catching that P2002 (what this used to do) was correct but not enough — see
 * the note on `log` above. The trade is one extra round trip on the single
 * first-use call per workspace, in exchange for the steady-state path becoming
 * one indexed read instead of an upsert.
 */
async function firstUseByWorkspace<Row extends WorkspaceSingletonRow>(
  model: string,
  delegate: WorkspaceSingletonDelegate<Row>,
  workspaceId: string,
): Promise<Row> {
  const existing = await delegate.findUnique({ where: { workspaceId } });
  if (existing) return existing;

  const [created] = await delegate.createManyAndReturn({
    data: { id: workspaceId, workspaceId },
    skipDuplicates: true,
  });
  if (created) return created;

  // DO NOTHING means somebody else got there first, and their row is already
  // committed: Postgres blocks a conflicting insert on the unique index until
  // the winning transaction resolves, and only then decides to skip. So this
  // read cannot miss for timing reasons.
  const winner = await delegate.findUnique({ where: { workspaceId } });
  if (winner) return winner;

  // Which leaves one way to get here: the row was deleted between the two
  // statements. Both tables cascade from Workspace and nothing else deletes
  // them, so that means the workspace itself is gone — re-creating would only
  // fail on the foreign key. Say what happened instead.
  throw new Error(
    `${model} row for workspace ${workspaceId} vanished during first-use ` +
      `creation — the workspace was deleted concurrently.`,
  );
}

/**
 * Fetch (creating on first use) the Settings row for a workspace.
 *
 * Every authenticated render reads settings, and `src/app/(app)/layout.tsx`
 * and the page beneath it both do it within a *single* request — so the first
 * render for a brand-new workspace fires concurrent creates on its own. Two
 * replicas widen that window; they are not needed to open it.
 *
 * That race is harmless and self-healing, and it was already handled. What it
 * was not was quiet: it printed `prisma:error … Unique constraint failed on
 * the fields: (\`id\`)` on every cold start, and was duly reported as a
 * production incident (#156). `firstUseByWorkspace` is the fix — stop losing
 * loudly by not raising at all.
 */
export async function getSettings(workspaceId: string): Promise<Settings> {
  return firstUseByWorkspace("Settings", prisma.settings, workspaceId);
}

/**
 * Fetch (creating on first use) the Streak row for a workspace.
 *
 * Identical first-use race to `getSettings`, on the identical cold-start path
 * — the app layout reads settings while the page under it reads the streak
 * (#156).
 */
export async function getStreak(workspaceId: string): Promise<Streak> {
  return firstUseByWorkspace("Streak", prisma.streak, workspaceId);
}
