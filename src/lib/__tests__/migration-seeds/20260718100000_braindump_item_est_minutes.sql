-- #190 — an inbox item carrying the estimate that
-- `20260731120000_braindump_item_est_minutes_check` has to repair.
--
-- `estMinutes` is added by the migration this seed is named for, so the value
-- cannot be written any earlier: a seed lives at the oldest schema version that
-- can express it, and no earlier.
--
-- 0 is the value the repair UPDATE rewrites to 1 before the CHECK
-- (`IS NULL OR >= 1`) is added. Without a row below the floor that migration is
-- an UPDATE matching nothing followed by a constraint over nothing — green, and
-- blind to a repair clause that had the comparison the wrong way round.
--
-- `workspaceId` is required from `20260706130912_workspaces` onwards and 'owner'
-- is the workspace that migration creates. `taskId` is deliberately NULL: this
-- item exists for its estimate, and pointing it at the seeded task would give
-- that task a second reason to survive `cleanup_orphaned_tasks`, weakening the
-- one assertion that proves the first reason works.
INSERT INTO "BrainDumpItem" ("id", "text", "status", "workspaceId", "estMinutes")
VALUES ('seed-inbox-2', 'water the plants', 'inbox', 'owner', 0);
