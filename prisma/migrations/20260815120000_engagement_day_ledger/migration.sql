-- #233 — the per-day engagement ledger. SCHEMA ONLY; the backfill is the next
-- migration, deliberately.
--
-- ── What this is for ───────────────────────────────────────────────────────
--
-- A streak day is earned by ANY qualifying engagement, and "Streak" holds only
-- `current` and `lastActiveWorkday`. That makes the counter monotonic in
-- practice: nothing can answer "would this day still have counted without the
-- item the user just deleted?", so `revokeUnqualifiedBadges` (src/lib/rewards.ts)
-- has to KEEP `streak_5`, `comeback` and `beat_best_streak` when a delete
-- destroys the work behind them. #251 took that decision explicitly and recorded
-- that closing it needed this table.
--
-- One row per qualifying engagement, keyed on the local workday it credited and
-- pointing at the `BrainDumpItem` whose existence is the evidence for it. The
-- question then has an answer at the table grain: a day still counts while any
-- row survives for it. The long-form reasoning — including why this is a new
-- table rather than a nullable column on "RewardEvent" — is in the model's
-- docblock in prisma/schema.prisma and in `EngagementKind` in
-- src/lib/constants.ts.
--
-- ── Why the schema and the backfill are two files ──────────────────────────
--
-- #180 is the precedent that makes this non-negotiable: on 2026-08-07 a data
-- migration failed in production (SQLSTATE 23514) and Prisma then refused every
-- later migration behind P3009, so a single bad statement cost two days of
-- deploys rather than one rollback. Splitting them means a backfill that fails on
-- somebody's data leaves this table CREATED and correct — the application code is
-- already written to treat an empty ledger as "no engagement recorded yet", which
-- is safe — instead of stranding the schema change behind it. One failure, one
-- thing to fix, and the recovery is to re-run one file.
--
-- ── Safe on a populated database, and every clause is checked ──────────────
--
--   * "EngagementDay" is CREATEd here, so it provably starts empty: no index and
--     no constraint on it can meet a row that violates it. `migration-data-
--     harness.ts` treats a table created by the same migration as empty for
--     exactly this reason, and that is a proof rather than an assumption.
--   * The CHECK on "kind" is added to that same new, empty table.
--   * `ADD COLUMN "ledgerFrom" … NOT NULL DEFAULT CURRENT_TIMESTAMP` carries its
--     default IN THE SAME CLAUSE, which is what makes it safe: Postgres writes
--     the default into every existing row rather than NULL and then rejecting it.
--     A `NOT NULL` without a default is the shape that cannot succeed at all on a
--     populated table, and `find-data-dependent-statements` classifies it.
--   * NO `CREATE INDEX CONCURRENTLY`. Prisma wraps every migration file in a
--     transaction and Postgres refuses it there (SQLSTATE 25001) — measured on
--     this schema for #245, and recorded in
--     20260811120000_step_task_order_unique. A plain `CREATE INDEX` on a table
--     created two statements earlier locks nothing that exists.
--
-- Re-running this file is a no-op that cannot fail halfway: every statement is
-- `IF NOT EXISTS`-guarded or creates something new, and Prisma's per-file
-- transaction means a failure leaves nothing behind.

-- CreateTable
CREATE TABLE IF NOT EXISTS "EngagementDay" (
    "id" TEXT NOT NULL,
    -- The local workday credited, YYYY-MM-DD. Same key and same `ymd()`
    -- derivation as "Streak"."lastActiveWorkday", so the two compare directly.
    "day" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    -- NULL means "the evidence for this credit is not an item", which makes the
    -- row permanent. See the model docblock: it is what the backfill writes,
    -- because "RewardEvent" holds no item reference, and it is the conservative
    -- direction — an unattributed row can only ever PREVENT a revocation.
    "itemId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "workspaceId" TEXT NOT NULL,

    CONSTRAINT "EngagementDay_pkey" PRIMARY KEY ("id")
);

-- The recompute's read shape: the distinct days of one workspace.
CREATE INDEX IF NOT EXISTS "EngagementDay_workspaceId_day_idx" ON "EngagementDay"("workspaceId", "day");

-- The delete path's read shape: which days one item credited. Postgres does not
-- index a foreign key automatically, and without this the CASCADE below is a
-- sequential scan of this table on every item delete.
CREATE INDEX IF NOT EXISTS "EngagementDay_itemId_idx" ON "EngagementDay"("itemId");

-- ON DELETE CASCADE from "BrainDumpItem" is the mechanism, not a cleanup detail:
-- deleting a to-do is what withdraws the engagement credits that to-do supplied.
-- `deleteBrainDumpItem` reads the days first so it can ask which of them lost
-- their LAST row.
--
-- Deliberately NOT `SET NULL`: that would convert an attributed credit into a
-- permanent one at the exact moment its evidence was destroyed, which is the
-- opposite of what this table is for.
ALTER TABLE "EngagementDay" ADD CONSTRAINT "EngagementDay_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "BrainDumpItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "EngagementDay" ADD CONSTRAINT "EngagementDay_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Mirrors `EngagementKind` in src/lib/constants.ts. Prisma cannot express a
-- CHECK, so the constraint is registered in
-- src/lib/enum-constraint-sync.integration.test.ts, which fails if either side
-- gains or loses a value without the other.
--
-- This is NOT the same value set as "RewardEvent_type_check", and that is the
-- point rather than an oversight — `capture` earns a streak day and no points, so
-- it has no reward type, while `inbox_zero`, `scheduled` and `session_finished`
-- are rewards that never advance the streak.
ALTER TABLE "EngagementDay"
  ADD CONSTRAINT "EngagementDay_kind_check"
  CHECK ("kind" IN ('capture', 'breakdown_confirmed', 'step_done', 'task_complete'));

-- ── "Streak"."ledgerFrom" — the instant this ledger became complete ────────
--
-- It is what makes "this day has no ledger row" mean "nothing happened" rather
-- than "the ledger was not keeping records yet". The recompute refuses to act on
-- any run that begins before it, so a badge earned off pre-ledger history is
-- never revoked on evidence that does not exist.
--
-- An INSTANT and not a YYYY-MM-DD day, deliberately. Comparing a day's local
-- midnight against an instant is a JS comparison using the same `ymd()` and
-- `Date` the rest of the streak already uses. A day string would instead require
-- this file's SQL to agree with the application process about which timezone
-- "today" is in — "createdAt" is `TIMESTAMP(3)` with no zone, and the app derives
-- its day from local `Date` getters, so there is no expression here that is
-- guaranteed to match. Storing the instant moves the only timezone-sensitive
-- comparison into the one place that knows the answer.
--
-- `DEFAULT CURRENT_TIMESTAMP` rather than a nullable column: every existing row
-- is stamped with the instant this migration ran, and a "Streak" row created
-- later is stamped when it is created. A workspace with no "Streak" row has never
-- recorded an engagement — `touchStreakOnEngagement` creates the row before it
-- touches anything — so starting a fresh workspace's coverage at its creation
-- misses nothing.
ALTER TABLE "Streak" ADD COLUMN IF NOT EXISTS "ledgerFrom" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
