-- #80 — DB-level integrity for BrainDumpItem.estMinutes: an estimate is either
-- absent, or it is at least one whole minute.
--
-- This is the sibling decision to Step_estMinutes_check (#78, !167), and the
-- shape is deliberately NOT the same. Step.estMinutes is NOT NULL, so `>= 1` is
-- the whole invariant. BrainDumpItem.estMinutes is NULLABLE and null is
-- MEANINGFUL — it says "the user never gave an estimate", and the read side
-- substitutes a display default rather than a stored one (`item.estMinutes ?? 5`
-- in library-row-meta.tsx and app/(app)/focus/page.tsx). Copying `>= 1` across
-- would have made every estimate-less item unwritable and broken `createItem`,
-- which omits the column entirely, on its very first insert. Hence
-- `IS NULL OR >= 1`.
--
-- #80's actual complaint was that the difference between the two columns was
-- accidental rather than recorded. It is now recorded in three places: here, on
-- the column in schema.prisma, and as `nullable: true` in the
-- enum-constraint-sync RANGE_REGISTRY, which fails the suite if the NULL
-- allowance is ever dropped.
--
-- Writer audit (the reason this is safe to enforce): exactly ONE writer touches
-- this column — `setItemEstimate` in src/app/actions/braindump.ts, which returns
-- early on non-finite input and then writes
-- `Math.max(1, Math.min(600, Math.round(minutes)))`, so it cannot produce 0 or a
-- negative. Every other BrainDumpItem write path (`createItem`, `startBreakdown`,
-- `splitStepToInbox`, `moveToReview`, the bulk Library actions, the
-- google-schedule task-link transaction, and prisma/seed.ts) omits estMinutes
-- entirely and therefore leaves it NULL. No path can violate this constraint
-- today; it exists so that a SECOND writer added later (an import, a bulk edit,
-- an AI-suggested estimate) inherits the guarantee instead of re-deriving it.
--
-- Constraint naming follows the #38 pseudo-enum constraints
-- ("<Table>_<column>_check"). The behavioural proof — a raw INSERT of 0 / -5 is
-- rejected while NULL and 1 are accepted — is in
-- src/lib/braindump-item-est-minutes-check.integration.test.ts.

-- Repair before enforce, exactly as #78 did. Verified before writing this
-- migration across all 60 local/dev schemas that carry the column: 1011
-- BrainDumpItem rows, 987 with a NULL estimate, 0 with estMinutes < 1 — so this
-- statement is expected to match zero rows. It exists so that if production
-- somehow holds one, the deploy REPAIRS it instead of failing halfway through
-- `prisma migrate deploy` and leaving the release wedged.
--
-- Clamped to 1 (the constraint floor), which is exactly what setItemEstimate's
-- `Math.max(1, ...)` would have produced for the same input — the repair invents
-- no estimate the user never gave. NULL rows are untouched: `NULL < 1` is NULL,
-- never true, so they cannot match this WHERE clause. Idempotent: matches zero
-- rows on any re-run.
UPDATE "BrainDumpItem" SET "estMinutes" = 1 WHERE "estMinutes" < 1;

ALTER TABLE "BrainDumpItem"
  ADD CONSTRAINT "BrainDumpItem_estMinutes_check"
  CHECK ("estMinutes" IS NULL OR "estMinutes" >= 1);
