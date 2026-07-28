-- #65 — persist the opt-in music↔timer pause coupling. #43 made the timer drive
-- the music (pausing the timer pauses the lo-fi, resuming resumes it from
-- position); this column adds the OTHER direction: pausing the music from the
-- mini-player also pauses the timer, and playing it again resumes both.
--
-- Workspace-scoped, like every other focus-timer preference: guests keep their
-- own value.
--
-- Unlike focusSound / focusTimerStyle this is a plain Boolean, not a String
-- pseudo-enum, so it needs NO CHECK constraint and adds nothing to the
-- constants.ts ↔ constraint registry in
-- src/lib/enum-constraint-sync.integration.test.ts (#38) — same shape as
-- focusShuffle (#68).
--
-- Defaults false, and deliberately so: with it on, reaching for the player's
-- pause button stops the focus session too. That has to be asked for.

ALTER TABLE "Settings" ADD COLUMN "focusPauseTogether" BOOLEAN NOT NULL DEFAULT false;
