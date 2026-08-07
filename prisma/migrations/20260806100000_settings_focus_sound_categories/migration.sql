-- #180 — focus sound becomes a switch, and the playlist becomes a multi-select.
--
-- Two columns change meaning and one is dropped:
--
--   focusSound            "off" | a lofi_* track id   ->  "off" | "on"
--   focusSoundCategory    NULL | one slug (#70)       ->  (dropped)
--   focusSoundCategories  --                          ->  text[] of slugs
--
-- ── Why an array with a containment CHECK ──────────────────────────────────
--
-- The alternatives were a join table and a JSON column, and both were declined
-- for the same reason: #70's guarantee is that a hand-edited unknown slug is
-- rejected by the database, and `enum-constraint-sync.integration.test.ts`
-- asserts the constraint mirrors `FocusSoundCategory` in src/lib/constants.ts
-- exactly. A JSON column has nothing to constrain. A join table keeps the
-- guarantee but as a foreign key to a seeded reference table, which is a second
-- source of truth for the same ten strings and a second thing to migrate when an
-- eleventh appears.
--
-- Containment (`<@`) keeps it as one column and one constraint whose definition
-- Postgres renders with the same single-quoted literals as the `IN (…)` form, so
-- the existing sync test parses it unchanged.
--
-- NOT NULL is load-bearing, not tidiness: `NULL <@ ARRAY[…]` evaluates to NULL
-- and a CHECK constraint PASSES on NULL, so a nullable column would accept an
-- unvalidated NULL into a field Prisma types as `string[]`. An array containing
-- a NULL element is rejected by `<@` on its own, which is why the constraint
-- needs no `IS TRUE` wrapper; both halves are pinned in
-- src/lib/settings-focus-sound-categories-check.integration.test.ts.
--
-- ── The empty array is the whole catalogue ─────────────────────────────────
--
-- That is what #70's NULL meant, so no reader changes meaning. It also leaves
-- exactly one way to get silence — the switch. An "on, but nothing selected"
-- dead state looks broken and has no way out that is not guessing.
--
-- ── Conversion: no behaviour change for anyone ─────────────────────────────
--
-- Three existing states, in the order the statements below handle them:
--
--   focusSound = 'off'          ->  'off', []          (silence stays silence;
--                                                       an off row with a
--                                                       category set is not
--                                                       reachable through the UI
--                                                       and is treated as off)
--   focusSoundCategory NOT NULL ->  'on',  [that slug]
--   a track id, no category     ->  'on',  [that track's category]
--
-- The category wins over the track when both are set: it is the more recent and
-- more deliberate expression of intent, and the track it implied was only ever
-- "where this category opens", which nothing persists any more.
--
-- ── Existing accounts are not switched on ──────────────────────────────────
--
-- New accounts default to sound on (the SET DEFAULT statements at the foot), and
-- that reaches only rows inserted afterwards. There is deliberately no repair
-- pass over existing rows: "chose silence" and "never got round to it" are
-- indistinguishable in the data, and starting audio at someone who chose silence
-- has no undo for the startle. The one UPDATE that writes 'on' below is
-- shape-preserving — it only rewrites rows that ALREADY meant sound — and
-- src/lib/focus-sound-migration-hygiene.test.ts fails the build if any migration,
-- now or later, writes 'on' without that guard.
--
-- ADD COLUMN carries the EMPTY default for the same reason: an ADD COLUMN
-- default is written into every existing row, so the new-account value is
-- applied by ALTER COLUMN … SET DEFAULT afterwards, which is not.

-- 1. The new column, defaulted to the value that changes nobody's behaviour.
ALTER TABLE "Settings"
  ADD COLUMN "focusSoundCategories" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

-- 2. A stored category becomes a one-element selection. Rows that are OFF keep
--    the empty array: the switch is the only thing that says silence, and an
--    off row carrying a category is a state the picker could never produce.
UPDATE "Settings"
   SET "focusSoundCategories" = ARRAY["focusSoundCategory"]::TEXT[]
 WHERE "focusSoundCategory" IS NOT NULL
   AND "focusSound" <> 'off';

-- 3. A stored TRACK, with no category, becomes that track's category — the
--    nearest thing to "keep playing what I was playing" that survives the loss
--    of a persisted opening track. The pairs mirror FOCUS_SOUND_TRACKS in
--    src/lib/focus-sounds.ts, and focus-sound-migration-hygiene.test.ts reads
--    this CASE back and compares it against that catalogue, so a typo in one of
--    the ten fails the build rather than silently handing someone the wrong
--    genre.
UPDATE "Settings"
   SET "focusSoundCategories" = CASE "focusSound"
         WHEN 'lofi_calm'       THEN ARRAY['ambient-lofi']::TEXT[]
         WHEN 'lofi_chillhop'   THEN ARRAY['chillhop']::TEXT[]
         WHEN 'lofi_jazzhop'    THEN ARRAY['jazzhop']::TEXT[]
         WHEN 'lofi_soul_rnb'   THEN ARRAY['soul-rnb']::TEXT[]
         WHEN 'lofi_late_night' THEN ARRAY['late-night']::TEXT[]
         WHEN 'lofi_funk_soul'  THEN ARRAY['funk-soul']::TEXT[]
         WHEN 'lofi_asian'      THEN ARRAY['asian-lofi']::TEXT[]
         WHEN 'lofi_seasonal'   THEN ARRAY['seasonal-weather']::TEXT[]
         WHEN 'lofi_activities' THEN ARRAY['activities']::TEXT[]
         WHEN 'lofi_hybrid'     THEN ARRAY['hybrid']::TEXT[]
         -- Unreachable while Settings_focusSound_check holds; an unknown id
         -- widens to the whole catalogue rather than emptying the playlist,
         -- which is the same never-go-silent rule resolveFocusPool applies.
         ELSE ARRAY[]::TEXT[]
       END
 WHERE "focusSoundCategory" IS NULL
   AND "focusSound" <> 'off';

-- 4. The OLD constraint has to go before the conversion, not after it.
--
--    It permits 'off' plus the ten `lofi_*` track ids and nothing else, so the
--    UPDATE below — which writes 'on' — violates it on every existing row.
--    Dropping it here rather than at step 6 is the whole fix for the incident
--    on 2026-08-07: this migration failed in production with
--
--      ERROR: new row for relation "Settings" violates check constraint
--             "Settings_focusSound_check"  (SQLSTATE 23514)
--
--    and rolled back, after which Prisma refused every later migration (P3009)
--    and no deploy could reach the cluster for two days.
--
--    The comment that used to sit at step 6 had the reasoning inverted: it
--    guarded against the NEW constraint rejecting PRE-conversion rows, when the
--    real hazard is the OLD constraint rejecting POST-conversion ones. Only the
--    ADD needs to come after the conversion; the DROP must come before it.
ALTER TABLE "Settings" DROP CONSTRAINT "Settings_focusSound_check";

-- 5. Every row that meant "play something" now means "on". Guarded on the off
--    state: see the note above on why no row may cross from off to on here.
UPDATE "Settings"
   SET "focusSound" = 'on'
 WHERE "focusSound" <> 'off';

-- 6. #70's column and its constraint are dropped, not merely left unused —
--    keeping them would give a future writer a second, differently-shaped place
--    to record the same preference.
ALTER TABLE "Settings" DROP CONSTRAINT "Settings_focusSoundCategory_check";
ALTER TABLE "Settings" DROP COLUMN "focusSoundCategory";

-- 7. The replacement constraint, mirroring FocusSound in src/lib/constants.ts.
--    This half genuinely does belong AFTER the conversion: applied earlier it
--    would reject the pre-conversion `lofi_*` rows that step 5 is on its way to
--    rewriting. Non-nullable column, so no IS NULL allowance (matches the
--    constraint it replaces). The DROP that used to be on the line above now
--    sits at step 4 — see the note there.
ALTER TABLE "Settings"
  ADD CONSTRAINT "Settings_focusSound_check"
  CHECK ("focusSound" IN ('off', 'on'));

-- 8. The containment guard. Mirrors FocusSoundCategory in src/lib/constants.ts
--    and is registered in src/lib/enum-constraint-sync.integration.test.ts,
--    which fails the suite if it is dropped out of band or drifts from the
--    constant. A NEW category needs a paired migration replacing this.
ALTER TABLE "Settings"
  ADD CONSTRAINT "Settings_focusSoundCategories_check"
  CHECK ("focusSoundCategories" <@ ARRAY[
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
  ]::TEXT[]);

-- 9. New accounts only. A column default applies to rows inserted after it, so
--    nothing above this line is re-read and nothing already stored changes.
--
--    Ambient lo-fi rather than chillhop because it holds 21 tracks to chillhop's
--    8 in the full catalogue, so it repeats far less, and it is the least
--    intrusive of the ten for someone who did not ask for music. It also has a
--    bundled track (#43), so an instance with no FOCUS_CATALOG_ORIGIN still has
--    something to play — the fallback matters here precisely because this is the
--    value nobody chose.
ALTER TABLE "Settings" ALTER COLUMN "focusSound" SET DEFAULT 'on';
ALTER TABLE "Settings"
  ALTER COLUMN "focusSoundCategories" SET DEFAULT ARRAY['ambient-lofi']::TEXT[];
ALTER TABLE "Settings" ALTER COLUMN "focusShuffle" SET DEFAULT true;
