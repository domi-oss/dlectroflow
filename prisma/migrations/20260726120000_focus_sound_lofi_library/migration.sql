-- #43 — real lo-fi library. Widen the Settings.focusSound CHECK constraint from
-- the MR ② placeholder set (off | lofi_calm) to the curated open-lofi track set
-- (one bundled CC0 track per category). The allowed set is the single source of
-- truth in src/lib/constants.ts (FocusSound) and is kept in lockstep by
-- src/lib/enum-constraint-sync.integration.test.ts (#38). `off` and `lofi_calm`
-- are retained so already-saved rows stay valid (lofi_calm now points at a real
-- ambient track rather than the silent placeholder). Non-nullable column, so no
-- IS NULL allowance (matches the original constraint).

ALTER TABLE "Settings" DROP CONSTRAINT "Settings_focusSound_check";

ALTER TABLE "Settings"
  ADD CONSTRAINT "Settings_focusSound_check"
  CHECK ("focusSound" IN (
    'off',
    'lofi_calm',
    'lofi_chillhop',
    'lofi_jazzhop',
    'lofi_soul_rnb',
    'lofi_late_night',
    'lofi_funk_soul',
    'lofi_asian',
    'lofi_seasonal',
    'lofi_activities',
    'lofi_hybrid'
  ));
