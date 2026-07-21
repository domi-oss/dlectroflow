-- MR ② — Focus timer redesign (visual/behaviour settings).
--
-- Six per-workspace Settings columns drive the redesigned focus timer. Two are
-- String pseudo-enums whose allowed sets live in src/lib/constants.ts
-- (FocusTimerStyle, FocusSound) and are mirrored by the CHECK constraints below
-- + kept in sync by src/lib/enum-constraint-sync.integration.test.ts (#38).
-- focusTimerStyle is nullable (null → the timer resolves a style from the
-- workspace voice), so its CHECK explicitly allows NULL.

ALTER TABLE "Settings" ADD COLUMN "focusTimerStyle" TEXT;
ALTER TABLE "Settings" ADD COLUMN "focusMinimalMode" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Settings" ADD COLUMN "focusKeepAwake" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "Settings" ADD COLUMN "focusAlarmEnabled" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "Settings" ADD COLUMN "focusSound" TEXT NOT NULL DEFAULT 'off';
ALTER TABLE "Settings" ADD COLUMN "focusTimerTipDismissedAt" TIMESTAMP(3);

-- Settings.focusTimerStyle ← FocusTimerStyle (ring | digits | bar | mug); NULL → voice default
ALTER TABLE "Settings"
  ADD CONSTRAINT "Settings_focusTimerStyle_check"
  CHECK ("focusTimerStyle" IN ('ring', 'digits', 'bar', 'mug') OR "focusTimerStyle" IS NULL);

-- Settings.focusSound ← FocusSound (off | lofi_calm)
ALTER TABLE "Settings"
  ADD CONSTRAINT "Settings_focusSound_check"
  CHECK ("focusSound" IN ('off', 'lofi_calm'));
