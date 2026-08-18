-- #261 — one aging threshold, in hours.
--
-- `Settings` carried two answers to "is this item aging?": `agingThresholdMinutes`
-- (default 240) drove `isAging()`, and `agingHours` (default 4) drove
-- `freshnessTier()`. Same concept, same default, different units, both editable,
-- nothing reconciling them.
--
-- ── The conversion, and its rounding rule ───────────────────────────────────
--
-- The minutes value is CONVERTED rather than dropped: a workspace that set 90
-- minutes must not wake up on the 4-hour default.
--
--   * NEAREST WHOLE HOUR, floored at 1. That is the rule `updateAgingSettings`
--     already applies to every hours field (`Math.max(1, Math.round(v))`), so a
--     converted value is one the Settings page could itself have produced, and no
--     workspace ends up holding a number its own UI cannot express. 90 min → 2h;
--     30 min → 1h (the floor, not 0, because 0 would make every item aging the
--     instant it was captured).
--   * `/ 60.0` makes the division `numeric`, so `ROUND` is half-away-from-zero
--     and matches `Math.round`. On `double precision` Postgres rounds half to
--     EVEN, which would send 90 minutes to 2h and 150 minutes to 2h as well.
--   * ONLY where `agingHours` is still its default. A workspace that moved both
--     controls expressed two intents, and the hours one is the newer system and
--     the one driving the visible status pill — so an explicitly chosen
--     `agingHours` is never overwritten by a minutes value the user may have set
--     months earlier and forgotten.
--
-- Exercised against seeded rows by `migration-data-harness.integration.test.ts`
-- (#190): `migration-seeds/20260815120100_engagement_day_backfill.sql` stores the
-- four cases below, and the assertions there name the expected hours. A data
-- migration that has only ever run on an empty table is the 2026-08-07 shape.
UPDATE "Settings"
   SET "agingHours" = GREATEST(1, ROUND("agingThresholdMinutes" / 60.0)::int)
 WHERE "agingThresholdMinutes" <> 240
   AND "agingHours" = 4;

-- The minutes column, and the demo override that rescaled the whole system into
-- seconds so hours of behaviour could fire live on stage. That talk has happened.
ALTER TABLE "Settings" DROP COLUMN "agingThresholdMinutes";
ALTER TABLE "Settings" DROP COLUMN "demoOverrideSeconds";

-- The round-up's own separate demo switch (fires ~4s after page load, skipping
-- the once-per-day guard). Same decision, same reason.
ALTER TABLE "Settings" DROP COLUMN "roundupDemoOverride";

-- ── #208 — redundant single-column indexes ──────────────────────────────────
--
-- Each of these five is a plain index whose column list is a PREFIX of another
-- index already on the same model, so Postgres can serve every read it could
-- serve from the leading column of the wider one. They cost write amplification
-- and storage and buy no read.
--
-- #208 names two (`Badge`, `FocusPlaylist`) because that is what review of !282
-- happened to be looking at. Re-derived over the whole schema, the real set is
-- five: `BrainDumpItem` and `Step` are the same shape under a `@@unique`, and
-- `GuestDailyActivity` is the same shape under a composite PRIMARY KEY — which is
-- why every count so far has missed it, the search having been for a `@@unique`.
--
-- Reads verified per model before dropping: every one is `where: { <col> }` or
-- `where: { <col>, <the second column> }`, both of which the composite serves.
DROP INDEX "BrainDumpItem_workspaceId_idx"; -- ⊂ BrainDumpItem_workspaceId_clientKey_key
DROP INDEX "Step_taskId_idx"; -- ⊂ Step_taskId_order_key
DROP INDEX "FocusPlaylist_workspaceId_idx"; -- ⊂ FocusPlaylist_workspaceId_name_key
DROP INDEX "Badge_workspaceId_idx"; -- ⊂ Badge_workspaceId_key_key
DROP INDEX "GuestDailyActivity_day_idx"; -- ⊂ GuestDailyActivity_pkey (day, ipHash)
