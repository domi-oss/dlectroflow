-- Workspace-scoped models: orphan-safe cascade FKs.
--
-- SAFETY ORDER (per table): delete any orphaned rows (workspaceId pointing at
-- a Workspace that no longer exists — e.g. left over from the pre-cascade
-- hand-coded purgeWorkspace) BEFORE adding the FK constraint. Adding a FK
-- constraint against data containing orphans would fail the migration outright;
-- deleting first makes this migration safe to run against current prod data.
--
-- None of these 10 tables had a workspaceId FK constraint before this
-- migration (confirmed via prior migration history) — every ADD CONSTRAINT
-- below is a pure addition, no DROP CONSTRAINT needed first.
--
-- Step_taskId_fkey and BreakdownTurn_taskId_fkey were already
-- ON DELETE CASCADE ON UPDATE CASCADE as of the initial migration
-- (20260703150450_init) — verified, no change needed. They cascade
-- transitively once their parent Task row is removed by the Task FK below.

-- Settings (one-to-one; workspaceId @unique)
DELETE FROM "Settings" WHERE "workspaceId" NOT IN (SELECT "id" FROM "Workspace");
ALTER TABLE "Settings" ADD CONSTRAINT "Settings_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- BrainDumpItem
DELETE FROM "BrainDumpItem" WHERE "workspaceId" NOT IN (SELECT "id" FROM "Workspace");
ALTER TABLE "BrainDumpItem" ADD CONSTRAINT "BrainDumpItem_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Task (Step/BreakdownTurn cascade transitively via their existing taskId FK)
DELETE FROM "Task" WHERE "workspaceId" NOT IN (SELECT "id" FROM "Workspace");
ALTER TABLE "Task" ADD CONSTRAINT "Task_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- FocusSession
DELETE FROM "FocusSession" WHERE "workspaceId" NOT IN (SELECT "id" FROM "Workspace");
ALTER TABLE "FocusSession" ADD CONSTRAINT "FocusSession_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- DayRollup
DELETE FROM "DayRollup" WHERE "workspaceId" NOT IN (SELECT "id" FROM "Workspace");
ALTER TABLE "DayRollup" ADD CONSTRAINT "DayRollup_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- RewardEvent
DELETE FROM "RewardEvent" WHERE "workspaceId" NOT IN (SELECT "id" FROM "Workspace");
ALTER TABLE "RewardEvent" ADD CONSTRAINT "RewardEvent_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Streak (one-to-one; workspaceId @unique)
DELETE FROM "Streak" WHERE "workspaceId" NOT IN (SELECT "id" FROM "Workspace");
ALTER TABLE "Streak" ADD CONSTRAINT "Streak_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- StreakRecord
DELETE FROM "StreakRecord" WHERE "workspaceId" NOT IN (SELECT "id" FROM "Workspace");
ALTER TABLE "StreakRecord" ADD CONSTRAINT "StreakRecord_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Badge
DELETE FROM "Badge" WHERE "workspaceId" NOT IN (SELECT "id" FROM "Workspace");
ALTER TABLE "Badge" ADD CONSTRAINT "Badge_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- DailySpark
DELETE FROM "DailySpark" WHERE "workspaceId" NOT IN (SELECT "id" FROM "Workspace");
ALTER TABLE "DailySpark" ADD CONSTRAINT "DailySpark_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
