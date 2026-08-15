-- #233 — backfill the per-day engagement ledger from rows that already exist.
--
-- DATA ONLY. The table, the indexes, the CHECK and "Streak"."ledgerFrom" are the
-- previous migration's, split for #180's reason: a data migration that fails
-- wedges every later one behind P3009, so a failure here has to leave the schema
-- change intact rather than stranded behind it.
--
-- ── What can be proved, and what cannot ────────────────────────────────────
--
-- The ledger's purpose is to answer "did this day still have an engagement after
-- that item was deleted". Answering it needs the day AND the item, and only one
-- of the two survives in the old data:
--
--   * "BrainDumpItem"."createdAt" dates a capture, and the item is right there.
--   * "RewardEvent" dates a step completion, a task completion and a
--     breakdown-confirm — but it carries type, points and workspace and NO item
--     or step reference at all (see prisma/schema.prisma). The engagement is
--     datable and NOT attributable.
--
-- So every row written here is UNATTRIBUTED ("itemId" IS NULL), the capture rows
-- included, and that is a deliberate choice rather than a limitation accepted.
-- An unattributed row is permanent: nothing cascades it away, so a pre-migration
-- day can never lose its last credit and can never trigger a revocation.
--
-- **Attributing the captures would have been the unsafe half.** A day whose only
-- other engagement was a step completion later reversed by a reopen leaves no
-- trace at all, so that day would read as "supported only by this capture" — and
-- deleting the capture would empty a day that really did have other work in it,
-- shortening a run and revoking a badge somebody earned. Unattributed rows can
-- only ever PREVENT a revocation, which is the direction to be wrong in.
--
-- ── Which reward types, and why not all six ────────────────────────────────
--
-- Exactly the three that call `touchStreakOnEngagement`. `inbox_zero`,
-- `scheduled` and `session_finished` are rewards that never advance the streak,
-- so a row for one of them would credit a day the streak did not count — the
-- ledger would then disagree with `Streak.current` on data neither side can
-- recheck. `EngagementKind` in src/lib/constants.ts is the authority and is
-- CHECK-constrained, so a wrong value here fails loudly rather than silently.
--
-- ── The day bucketing, and its one soft edge ───────────────────────────────
--
-- `to_char("createdAt", 'YYYY-MM-DD')` reads the UTC day, because "createdAt" is
-- `TIMESTAMP(3)` with no zone. The application derives its day from LOCAL `Date`
-- getters, so on a deployment whose process timezone is not UTC a row can land on
-- an adjacent day.
--
-- That is harmless HERE and it is worth being precise about why, because the same
-- imprecision would not be acceptable in the application code. Every row this
-- file writes is dated at or before `now()`, and "ledgerFrom" below is set to the
-- start of the day after tomorrow — so every backfilled day is strictly before
-- the coverage boundary, and `runIsFullyLedgered` only ever trusts a run that
-- begins at or after it. A trusted run therefore contains NO backfilled day, and
-- a ±1 day error in these rows cannot shorten one. What such an error can do is
-- make a PRE-coverage run look longer or make an extra pre-coverage day appear,
-- both of which keep a badge.
--
-- ── Idempotent, and what each guard actually checks (raised in review) ─────
--
-- A second run writes nothing. That is sound rather than optimistic because
-- Prisma wraps every migration file in one transaction: a failure part-way rolls
-- back both inserts, leaving the table empty again, so "empty" cannot mean "half
-- done". The `ledgerFrom` write is scoped to rows still carrying the previous
-- migration's default instant, so a re-run cannot push a workspace's coverage
-- boundary forward and un-trust runs that had become trustworthy.
--
-- The two inserts are NOT guarded on the same condition, and the difference is
-- forced rather than an oversight. Statement 1 checks that the ledger is empty.
-- Statement 2 CANNOT: it runs after statement 1 in the same transaction, so it
-- sees statement 1's own capture rows, and a
-- `NOT EXISTS (SELECT 1 FROM "EngagementDay")` guard there would skip itself on
-- any database holding a single "BrainDumpItem" — silently writing none of the
-- reward days. That is measured rather than predicted: making exactly that
-- change reds `backfills the engagement ledger …` in
-- src/lib/migration-data-harness.integration.test.ts with all three reward kinds
-- absent, which is #180's failure shape in one line — an `INSERT … SELECT` that
-- writes nothing and reports success. So statement 2 is guarded on the absence
-- of its OWN output instead (`kind <> 'capture'`).
--
-- The residual that wording hid, and its direction: statement 2's guard does not
-- latch for a workspace whose ledger only ever holds capture rows, so a MANUAL
-- re-run of this file (`psql -f`, outside Prisma's tracking, which never re-runs
-- an applied migration) would re-execute it there. What that can do is
-- re-create a permanent unattributed credit for a day whose attributed row had
-- since been cascaded away by an item delete — so it can only ever KEEP a badge,
-- never revoke one, the direction this file argues for being wrong in
-- throughout. It cannot double-count either: the recompute reads a SET of days
-- (`engagementDays` in src/lib/engagement-ledger.ts), so a second row for a day
-- that already counts changes no answer.
--
-- Exercised against SEEDED rows by src/lib/migration-data-harness.integration.test.ts
-- — an empty-table run of this file proves only that it parses, which is #180 in
-- one sentence. The classifier now reports this statement shape, so the coverage
-- gate can see it at all: `INSERT … SELECT` cannot FAIL on an empty source, it
-- silently writes nothing, and until #233 nothing in the harness looked at it.

-- 1. Captures. One row per (workspace, day) — `DISTINCT` because a person can
--    capture ten things on one day and the ledger's question is membership.
INSERT INTO "EngagementDay" ("id", "day", "kind", "itemId", "createdAt", "workspaceId")
SELECT gen_random_uuid()::text,
       d.day,
       'capture',
       NULL,
       now(),
       d."workspaceId"
  FROM (
    SELECT DISTINCT to_char(i."createdAt", 'YYYY-MM-DD') AS day, i."workspaceId"
      FROM "BrainDumpItem" i
  ) AS d
 WHERE NOT EXISTS (SELECT 1 FROM "EngagementDay");

-- 2. The three reward types that ARE engagements. `kind` is copied from `type`
--    rather than mapped, because for these three the two vocabularies use the
--    same three strings — and the CHECK constraint added by the previous
--    migration is what makes that safe to rely on instead of asserting.
INSERT INTO "EngagementDay" ("id", "day", "kind", "itemId", "createdAt", "workspaceId")
SELECT gen_random_uuid()::text,
       d.day,
       d.kind,
       NULL,
       now(),
       d."workspaceId"
  FROM (
    SELECT DISTINCT to_char(r."createdAt", 'YYYY-MM-DD') AS day,
                    r."type" AS kind,
                    r."workspaceId"
      FROM "RewardEvent" r
     WHERE r."type" IN ('step_done', 'task_complete', 'breakdown_confirmed')
  ) AS d
 WHERE NOT EXISTS (
   SELECT 1 FROM "EngagementDay" WHERE "kind" <> 'capture'
 );

-- 3. The coverage boundary.
--
-- The previous migration's `DEFAULT CURRENT_TIMESTAMP` stamped every existing row
-- with the instant the SCHEMA landed, which is slightly too early: migrations run
-- at container start, and during a rolling update the OLD pods keep serving for a
-- few more minutes and write no ledger rows at all.
--
-- Moving it to the start of the day AFTER TOMORROW gives at least 24 hours of
-- slack past any rollout, which also absorbs the timezone gap between
-- `date_trunc` here and `ymd()` in the app (at most 14 hours). The cost is that
-- streak-badge revocation goes live about two days after deploy instead of one,
-- for runs that BEGIN after that point — a delay on a feature about multi-day
-- streaks, in exchange for never revoking on a day the ledger only partly saw.
--
-- Scoped to rows that still carry the previous migration's default, identified by
-- `ledgerFrom < date_trunc('day', now()) + interval '2 days'`, so a hand-set or
-- already-advanced boundary is left alone and a re-run is a no-op.
UPDATE "Streak"
   SET "ledgerFrom" = date_trunc('day', now()) + interval '2 days'
 WHERE "ledgerFrom" < date_trunc('day', now()) + interval '2 days';
