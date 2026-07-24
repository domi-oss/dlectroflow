-- #40 — user-selected UI typeface (Appearance a11y).
--
-- typeface is a String pseudo-enum: its allowed set lives in src/lib/constants.ts
-- (Typeface) and is mirrored by the CHECK below + kept in sync by
-- src/lib/enum-constraint-sync.integration.test.ts (#38 pattern). The column is
-- NOT NULL with a "figtree" default, so existing Settings rows backfill to the
-- app-default face and the server action never writes an out-of-set value.

ALTER TABLE "Settings" ADD COLUMN "typeface" TEXT NOT NULL DEFAULT 'figtree';

-- Settings.typeface ← Typeface (figtree | atkinson | opendyslexic | system)
ALTER TABLE "Settings"
  ADD CONSTRAINT "Settings_typeface_check"
  CHECK ("typeface" IN ('figtree', 'atkinson', 'opendyslexic', 'system'));
