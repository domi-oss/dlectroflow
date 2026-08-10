-- #190 — the account that took production down on 2026-08-07.
--
-- `Settings.focusSound` holds a `lofi_*` TRACK id here. That is the state
-- `20260806100000_settings_focus_sound_categories` converts to `'on'`, and it is
-- the state no test had, because a fresh row gets the column default (`'off'`)
-- and the conversion's `WHERE "focusSound" <> 'off'` then matches nothing.
--
-- With this row present, the pre-fix ordering of that migration — write `'on'`
-- first, drop the constraint that forbids `'on'` afterwards — fails on the write:
--
--     ERROR: new row for relation "Settings" violates check constraint
--            "Settings_focusSound_check"   (SQLSTATE 23514)
--
-- `migration-data-harness.integration.test.ts` reconstructs that ordering and
-- requires exactly that failure, which is the condition #190 is closed on.
--
-- Seeded HERE and not earlier because the ten track ids only become legal values
-- in the migration this file is named for: before it,
-- `Settings_focusSound_check` permitted `'off'` and `'lofi_calm'` alone.
--
-- A second workspace rather than an UPDATE of the first: the seeds are additive
-- so the singleton account seeded at init keeps its own shape, and two Settings
-- rows differing only in the column under test are what makes a conversion's
-- WHERE clause discriminate rather than sweep.

INSERT INTO "Workspace" ("id", "kind") VALUES ('seed-ws-track', 'guest');

-- `id` has had no default since 20260706141010, and `updatedAt` never had one.
-- Every other column is left at its default, which is the point: this row
-- differs from a brand-new one in exactly one place.
INSERT INTO "Settings" ("id", "workspaceId", "updatedAt", "focusSound")
VALUES ('seed-ws-track', 'seed-ws-track', now(), 'lofi_chillhop');
