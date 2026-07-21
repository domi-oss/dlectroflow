-- MR ③ — app-wide completion style (Appearance settings).
--
-- Two per-workspace Settings columns drive the app-wide completion treatment
-- (line-through on finished text + the ✓ glyph colour). completeTickColor is a
-- String pseudo-enum: its allowed set lives in src/lib/constants.ts
-- (CompleteTickColor) and is mirrored by the CHECK below + kept in sync by
-- src/lib/enum-constraint-sync.integration.test.ts (#38 pattern).

ALTER TABLE "Settings" ADD COLUMN "completeStrikethrough" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "Settings" ADD COLUMN "completeTickColor" TEXT NOT NULL DEFAULT 'green';

-- Settings.completeTickColor ← CompleteTickColor (green | black)
ALTER TABLE "Settings"
  ADD CONSTRAINT "Settings_completeTickColor_check"
  CHECK ("completeTickColor" IN ('green', 'black'));
