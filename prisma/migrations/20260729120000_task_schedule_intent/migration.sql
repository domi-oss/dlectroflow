-- #106 — the Schedule menu's three fields, persisted so re-opening the menu
-- prefills instead of asking again.
--
-- All three are nullable and default NULL: a task that has never been scheduled
-- through the menu has no intent, and `defaultIntentFor()` supplies the
-- fallback (3 days out, high, work). That is deliberately NOT a column default
-- — a column default would freeze "3 days from the migration date", and it
-- would also make "the owner chose this" indistinguishable from "nobody has
-- said", which is exactly the distinction prefill needs.
--
-- The two pseudo-enum columns get CHECK constraints mirroring
-- src/lib/scheduling/types.ts, following the #38 pattern and registered in
-- src/lib/enum-constraint-sync.integration.test.ts so dropping one out of band
-- fails the suite. Behavioural proof lives in
-- src/lib/task-schedule-intent-check.integration.test.ts.
--
-- No repair statement is needed here, unlike the Step.estMinutes constraint
-- (20260727194512_step_est_minutes_check): these columns do not exist yet, so
-- every existing row gets NULL, and NULL satisfies both constraints. If a later
-- migration ever widens or narrows the allowed values, THAT migration needs a
-- repair pass before it enforces, or `prisma migrate deploy` can wedge a
-- release halfway.

ALTER TABLE "Task" ADD COLUMN "scheduleDueAt" TIMESTAMP(3);
ALTER TABLE "Task" ADD COLUMN "schedulePriority" TEXT;
ALTER TABLE "Task" ADD COLUMN "scheduleHours" TEXT;

-- Task.schedulePriority ← SchedulePriority (critical | high | normal | low)
ALTER TABLE "Task"
  ADD CONSTRAINT "Task_schedulePriority_check"
  CHECK ("schedulePriority" IS NULL OR "schedulePriority" IN ('critical', 'high', 'normal', 'low'));

-- Task.scheduleHours ← ScheduleHours (work | personal)
ALTER TABLE "Task"
  ADD CONSTRAINT "Task_scheduleHours_check"
  CHECK ("scheduleHours" IS NULL OR "scheduleHours" IN ('work', 'personal'));
