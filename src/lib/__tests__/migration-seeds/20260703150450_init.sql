-- #190 — the original single-user account, as it looked the day the schema was
-- created, inserted at that schema version so the next 38 migrations have to
-- carry it forward exactly as they carried production forward.
--
-- One seed at the oldest point buys more coverage than any later one: from here
-- the rows meet the workspaces backfill and its SET NOT NULL and unique
-- indexes, the nine status CHECK constraints, the cascade foreign keys, the
-- orphaned-task cleanup and every ALTER after them. On an empty table all of
-- those are one-line schema changes that cannot fail.
--
-- ── The data is synthetic and hostile on purpose ────────────────────────────
--
-- Nothing here is copied from any real account. It is written to sit on the
-- edges the migrations reason about, because a seed of tidy defaults is a seed
-- that no migration can trip over:
--
--   * `Step.estMinutes = 0` and (later) `BrainDumpItem.estMinutes = 0` are the
--     rows that `20260727194512_step_est_minutes_check` and
--     `20260731120000_braindump_item_est_minutes_check` have to REPAIR before
--     their CHECK can be added. With no such row those two migrations are a
--     no-op UPDATE followed by a constraint on nothing.
--   * The `BrainDumpItem` points at the `Task`, because
--     `20260726120000_cleanup_orphaned_tasks` deletes every task no inbox item
--     references. A task seeded without one would be deleted here and every
--     later Task migration would silently be back to testing an empty table.
--   * Free text carries a newline, a quote and a non-BMP emoji, the same
--     hostility `src/lib/export/__tests__/fixture.ts` uses, so a future
--     migration that rewrites text with `format()` or a regex meets the input
--     that breaks it.
--
-- ── Why not reuse the export fixture ───────────────────────────────────────
--
-- #190 proposed it, and it does not fit: that fixture is a TypeScript object
-- built from the CURRENT generated `Settings` type, so it cannot express a
-- column that has since been dropped (`focusSoundCategory`) or omit one that
-- did not exist yet. A seed applied at the 2026-07-03 schema has to be written
-- against the 2026-07-03 schema, which is what SQL at a pinned migration is.
-- The fixture stays the golden master for the current shape; these files are the
-- historical shapes, and the two cannot be the same artefact.

-- The singleton settings row. `id` still defaults to 'singleton' here —
-- 20260706141010 drops that default — and `updatedAt` has no default at all.
INSERT INTO "Settings" ("updatedAt") VALUES (now());

-- Both OAuth singletons exist so that
-- 20260713170000_clear_oauth_tokens_for_encryption has something to delete.
-- ReclaimAuth is dropped entirely by 20260719172453 and GoogleAuth is emptied
-- again by 20260727230000, which is why a later seed re-populates it.
INSERT INTO "ReclaimAuth" ("updatedAt") VALUES (now());
INSERT INTO "GoogleAuth" ("updatedAt") VALUES (now());

INSERT INTO "Task" ("id", "title", "source", "status", "parentEmoji")
VALUES (
  'seed-task-1',
  'Ship "the thing",' || chr(10) || 'with a newline; and a 🚀',
  'braindump',
  'active',
  '🧠'
);

-- taskId is what keeps the task alive through cleanup_orphaned_tasks.
INSERT INTO "BrainDumpItem" ("id", "text", "status", "taskId")
VALUES (
  'seed-inbox-1',
  'remember to call the dentist, ask about the "deep clean"' || chr(10) || 'and the price',
  'triaged',
  'seed-task-1'
);

-- estMinutes = 0 is the row step_est_minutes_check must repair; the second step
-- is already valid, so the migration's WHERE clause has to discriminate.
INSERT INTO "Step" ("id", "taskId", "text", "order", "total", "estMinutes", "done")
VALUES
  ('seed-step-1', 'seed-task-1', 'find the letter', 1, 2, 0, false),
  ('seed-step-2', 'seed-task-1', 'phone them', 2, 2, 15, true);

INSERT INTO "BreakdownTurn" ("id", "taskId", "role", "message")
VALUES
  ('seed-turn-1', 'seed-task-1', 'user', 'break this down for me'),
  ('seed-turn-2', 'seed-task-1', 'assistant', 'two steps: find the letter, phone them');

-- outcome NULL and outcome set: FocusSession_outcome_check allows both, and a
-- constraint written `IN (…)` without the `IS NULL` branch would only fail with
-- the NULL row present.
INSERT INTO "FocusSession" ("id", "stepId", "taskId", "plannedMin", "addedMin", "outcome")
VALUES
  ('seed-session-1', 'seed-step-2', 'seed-task-1', 25, 5, 'completed'),
  ('seed-session-2', 'seed-step-1', 'seed-task-1', 25, 0, NULL);

INSERT INTO "DayRollup" ("id", "date", "focusMin", "sessions", "stepsDone", "pointsEarned", "streakDay")
VALUES ('seed-rollup-1', '2026-07-03', 30, 1, 1, 12, 1);

INSERT INTO "RewardEvent" ("id", "type", "points")
VALUES
  ('seed-reward-1', 'step_done', 3),
  ('seed-reward-2', 'session_finished', 9);

INSERT INTO "Streak" ("current", "lastActiveWorkday") VALUES (1, '2026-07-03');

INSERT INTO "StreakRecord" ("id", "length", "startedAt", "endedAt")
VALUES ('seed-streak-1', 4, now() - interval '10 days', now() - interval '6 days');

INSERT INTO "Badge" ("id", "key") VALUES ('seed-badge-1', 'first_focus');

INSERT INTO "DailySpark" ("id", "date", "quote", "source")
VALUES ('seed-spark-1', '2026-07-03', 'one small thing, then another', 'fallback');
