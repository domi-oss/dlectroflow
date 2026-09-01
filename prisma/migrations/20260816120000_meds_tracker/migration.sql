-- #269 — the medication tracker: three tables, two Settings columns and two
-- CHECK constraints.
--
-- ── Nothing here writes a row, and that is deliberate ──────────────────────
--
-- The 2026-08-07 outage (P3009) was a data migration exercised only against
-- empty tables — zero rows updated means no constraint is ever evaluated, so the
-- defect was structurally incapable of failing anywhere except production. Every
-- statement below is metadata:
--
--  * the three CREATE TABLEs provably start empty, which is why
--    src/lib/migration-data-harness.ts classifies a table created by the same
--    migration as not data-dependent;
--  * both ADD COLUMNs carry a non-volatile DEFAULT, which since PostgreSQL 11 is
--    stored in pg_attribute (attmissingval) and materialised lazily, so neither
--    rewrites "Settings" nor holds a lock for the length of one;
--  * "MedsDoseLog_state_check" guards a table this migration created, so it
--    validates zero rows;
--  * "Settings_medsNavMode_check" is the ONE statement whose outcome depends on
--    stored rows — ADD CONSTRAINT re-validates every existing "Settings" row. It
--    is written AFTER the ADD COLUMN that gives every one of them 'dots', which
--    is the value it permits, and the seeded-deploy harness
--    (src/lib/migration-data-harness.integration.test.ts) runs it against
--    populated "Settings" rows rather than an empty table. It is also the one
--    statement whose duration grows with the table — see the lock note below it.
--
-- ── Two CHECK constraints, and they need OPPOSITE arguments ────────────────
--
-- The convention (pseudo-enum -> CHECK, named "<Table>_<column>_check") is
-- dominant but NOT unanimous: Settings.voice is a closed two-value set with no
-- constraint. So each of these is argued rather than asserted.
--
--  * "state" is not negotiable, and the discriminator is what an out-of-set
--    value costs. An unrecognised `voice` degrades to the default register and
--    the reader sees plainer copy. An unrecognised `state` has NO SAFE READING:
--    the strip would have to decide whether it means a dose was taken, and both
--    answers are wrong about a health record.
--  * "medsNavMode" DOES have a safe reading — fall back to the default mode — so
--    the argument above does not reach it, and citing it for both would be this
--    file contradicting itself. It carries one on the plain dominant-convention
--    ground: its two nearest analogues are appearance columns that both have safe
--    readings and both carry one anyway (Settings_typeface_check,
--    Settings_focusTimerStyle_check).
--
-- ⚠️ Both are registered in src/lib/enum-constraint-sync.integration.test.ts, and
-- registering them is a REVIEW obligation rather than a mechanical one: that
-- test's "no missing, no strays" assertion intersects the live constraint list
-- with the registry's own names BEFORE comparing, so an applied-but-unregistered
-- constraint is filtered out and the test passes. The filter is deliberate (the
-- range and length constraints live in sibling registries and would otherwise
-- read as strays); what it means here is that nothing would have told us. The
-- behavioural half — that each constraint actually BITES — is asserted through
-- raw SQL in the identity-rejection block of that same file.
--
-- Prisma cannot express a CHECK, so this file plus the schema comments are the
-- constraints' only trace in prisma/schema.prisma.

-- ── Medication ─────────────────────────────────────────────────────────────
CREATE TABLE "Medication" (
    "id"          TEXT         NOT NULL,
    "workspaceId" TEXT         NOT NULL,
    "name"        TEXT         NOT NULL,
    -- NULL inherits Settings.workingDays; a value is this medication's own ISO
    -- weekday CSV. No CHECK: Settings.workingDays is the same shape and has
    -- none, and a CHECK cannot express the list without a regex that will be
    -- wrong about whitespace. parseWorkingDays filters to 1..7 on read, so a
    -- hand-edited value degrades to "no days" rather than to a wrong week.
    "days"        TEXT,
    -- Deactivate, never delete: the FK on "MedsDoseLog" below cascades, so
    -- deleting a medication destroys the history v2 cannot backfill.
    "active"      BOOLEAN      NOT NULL DEFAULT true,
    "order"       INTEGER      NOT NULL,
    "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Medication_pkey" PRIMARY KEY ("id")
);

-- Cascade, matching every other workspace-owned table: deleting an account
-- destroys its content in one step (20260718180000_workspace_cascade_fks).
ALTER TABLE "Medication"
  ADD CONSTRAINT "Medication_workspaceId_fkey"
  FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- Every read is `where: { workspaceId }` (the scoping invariant), so this is the
-- access path rather than a nicety.
CREATE INDEX "Medication_workspaceId_idx" ON "Medication"("workspaceId");

-- ── MedicationDose ─────────────────────────────────────────────────────────
-- No "workspaceId": reached only through its scoped parent as an `include`,
-- exactly as "Step" is through "Task".
CREATE TABLE "MedicationDose" (
    "id"           TEXT    NOT NULL,
    "medicationId" TEXT    NOT NULL,
    "label"        TEXT    NOT NULL,
    "quantity"     INTEGER NOT NULL,
    -- Optional HH:mm. Read by the banner and by the deadline's
    -- max(workdayEndTime, dueAfter); it schedules nothing and fires nothing.
    "dueAfter"     TEXT,
    "order"        INTEGER NOT NULL,

    CONSTRAINT "MedicationDose_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "MedicationDose"
  ADD CONSTRAINT "MedicationDose_medicationId_fkey"
  FOREIGN KEY ("medicationId") REFERENCES "Medication"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

CREATE INDEX "MedicationDose_medicationId_idx" ON "MedicationDose"("medicationId");

-- ── MedsDoseLog ────────────────────────────────────────────────────────────
CREATE TABLE "MedsDoseLog" (
    "id"               TEXT         NOT NULL,
    "workspaceId"      TEXT         NOT NULL,
    -- YYYY-MM-DD in the READER'S local time. Same shape as "DayRollup"."date"
    -- and "DailySpark"."date".
    "date"             TEXT         NOT NULL,
    "medicationDoseId" TEXT         NOT NULL,
    "state"            TEXT         NOT NULL,
    "markedAt"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MedsDoseLog_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "MedsDoseLog"
  ADD CONSTRAINT "MedsDoseLog_workspaceId_fkey"
  FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "MedsDoseLog"
  ADD CONSTRAINT "MedsDoseLog_medicationDoseId_fkey"
  FOREIGN KEY ("medicationDoseId") REFERENCES "MedicationDose"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- The idempotency key. The log write is an UPSERT on a key the client already
-- knows, so a double-tap on Taken writes ONE row — the single most likely
-- interaction on this feature, by an audience whose defining trait makes it
-- likely. Nothing in it is nullable, so this cannot repeat #257's failure, where
-- a null clientKey made the unique index treat two retries as distinct rows.
--
-- Postgres indexes a unique constraint, and the leading ("workspaceId", "date")
-- prefix is exactly the today-strip's access path, so there is deliberately no
-- second index for the read.
CREATE UNIQUE INDEX "MedsDoseLog_workspaceId_date_medicationDoseId_key"
  ON "MedsDoseLog"("workspaceId", "date", "medicationDoseId");

CREATE INDEX "MedsDoseLog_medicationDoseId_idx" ON "MedsDoseLog"("medicationDoseId");

-- Mirrors MedsDoseState in src/lib/constants.ts. NOT NULL column, so no IS NULL
-- allowance — enum-constraint-sync asserts the absence of one, because an
-- allowance appearing here would mean the column had gone nullable without the
-- registry noticing.
--
-- `missed` is deliberately NOT in this set. It is derived from the ABSENCE of a
-- row plus the clock (src/lib/meds.ts), so a stored `missed` would be a second,
-- unreachable way to say the same thing — and one a nightly job could then fail
-- to write.
ALTER TABLE "MedsDoseLog"
  ADD CONSTRAINT "MedsDoseLog_state_check"
  CHECK ("state" IN ('taken', 'skipped'));

-- ── The two Settings columns ───────────────────────────────────────────────
--
-- OFF for every existing workspace AND every new one, so there is no conversion
-- to do and no behaviour that changes for anybody who does not turn it on. The
-- ADD COLUMN default is both the backfilled value and the new-row value and they
-- are wanted to be the same, so unlike 20260806100000_settings_focus_sound_
-- categories there is no second ALTER … SET DEFAULT.
--
-- Turning it back off HIDES the strip, the banner, the nav control and the
-- editor; it deletes no "MedsDoseLog" row. That is shoppingList's doctrine and
-- it binds harder here, because a medication history destroyed by a toggle is
-- not recoverable.
--
-- Default false is also doing legal work: a workspace that has not opted in
-- genuinely has no health field, which is what lets /privacy describe an opt-in
-- rather than retract a claim.
ALTER TABLE "Settings"
  ADD COLUMN "medsTracker" BOOLEAN NOT NULL DEFAULT false;

-- 'dots' is B★, the owner's chosen default, and the column's DEFAULT is where
-- that decision lives.
ALTER TABLE "Settings"
  ADD COLUMN "medsNavMode" TEXT NOT NULL DEFAULT 'dots';

-- Mirrors MedsNavMode in src/lib/constants.ts. After the ADD COLUMN above, so
-- every existing row already holds 'dots' when this validates them.
--
-- ── One statement, and the two-statement version was measured to be ceremony ─
--
-- ⚠️ This was briefly `ADD CONSTRAINT … NOT VALID` + `VALIDATE CONSTRAINT`, on
-- the reasoning that a plain ADD holds ACCESS EXCLUSIVE across the validation
-- scan while VALIDATE takes only SHARE UPDATE EXCLUSIVE. That reasoning is right
-- about Postgres and **wrong about how this repo applies migrations**, which is
-- the only thing that matters here. Both facts were measured rather than read:
--
--   1. `prisma migrate deploy` runs each migration.sql inside ONE TRANSACTION.
--      Probed on a scratch schema with a file whose first statement is a valid
--      CREATE TABLE and whose second is invalid: after the failure the table is
--      absent, so the first statement rolled back with the second. (It is also
--      why CREATE INDEX CONCURRENTLY cannot be used in a Prisma migration.)
--   2. `ALTER TABLE "Settings" ADD COLUMN` takes ACCESS EXCLUSIVE on "Settings"
--      and, like every lock, holds it until COMMIT. Probed directly: mid-
--      transaction, pg_locks reports `AccessExclusiveLock` on "Settings" for
--      that backend.
--
-- Together those mean the ADD COLUMNs above already hold ACCESS EXCLUSIVE across
-- everything below them, so splitting the constraint changed the statement count
-- and nothing else. Getting the real benefit would need THREE separate migration
-- FILES — columns, then ADD … NOT VALID, then VALIDATE — which is a lot of
-- machinery for one CHECK, and this table does not warrant it.
--
-- ⚠️ Recorded because the split was the PREVIOUS review round's own suggestion,
-- accepted here, and refuted by the next round. A comment explaining a benefit
-- the execution model does not deliver is worse than no comment, and it is worst
-- of all on a production-risk decision — so this says what actually happens.
--
-- ## What the lock costs, then
--
-- The whole file is one ACCESS EXCLUSIVE window on "Settings". Every statement
-- in it is metadata-only except this validation scan, which is the only part
-- whose duration grows with rows. "Settings" is one row per WORKSPACE — accounts
-- plus guest sandboxes, the latter TTL-purged — so the scan is a sequential read
-- of a table bounded by workspace count, and the window is that scan plus a
-- handful of catalogue writes.
--
-- ⚠️ The production row count is still not a number this branch can measure, and
-- it is NOT asserted here. What is asserted is the shape: if that table is ever
-- large enough for this to matter, the fix is the three-file split above, and
-- this comment is where the next person should start.
ALTER TABLE "Settings"
  ADD CONSTRAINT "Settings_medsNavMode_check"
  CHECK ("medsNavMode" IN ('dots', 'next'));
