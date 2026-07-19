-- #38 — DB-level integrity for status/role/source pseudo-enum columns.
--
-- These columns are typed String in prisma/schema.prisma (Prisma enums were
-- avoided so the value sets stay trivially extensible from application code).
-- The allowed value sets live in src/lib/constants.ts and are the single
-- source of truth; the CHECK constraints below mirror them exactly and are
-- kept in sync by src/lib/enum-constraint-sync.integration.test.ts.
--
-- Project is PostgreSQL everywhere (schema.prisma provider = "postgresql"),
-- so CHECK constraints are portable across dev + prod. Nullable columns
-- (FocusSession.outcome) explicitly allow NULL.
--
-- Constraint naming: "<Table>_<column>_check". If you add/remove a value in
-- constants.ts, add a follow-up migration that DROPs + re-ADDs the matching
-- constraint, or the sync test will fail.

-- Workspace.kind ← WorkspaceKind (owner | guest)
ALTER TABLE "Workspace"
  ADD CONSTRAINT "Workspace_kind_check"
  CHECK ("kind" IN ('owner', 'guest'));

-- BrainDumpItem.status ← BrainDumpStatus (inbox | triaged | archived)
ALTER TABLE "BrainDumpItem"
  ADD CONSTRAINT "BrainDumpItem_status_check"
  CHECK ("status" IN ('inbox', 'triaged', 'archived'));

-- Task.status ← TaskStatus (active | done | archived)
ALTER TABLE "Task"
  ADD CONSTRAINT "Task_status_check"
  CHECK ("status" IN ('active', 'done', 'archived'));

-- Task.source ← TaskSource (braindump | manual)
ALTER TABLE "Task"
  ADD CONSTRAINT "Task_source_check"
  CHECK ("source" IN ('braindump', 'manual'));

-- BreakdownTurn.role ← TurnRole (user | assistant)
ALTER TABLE "BreakdownTurn"
  ADD CONSTRAINT "BreakdownTurn_role_check"
  CHECK ("role" IN ('user', 'assistant'));

-- FocusSession.outcome ← FocusOutcome (completed | requeued | gaveup); nullable
ALTER TABLE "FocusSession"
  ADD CONSTRAINT "FocusSession_outcome_check"
  CHECK ("outcome" IS NULL OR "outcome" IN ('completed', 'requeued', 'gaveup'));

-- RewardEvent.type ← RewardType
ALTER TABLE "RewardEvent"
  ADD CONSTRAINT "RewardEvent_type_check"
  CHECK ("type" IN ('step_done', 'session_finished', 'inbox_zero', 'breakdown_confirmed', 'scheduled', 'task_complete'));

-- DailySpark.source ← SparkSource (ai | fallback)
ALTER TABLE "DailySpark"
  ADD CONSTRAINT "DailySpark_source_check"
  CHECK ("source" IN ('ai', 'fallback'));

-- Badge.key ← BadgeKey
ALTER TABLE "Badge"
  ADD CONSTRAINT "Badge_key_check"
  CHECK ("key" IN ('first_breakdown', 'first_schedule', 'first_focus', 'streak_5', 'ten_steps_day', 'beat_best_streak', 'task_complete', 'inbox_zero', 'comeback'));
