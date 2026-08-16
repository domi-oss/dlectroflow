-- #233 — rows for the engagement-ledger backfill to meet, so it is exercised
-- against data rather than only parsed.
--
-- Seeded after the last migration BEFORE `20260815120100_engagement_day_backfill`,
-- which is what puts these rows in the tables its two `INSERT … SELECT` statements
-- read.
--
-- ## Why this file matters more than a seed usually does
--
-- A backfill is the mirror image of the five shapes #190's harness was built for.
-- Those FAIL on data the author did not expect; an `INSERT … SELECT` over an empty
-- source **cannot fail** — it silently writes nothing and reports success. Until
-- #233 the classifier did not look at that shape at all, so a backfill could have
-- reached production having only ever been proved to parse. That is the 2026-08-07
-- incident's structural property, not a variant of it: "the defect was not missed;
-- it was structurally incapable of failing anywhere except production."
--
-- ## The cases, and what each one is for
--
-- Two workspaces, because the backfill is workspace-scoped by construction (it
-- carries `workspaceId` through from the source row) and a single-workspace seed
-- cannot show that a day belonging to A did not become a day belonging to B.
--
-- `seed-ledger-ws-a`
--   * THREE inbox items across TWO days — two of them on 2026-08-01. The
--     `SELECT DISTINCT` has to collapse those two into one row, because the
--     ledger's question is membership ("did this day hold an engagement") and not
--     arithmetic. A backfill written without `DISTINCT` produces two identical
--     credits for one day; harmless to the reader, and a silent doubling of a
--     table that is meant to be a set.
--   * `step_done` AND `task_complete` on the SAME day (2026-08-01). Two DIFFERENT
--     kinds on one day must both be recorded: the `DISTINCT` is over
--     `(day, kind, workspace)`, so collapsing on day alone would lose one, and
--     `kind` is what makes the ledger readable by a human afterwards.
--   * `breakdown_confirmed` on a day with no capture and no completion
--     (2026-08-03), so a day whose ONLY evidence is a reward row is covered. This
--     is the case that proves the second statement is not merely duplicating what
--     the first one found.
--   * ⚠️ THE NEGATIVE CONTROL: `inbox_zero`, `scheduled` and `session_finished`,
--     all on 2026-08-05, a day with no other evidence at all. None of the three
--     calls `touchStreakOnEngagement`, so **none may produce a ledger row** and
--     2026-08-05 must not appear. Without this, a backfill that copied every
--     reward type would look exactly like one that copied the right three, and it
--     would credit streak days the app never counted — putting the ledger
--     permanently at odds with `Streak.current` on data neither side can recheck.
--
-- `seed-ledger-ws-b`
--   * One capture on a day workspace A also has (2026-08-01) and one on a day it
--     does not (2026-08-09). The first is what would break if the `DISTINCT`
--     dropped `workspaceId`; the second is a day that must exist for B and not
--     for A.
--
-- A `Streak` row for each, so the third statement — the coverage boundary — meets
-- rows too. It cannot set `ledgerFrom` here: that column does not exist at this
-- schema version, which is exactly the property tying a seed to its migration.
--
-- Timestamps are explicit UTC middays. `to_char("createdAt", 'YYYY-MM-DD')` reads
-- the UTC day, so a value at midday cannot bucket to an adjacent day whatever the
-- test runner's timezone — which keeps the assertions in
-- `migration-data-harness.integration.test.ts` about the backfill rather than
-- about the clock.

INSERT INTO "Workspace" ("id", "kind", "createdAt", "lastSeenAt")
VALUES ('seed-ledger-ws-a', 'user', '2026-08-01 09:00:00', '2026-08-01 09:00:00'),
       ('seed-ledger-ws-b', 'user', '2026-08-01 09:00:00', '2026-08-01 09:00:00');

-- Two captures on 2026-08-01 (DISTINCT must collapse them) and one on 2026-08-02.
INSERT INTO "BrainDumpItem" ("id", "text", "createdAt", "status", "workspaceId")
VALUES ('seed-ledger-item-1', 'first thought',  '2026-08-01 12:00:00', 'inbox', 'seed-ledger-ws-a'),
       ('seed-ledger-item-2', 'second thought', '2026-08-01 15:30:00', 'inbox', 'seed-ledger-ws-a'),
       ('seed-ledger-item-3', 'next day',       '2026-08-02 12:00:00', 'inbox', 'seed-ledger-ws-a'),
       ('seed-ledger-item-4', 'b: shared day',  '2026-08-01 12:00:00', 'inbox', 'seed-ledger-ws-b'),
       ('seed-ledger-item-5', 'b: own day',     '2026-08-09 12:00:00', 'inbox', 'seed-ledger-ws-b');

-- The three reward types that ARE engagements, plus the three that are not.
INSERT INTO "RewardEvent" ("id", "type", "points", "createdAt", "workspaceId")
VALUES ('seed-ledger-rw-1', 'step_done',           10, '2026-08-01 13:00:00', 'seed-ledger-ws-a'),
       ('seed-ledger-rw-2', 'step_done',           10, '2026-08-01 13:05:00', 'seed-ledger-ws-a'),
       ('seed-ledger-rw-3', 'task_complete',       25, '2026-08-01 13:10:00', 'seed-ledger-ws-a'),
       ('seed-ledger-rw-4', 'breakdown_confirmed', 10, '2026-08-03 12:00:00', 'seed-ledger-ws-a'),
       -- The negative control: 2026-08-05 must not become an engagement day.
       ('seed-ledger-rw-5', 'inbox_zero',          15, '2026-08-05 12:00:00', 'seed-ledger-ws-a'),
       ('seed-ledger-rw-6', 'scheduled',           10, '2026-08-05 12:05:00', 'seed-ledger-ws-a'),
       ('seed-ledger-rw-7', 'session_finished',     5, '2026-08-05 12:10:00', 'seed-ledger-ws-a');

INSERT INTO "Streak" ("id", "current", "lastActiveWorkday", "workspaceId")
VALUES ('seed-ledger-streak-a', 3, '2026-08-03', 'seed-ledger-ws-a'),
       ('seed-ledger-streak-b', 1, '2026-08-09', 'seed-ledger-ws-b');
