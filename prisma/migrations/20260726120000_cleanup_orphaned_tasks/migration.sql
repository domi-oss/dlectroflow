-- #64 one-off production-data cleanup: delete pre-existing orphaned Tasks.
--
-- Root cause (fixed going forward by this same MR): deleteBrainDumpItem
-- deleted only the BrainDumpItem row, never its linked Task, so a Task whose
-- last referencing BrainDumpItem was deleted became a permanent orphan — it
-- kept surfacing forever in the Focus launcher (which reads Task directly,
-- no existence check) while being structurally invisible in the Library
-- (whose only source query is BrainDumpItem). Any orphan created by that
-- defect before this migration runs will NOT self-heal from the code fix
-- alone, since the code fix only prevents *new* orphans.
--
-- This statement deletes every Task with zero referencing BrainDumpItem rows
-- (a "true" orphan — already permanently invisible/unusable from the
-- Library's point of view, so nothing user-visible is lost by removing it).
-- Step_taskId_fkey and BreakdownTurn_taskId_fkey are already ON DELETE
-- CASCADE (confirmed in 20260718180000_workspace_cascade_fks), so each
-- orphan's Steps/BreakdownTurns are removed for free. FocusSession.taskId is
-- a plain column with no FK (only FocusSession.stepId is a real relation, and
-- it's ON DELETE SET NULL), so any FocusSession history for an orphan's Steps
-- survives, detached, exactly as it already does for any other deleted Step —
-- no change in behavior there.
--
-- Idempotent: matches zero rows on any re-run (once an orphan is deleted it
-- can't reappear), and a no-op if no orphans exist.
DELETE FROM "Task" t
WHERE NOT EXISTS (
  SELECT 1 FROM "BrainDumpItem" b WHERE b."taskId" = t."id"
);
