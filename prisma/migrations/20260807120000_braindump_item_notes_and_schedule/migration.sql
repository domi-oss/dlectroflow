-- #186 / #179 — `BrainDumpItem` gains the four columns `Task` already had, so
-- an UNTRIAGED item can hold a note and a deadline.
--
-- ONE migration over one table, for two issues, deliberately. #186 wants the
-- note affordance and the full Schedule menu on any item row; #179 wants a
-- capture's trailing `{…}` group split into a note at capture time. Both are
-- the same data gap — `BrainDumpItem` carried neither `notes` nor the three
-- #106 intent columns — and two migrations over one table would have been two
-- things to read together to understand either, plus a real chance of two
-- writers racing the same `ALTER TABLE`.
--
-- ── Why the gap existed, and why closing it is not a UI change ──────────────
--
-- Both affordances were previously declined, and both declines were CORRECT at
-- the time:
--
--   * A single-task item only ever got the 15/30/60 duration presets, because
--     there was nowhere to persist a deadline. The presets stay — the .ics path
--     genuinely needs a DURATION rather than a deadline — but they are no
--     longer the only thing on offer.
--   * `!270` deliberately put no note affordance on the Needs-review row: an
--     untriaged item has no `Task` row, so `TaskNoteRow` would render as
--     nothing on every row that bucket can hold.
--
-- Neither was an omission. Both are this one gap, which is why the fix is a
-- column and not a component.
--
-- ── NO column defaults, on any of the four ─────────────────────────────────
--
-- The same decision `20260729120000_task_schedule_intent` recorded for `Task`,
-- and it is load-bearing rather than stylistic. A default on `scheduleDueAt`
-- would freeze "N days from the migration date" into every existing row. Worse,
-- ANY default makes "the owner chose this" indistinguishable from "nobody has
-- said yet" — and that distinction is exactly what prefill reads
-- (`mergePersistedIntent` in src/lib/scheduling/intent.ts falls back to
-- `defaultIntentFor` per FIELD, on NULL).
--
-- `notes` carries the same argument in its own vocabulary: NULL means "nobody
-- has written a note", and the note is composed into a scheduled artifact only
-- when present, so an empty string standing in for absence would put a blank
-- line in somebody's calendar entry. `normalizeTaskNote` (src/lib/task-notes.ts)
-- folds "" and whitespace-only back to NULL for that reason, and this grain
-- reuses it rather than declaring a second normaliser.
--
-- ── THE NOTES BOUND: 2000 CHARACTERS, and it is inherited, not chosen ───────
--
-- Identical to `Task_notes_check` / `Step_notes_check`
-- (20260805120000_task_and_step_notes), because an item's note is COPIED into
-- `Task.notes` the moment triage creates the task (`brainDumpItemToTaskData`,
-- src/lib/braindump-to-task.ts). A wider bound here would be a value the
-- narrower column then refuses on a routine action, which is a failure at
-- triage time on a surface with no way to explain itself — the same shape of
-- deferred failure the Google Tasks 8192-character cap already argues against.
--
-- `char_length`, NOT `octet_length`, for the reason the #44 migration states:
-- octets would reject an all-emoji note a quarter the length of a Latin one the
-- constraint accepts, for no reason a user could infer. This grain makes that
-- more than theoretical — #179 writes the column with NO field, no counter and
-- no `maxLength` in front of it, so `normalizeTaskNote`'s code-point clamp and
-- this constraint are the only two things measuring, and they have to measure
-- the same thing.
--
-- ── Traceability ───────────────────────────────────────────────────────────
--
-- Prisma cannot express a CHECK, so this file plus the field comments in
-- schema.prisma are the constraints' only trace in the schema. All three are
-- registered in src/lib/enum-constraint-sync.integration.test.ts — the two
-- pseudo-enums in REGISTRY, the length bound in LENGTH_REGISTRY — so dropping
-- one out of band fails the suite. The behavioural half (that Postgres really
-- rejects an over-long value at this grain too) is
-- src/lib/notes-length-check.integration.test.ts.
--
-- No repair statement is needed: none of the four columns exists yet, so every
-- existing row gets NULL and NULL satisfies all three constraints. A later
-- migration that NARROWS the notes bound or removes a pseudo-enum value would
-- need a repair pass BEFORE it enforces, or `prisma migrate deploy` can wedge a
-- release halfway.

ALTER TABLE "BrainDumpItem" ADD COLUMN "notes" TEXT;
ALTER TABLE "BrainDumpItem" ADD COLUMN "scheduleDueAt" TIMESTAMP(3);
ALTER TABLE "BrainDumpItem" ADD COLUMN "schedulePriority" TEXT;
ALTER TABLE "BrainDumpItem" ADD COLUMN "scheduleHours" TEXT;

ALTER TABLE "BrainDumpItem"
  ADD CONSTRAINT "BrainDumpItem_notes_check"
  CHECK ("notes" IS NULL OR char_length("notes") <= 2000);

-- BrainDumpItem.schedulePriority ← SchedulePriority (critical | high | normal | low)
ALTER TABLE "BrainDumpItem"
  ADD CONSTRAINT "BrainDumpItem_schedulePriority_check"
  CHECK ("schedulePriority" IS NULL OR "schedulePriority" IN ('critical', 'high', 'normal', 'low'));

-- BrainDumpItem.scheduleHours ← ScheduleHours (work | personal)
ALTER TABLE "BrainDumpItem"
  ADD CONSTRAINT "BrainDumpItem_scheduleHours_check"
  CHECK ("scheduleHours" IS NULL OR "scheduleHours" IN ('work', 'personal'));
