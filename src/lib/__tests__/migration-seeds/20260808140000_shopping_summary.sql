-- #245 — steps that really do collide, so the unique index in
-- `20260811120000_step_task_order_unique` meets the data it exists to survive.
--
-- Seeded after the migration immediately BEFORE that one, which is what puts these
-- rows in the table while its repair pass and its `CREATE UNIQUE INDEX` run.
--
-- Without this file that migration is exactly the shape of the 2026-08-07 incident
-- (#180): three statements whose outcome is decided entirely by stored rows,
-- applied only ever to an empty table, where nothing they do can fail. #190's
-- harness classifies `add-unique-index` as data-dependent and reports a seed gap
-- until these rows exist — and the measured half counts the rows the migration
-- actually met, so a seed a later migration emptied still shows up.
--
-- ── The four cases, and why each is here ───────────────────────────────────
--
-- `seed-task-focus-dupe` — TWO steps at `order` 1 with the same text, `total` 1 on
--   both. This is what two ▶ Focus presses leave behind and the case the whole
--   change is about. The migration must renumber the newer to 2, set `total` to 2
--   on both, and keep both rows.
--
-- `seed-task-triple` — THREE at `order` 1, so the tail numbering is exercised past
--   a single collision. `row_number()` has to hand out 1 and 2 to the two losers,
--   not the same slot twice; a `max(order) + 1` written without the window
--   function would pass the two-row case above and fail here.
--
-- `seed-task-mid-collision` — a collision at `order` 2 of a task whose max order
--   is 3, so the loser lands at 4 rather than at 3. Written because the obvious
--   wrong implementation renumbers into the FIRST free slot, which here is
--   occupied, and a repair pass that violates the constraint it is preparing for
--   is worse than no repair pass.
--
-- `seed-task-clean` — a genuine three-step breakdown with no duplicates and a
--   correct `total`. The control: the repair is scoped to tasks that hold a
--   duplicate, and this task's rows must come out **untouched**. Without it a
--   repair that rewrote the whole table would look identical to one that did not.
--
-- Deliberately no `FocusSession` rows. `Step.stepId` is `onDelete: SetNull`, and
-- this migration renumbers rather than deletes precisely so that history is never
-- detached; a seed carrying sessions would suggest the migration touches them.

INSERT INTO "Workspace" ("id", "kind") VALUES
  ('seed-ws-step-dupes', 'guest');

INSERT INTO "Task" ("id", "title", "workspaceId", "createdAt") VALUES
  ('seed-task-focus-dupe', 'Water the plants', 'seed-ws-step-dupes', now()),
  ('seed-task-triple', 'Book the dentist', 'seed-ws-step-dupes', now()),
  ('seed-task-mid-collision', 'Repaint the hall', 'seed-ws-step-dupes', now()),
  ('seed-task-clean', 'File the tax return', 'seed-ws-step-dupes', now());

-- `createdAt` is explicit and spread, because it is the migration's tie-break for
-- WHICH row keeps the original order. Left to `now()` all of these would share one
-- timestamp and the choice would fall through to `id`, so the assertion about
-- keeping the OLDEST would be passing on the alphabet.
INSERT INTO "Step"
  ("id", "taskId", "text", "order", "total", "estMinutes", "createdAt")
VALUES
  -- Two ▶ Focus presses on one task.
  ('seed-step-focus-a', 'seed-task-focus-dupe', 'Water the plants', 1, 1, 10, '2026-08-01 10:00:00'),
  ('seed-step-focus-b', 'seed-task-focus-dupe', 'Water the plants', 1, 1, 10, '2026-08-01 10:00:01'),

  -- Three at the same order.
  ('seed-step-triple-a', 'seed-task-triple', 'Book the dentist', 1, 1, 10, '2026-08-02 10:00:00'),
  ('seed-step-triple-b', 'seed-task-triple', 'Book the dentist', 1, 1, 10, '2026-08-02 10:00:01'),
  ('seed-step-triple-c', 'seed-task-triple', 'Book the dentist', 1, 1, 10, '2026-08-02 10:00:02'),

  -- A collision at order 2 where order 3 is already taken, so the loser must go
  -- to 4 and not to 3.
  ('seed-step-mid-1', 'seed-task-mid-collision', 'Sand the skirting', 1, 3, 20, '2026-08-03 10:00:00'),
  ('seed-step-mid-2a', 'seed-task-mid-collision', 'Undercoat', 2, 3, 30, '2026-08-03 10:00:01'),
  ('seed-step-mid-2b', 'seed-task-mid-collision', 'Undercoat again', 2, 3, 30, '2026-08-03 10:00:02'),
  ('seed-step-mid-3', 'seed-task-mid-collision', 'Topcoat', 3, 3, 30, '2026-08-03 10:00:03'),

  -- The untouched control.
  ('seed-step-clean-1', 'seed-task-clean', 'Gather receipts', 1, 3, 45, '2026-08-04 10:00:00'),
  ('seed-step-clean-2', 'seed-task-clean', 'Fill the form', 2, 3, 60, '2026-08-04 10:00:01'),
  ('seed-step-clean-3', 'seed-task-clean', 'Submit', 3, 3, 15, '2026-08-04 10:00:02');
