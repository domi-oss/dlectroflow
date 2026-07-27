-- #68 Phase 1 — persist the focus-playlist shuffle preference. It's a taste
-- setting (like the timer style or the chosen track), not a per-session one, so
-- it lives on Settings and is workspace-scoped: guests keep their own value.
--
-- Unlike focusSound / focusTimerStyle this is a plain Boolean, not a String
-- pseudo-enum, so it needs NO CHECK constraint and adds nothing to the
-- constants.ts ↔ constraint registry in
-- src/lib/enum-constraint-sync.integration.test.ts (#38).
--
-- Defaults false: existing workspaces keep in-order playback until they press
-- Shuffle in the mini-player.

ALTER TABLE "Settings" ADD COLUMN "focusShuffle" BOOLEAN NOT NULL DEFAULT false;
