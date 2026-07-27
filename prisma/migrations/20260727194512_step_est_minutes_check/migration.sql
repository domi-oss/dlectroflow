-- #78 — DB-level integrity for Step.estMinutes: every step is at least one
-- whole minute long.
--
-- Until now the >= 1 invariant lived only in application code. Four writers
-- clamp it — confirmBreakdown (`Math.max(1, Math.round(s.estMinutes || 15))`,
-- which is also what stops a hostile or confused model proposing a negative
-- through the `propose_steps` tool), updateStepEstimate, requeueFocus, and the
-- single-task seed in ensureFocusStep — so the data is correct today, but the
-- guarantee rests on four scattered call sites staying correct forever and a
-- fifth writer added later inherits no protection.
--
-- Why it matters: a sub-1 estimate is a wrong-answer bug, not a cosmetic one.
-- !158 found a single bad row among good ones distorting the step-size summary
-- the breakdown coach is handed — [-5, 0, 0.4, 10, 20] read out as "5 steps
-- (0-20 min, ~0 median)", telling the coach this person likes zero-minute steps
-- and sizing its next proposal accordingly. That MR fixed the READ side
-- (breakdown-context.ts now skips any estimate < 1 rather than coercing it);
-- this is the cure the guard was standing in for.
--
-- Constraint naming follows the #38 pseudo-enum constraints
-- ("<Table>_<column>_check"), and it is registered alongside them in
-- src/lib/enum-constraint-sync.integration.test.ts (RANGE_REGISTRY), so
-- dropping it out of band fails the suite. The behavioural proof — a raw
-- INSERT of 0 / -5 is rejected — is in
-- src/lib/step-est-minutes-check.integration.test.ts.
--
-- BrainDumpItem.estMinutes is deliberately NOT covered here: it is a nullable
-- single-task estimate with a different writer (setItemEstimate, clamped to
-- [1, 600]) and a null-means-"use the display default" contract. Constraining
-- it is a separate decision, not a silent rider on this one.

-- Repair before enforce. No row anywhere in the local/dev database shapes
-- violates this (verified across all 36 schemas before writing the migration:
-- 29 Step rows total, 0 with estMinutes < 1), so this statement is expected to
-- match zero rows. It exists so that if production somehow holds one, the
-- deploy REPAIRS it instead of failing halfway through `prisma migrate deploy`
-- and leaving the release wedged.
--
-- Clamped to 1 (the constraint floor) rather than to the app's 15-minute
-- fallback: 1 is exactly what every writer's `Math.max(1, ...)` would have
-- produced for the same input, so the repair invents no estimate the user
-- never gave. Idempotent: matches zero rows on any re-run.
UPDATE "Step" SET "estMinutes" = 1 WHERE "estMinutes" < 1;

ALTER TABLE "Step"
  ADD CONSTRAINT "Step_estMinutes_check"
  CHECK ("estMinutes" >= 1);
