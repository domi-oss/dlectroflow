-- #70 — one category of the lo-fi catalog = one playlist, and which category is
-- a persisted preference.
--
-- ── Why a new column instead of a new `focusSound` value ────────────────────
--
-- The obvious cheaper move is to overload `Settings.focusSound` with something
-- like `category:chillhop`, following the `catalog:` prefix that #61 introduced
-- for streamed track ids. That was considered and rejected, for three reasons
-- that are all about the CHECK constraint next door:
--
--  1. `Settings_focusSound_check` mirrors `FocusSound` in src/lib/constants.ts
--     EXACTLY — enum-constraint-sync asserts set equality in both directions. So
--     overloading means adding ten `category:*` values to `FocusSound` itself,
--     and `FocusSound` is not a free-form list: `FOCUS_SOUND_SRC` is built by
--     mapping over FOCUS_SOUND_TRACKS, so the new values would be absent from it
--     and `focusTrackById` would return undefined for them. Three readers would
--     silently degrade rather than fail.
--  2. The `catalog:` prefix is documented (src/lib/focus-catalog.ts) as marking a
--     track that CANNOT be persisted, precisely because this column is
--     constrained. Reusing that convention for a value whose whole purpose is to
--     be persisted inverts what it means.
--  3. The two facts are orthogonal, not alternatives. "Which category is the
--     playlist" and "which track does the session open on" are both needed:
--     picking a category still has to start somewhere. One column cannot hold an
--     answer to both questions, and a constraint over a column holding two
--     namespaces can validate neither properly.
--
-- ── Nullable, and the NULL is the normal case ───────────────────────────────
--
-- NULL means "play the whole list", which is what every existing row means today
-- and what every row on an instance with no reachable catalog will go on meaning.
-- It is deliberately NOT a column default of some sentinel string: "nobody has
-- narrowed the playlist" is a real state, and the read side (resolveFocusPlaylist
-- in src/lib/focus-sounds.ts) returns the unnarrowed list for it by identity —
-- which the player depends on, because a changed list re-deals its play order.
--
-- ── The constraint ─────────────────────────────────────────────────────────
--
-- Mirrors `FocusSoundCategory` in src/lib/constants.ts, following the #38
-- pseudo-enum pattern ("<Table>_<column>_check") and registered in
-- src/lib/enum-constraint-sync.integration.test.ts, which fails the suite if it
-- is dropped out of band or drifts from the constant. The behavioural half — a
-- raw UPDATE with an out-of-set slug is rejected while NULL and each of the ten
-- are accepted — is in
-- src/lib/settings-focus-sound-category-check.integration.test.ts.
--
-- These are open-lofi's own slugs. #70's first version listed `ambient`, `asian`
-- and `seasonal`, which do not exist; a constraint carrying those would have
-- rejected every value the picker could actually produce.
--
-- No repair pass is needed, unlike 20260727194512_step_est_minutes_check: the
-- column does not exist yet, so every existing row gets NULL and NULL satisfies
-- the constraint. A later migration that NARROWS this set would need one, or
-- `prisma migrate deploy` can wedge a release halfway through.

ALTER TABLE "Settings" ADD COLUMN "focusSoundCategory" TEXT;

ALTER TABLE "Settings"
  ADD CONSTRAINT "Settings_focusSoundCategory_check"
  CHECK ("focusSoundCategory" IS NULL OR "focusSoundCategory" IN (
    'ambient-lofi',
    'chillhop',
    'jazzhop',
    'soul-rnb',
    'late-night',
    'funk-soul',
    'asian-lofi',
    'seasonal-weather',
    'activities',
    'hybrid'
  ));
