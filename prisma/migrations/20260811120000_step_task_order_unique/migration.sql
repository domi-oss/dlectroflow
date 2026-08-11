-- #245 — `(taskId, order)` becomes UNIQUE on "Step", so ▶ Focus cannot give one
-- task two steps.
--
-- ── Why this needs the database and not application code ───────────────────
--
-- #225 closed the duplicate-`Task` race in all four brain-dump→Task writers by
-- putting a precondition inside the write, and said in as many words what that
-- could not reach: `ensureFocusStep`'s STEP create. On that path the item's
-- `taskId` is already set, so the Task guard is skipped and the transaction takes
-- no row lock at all — both callers read `steps: []` from their own snapshot and
-- both insert. An `UPDATE`'s `where` can carry a precondition; an `INSERT`'s
-- cannot, and there is no row to lock because the whole question is whether a row
-- should exist. Only a constraint at the table grain can decide which insert wins.
--
-- Pressing ▶ Focus twice is enough to reach it, and `!306` made it easier by
-- putting that write behind the failure notice's Retry: `withActionTimeout` bounds
-- how long the UI waits, not how long the request runs.
--
-- ── UNIQUE INDEX rather than a row lock, and the reason is in this repo ─────
--
-- The alternative was `SELECT … FOR UPDATE` on the parent `Task` for the duration.
-- Declined, for four reasons in descending order of weight:
--
--   1. `src/lib/db.ts` already prescribes this exact shape. On tolerating a
--      duplicate it says "The way to tolerate a duplicate here is to not create
--      one" — `createMany`/`createManyAndReturn` with `skipDuplicates: true`,
--      which compiles to `INSERT … ON CONFLICT DO NOTHING`. #158 landed that at
--      four sites. And `ensureFocusStep`'s own docblock records why it could not
--      use it: "`Step` has no unique constraint, so `createMany({ skipDuplicates:
--      true })` … has nothing to conflict on". THIS FILE is what removes that
--      objection. Taking the lock instead would be choosing the shape that module
--      argues against.
--   2. A caught `P2002` is not a silent one. `log: ["error"]` prints the failed
--      query strictly BEFORE the exception reaches any `catch`, which is the
--      defect #156 and #158 exist for and was once escalated as an incident.
--      `ON CONFLICT DO NOTHING` raises nothing at all, so a lost race is a
--      genuine no-op rather than a handled error — which is how every guard in
--      this family is documented.
--   3. An index protects the TABLE; a lock protects only the writer that
--      remembers to take it. There are two step writers today and there will be
--      more.
--   4. Prisma cannot express `FOR UPDATE`, so the lock would need `$queryRaw` —
--      a wider surface for a weaker guarantee.
--
-- ── Why `(taskId, order)` is safe against the two writers that exist ────────
--
-- `confirmBreakdown` (src/app/actions/breakdown.ts) writes `deleteMany` then
-- `createMany` with `order = 1..N`, and its transaction opens with a
-- `task.update` — which takes the parent row lock, so a second concurrent
-- confirm serialises behind the first and then deletes what it committed. The
-- orders it writes are distinct by construction.
--
-- `ejectStepToInbox` renumbers the survivors after a delete, ASCENDING, to
-- `1..N`. That never collides transiently even without a deferrable constraint:
-- the remaining orders are strictly increasing, so the i-th survivor's order is
-- always >= i+1 and every row moves DOWN into a slot the loop has already
-- vacated. Any unprocessed row has a strictly greater order than the target.
-- A future "move this step up" feature that SWAPPED two orders would break here,
-- and it would break loudly at the index rather than silently — which is the
-- right way round.
--
-- ── The repair pass, and why it exists although production needs none ───────
--
-- #180 is the precedent: on 2026-08-07 a data migration that had only ever been
-- applied to empty tables failed in production with SQLSTATE 23514 and then
-- wedged every later migration behind P3009. A unique index over data that
-- already holds duplicates is the same shape.
--
-- Production was read before this file was written and holds ZERO duplicate
-- `(taskId, order)` pairs (52 steps, 17 tasks, 10 of them with steps), and zero
-- `total` drift. That zero is measured rather than assumed — the same
-- `GROUP BY … HAVING count(*) > 1` returns 7 when grouped by `taskId` alone.
--
-- The repair stays anyway, because production is not the only database this runs
-- against: the app is self-hostable, and the race has been reachable from the UI
-- for as long as ▶ Focus has existed. An operator whose data holds one duplicate
-- would otherwise meet #180's failure on upgrade. It is exercised on a POPULATED
-- table by src/lib/migration-data-harness.integration.test.ts, seeded with rows
-- that really do collide — an empty-table run of this file proves only that it
-- parses.
--
-- ── It RENUMBERS, it does not delete ───────────────────────────────────────
--
-- Deleting the loser would mean choosing which row survives, and would lose real
-- data in two ways: at this grain the duplicates are identical, but the general
-- `(taskId, order)` collision can hold two genuinely different steps, and
-- `FocusSession.stepId` is `onDelete: SetNull`, so a delete quietly detaches
-- whatever focus history pointed at it. Moving the duplicates to the tail of
-- their task's ordering satisfies the index and keeps everything: the operator
-- sees an extra step in the breakdown, visible and deletable, rather than a gap.
--
-- The `total` repair runs FIRST and is deliberately scoped to tasks that actually
-- hold a duplicate, so this migration cannot rewrite a row it has no business
-- touching. It has to run before the renumbering because "which tasks held a
-- duplicate" is only computable while they still do.

-- 1. Denormalised `total` on the affected tasks only. A task with two order-1
--    steps carries `total = 1` on both, which after the renumbering below would
--    read as "step 2 of 1" in the breakdown.
UPDATE "Step" AS s
SET "total" = c.n
FROM (
  SELECT "taskId", count(*) AS n
  FROM "Step"
  WHERE "taskId" IN (
    SELECT "taskId" FROM "Step" GROUP BY "taskId", "order" HAVING count(*) > 1
  )
  GROUP BY "taskId"
) AS c
WHERE s."taskId" = c."taskId" AND s."total" <> c.n;

-- 2. Every duplicate but the FIRST of each `(taskId, order)` group moves to the
--    tail. "First" is oldest by `createdAt`, tie-broken by `id` so the choice is
--    total rather than arbitrary — the oldest row is the one any focus history
--    and any synced Google Task already point at.
--
--    `max_order` is read from the pre-update snapshot, so the targets
--    `max_order + 1 … max_order + k` are all free and all distinct.
UPDATE "Step" AS s
SET "order" = t.max_order + d.seq
FROM (
  SELECT r."id",
         r."taskId",
         row_number() OVER (
           PARTITION BY r."taskId" ORDER BY r."order", r."createdAt", r."id"
         ) AS seq
  FROM (
    SELECT "id", "taskId", "order", "createdAt",
           row_number() OVER (
             PARTITION BY "taskId", "order" ORDER BY "createdAt", "id"
           ) AS rn
    FROM "Step"
  ) AS r
  WHERE r.rn > 1
) AS d
JOIN (
  SELECT "taskId", max("order") AS max_order FROM "Step" GROUP BY "taskId"
) AS t ON t."taskId" = d."taskId"
WHERE s."id" = d."id";

-- 3. The constraint itself. `Step_taskId_idx` is left in place: it is now
--    redundant as a prefix of this index, but dropping an index is a performance
--    change with its own justification and does not belong in a correctness fix.
CREATE UNIQUE INDEX "Step_taskId_order_key" ON "Step"("taskId", "order");
