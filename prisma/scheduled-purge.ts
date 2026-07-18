/**
 * Scheduled guest-retention purge (#21). CronJob entrypoint.
 *
 * How it runs: the Helm chart's production-only `dlectroflow-guest-purge`
 * CronJob (see charts/dlectroflow/templates/purge-cronjob.yaml) runs
 * `npx tsx prisma/scheduled-purge.ts` on the SAME image as the app. Each run:
 *   - deletes guest workspaces past their TTL (workspace.delete → scoped rows
 *     cascade via their workspaceId FKs; see the workspace_cascade_fks migration)
 *   - deletes ipHash-keyed guest counters older than 30 days
 * and logs a single structured line tagged "scheduled_purge" with the counts.
 *
 * Self-contained on purpose — exactly like prisma/seed.ts. The standalone
 * production image contains only prisma/ + the traced node_modules; it has NO
 * app source (src/) and NO `@/` path-alias resolver. So this file imports only
 * `@prisma/client` (traced into the image because the app depends on it) and
 * inlines its own purge logic + OWNER_WORKSPACE_ID guard. An import that
 * reached into src/ would make the CronJob dead-on-arrival in prod; the guard
 * tests in src/lib/scheduled-purge.test.ts enforce that.
 */
import { PrismaClient } from "@prisma/client";

// Inlined from src/lib/constants.ts — cannot import app source here (see header).
const OWNER_WORKSPACE_ID = "owner";

/** How many expired guest workspaces to sweep per findMany batch. */
const PURGE_BATCH = 25;
/** Backstop on the drain loop so a pathological state can't spin forever. */
const MAX_BATCHES = 200;
/** Guest-counter retention window, in days. */
const COUNTER_RETENTION_DAYS = 30;

// The minimal Prisma surface the purge touches. Accepting this structural type
// (rather than the full PrismaClient) keeps the functions trivially unit-
// testable with a fake client, mirroring prisma/seed.ts's SeedClient.
export type PurgeClient = {
  $transaction(ops: readonly Promise<unknown>[]): Promise<unknown[]>;
  workspace: {
    findMany(args: unknown): Promise<{ id: string }[]>;
    delete(args: unknown): Promise<unknown>;
  };
  guestDailyActivity: { deleteMany(args: unknown): Promise<{ count: number }> };
  guestAiUsage: { deleteMany(args: unknown): Promise<{ count: number }> };
};

/** Delete a guest workspace. All workspace-scoped rows cascade via their
 * workspaceId FKs (Step/BreakdownTurn cascade transitively through Task). */
export async function purgeWorkspace(db: PurgeClient, id: string): Promise<void> {
  if (id === OWNER_WORKSPACE_ID) throw new Error("refusing to purge the owner workspace");
  await db.workspace.delete({ where: { id } });
}

/** Purge one bounded batch of guest workspaces past their TTL. Best-effort:
 * a per-row failure is skipped so one stuck row can't stall the whole run.
 * Returns the count successfully purged. */
export async function purgeExpiredGuests(db: PurgeClient): Promise<number> {
  const expired = await db.workspace.findMany({
    where: { kind: "guest", expiresAt: { lt: new Date() } },
    select: { id: true },
    take: PURGE_BATCH,
  });
  let purged = 0;
  for (const w of expired) {
    try {
      await purgeWorkspace(db, w.id);
      purged++;
    } catch {
      /* best-effort; skip on error */
    }
  }
  return purged;
}

/** Purge ipHash-keyed guest counters older than `days` (default 30). These are
 * not workspace-scoped (keyed by IP hash), so they need age-based retention. */
export async function purgeStaleGuestCounters(
  db: PurgeClient,
  now: Date = new Date(),
  days = COUNTER_RETENTION_DAYS,
): Promise<{ dailyActivity: number; aiUsage: number }> {
  const cutoff = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
  const cutoffDay = cutoff.toISOString().slice(0, 10); // YYYY-MM-DD (day column is a UTC date string)
  const [daily, ai] = (await db.$transaction([
    db.guestDailyActivity.deleteMany({ where: { day: { lt: cutoffDay } } }),
    db.guestAiUsage.deleteMany({ where: { updatedAt: { lt: cutoff } } }),
  ])) as [{ count: number }, { count: number }];
  return { dailyActivity: daily.count, aiUsage: ai.count };
}

/** Run a full purge: drain expired guest workspaces (batch after batch until
 * none remain, capped), then purge stale counters. Returns the run summary. */
export async function runScheduledPurge(
  db: PurgeClient,
): Promise<{ guestsPurged: number; dailyActivity: number; aiUsage: number }> {
  let guestsPurged = 0;
  for (let i = 0; i < MAX_BATCHES; i++) {
    const n = await purgeExpiredGuests(db);
    guestsPurged += n;
    if (n === 0) break;
  }
  const counters = await purgeStaleGuestCounters(db);
  return { guestsPurged, ...counters };
}

/** CLI entrypoint. Exits non-zero on failure so the CronJob surfaces errors. */
async function main(): Promise<void> {
  const prisma = new PrismaClient();
  try {
    const result = await runScheduledPurge(prisma as unknown as PurgeClient);
    console.log(JSON.stringify({ tag: "scheduled_purge", ...result }));
  } finally {
    await prisma.$disconnect();
  }
}

// Only run when invoked directly (tsx/node), not when imported by tests.
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  main()
    .then(() => process.exit(0))
    .catch((e) => {
      console.error(e);
      process.exit(1);
    });
}
