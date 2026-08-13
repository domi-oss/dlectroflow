-- #252 — the header's right cluster: a real name, and quick access to the two
-- destinations that were only reachable through the hamburger.
--
-- ── Both statements are pure metadata, and that is the point ────────────────
--
-- The 2026-08-06 outage (P3009) was a data migration that had only ever been
-- exercised against empty tables. Neither statement here writes a row:
--
--  * "User"."displayName" is nullable with no DEFAULT, so PostgreSQL records a
--    catalogue entry and stops. Every existing account reads NULL, which
--    accountLabel() renders exactly as it renders one today — the provider
--    handle, else the "#id" stub. Nothing is backfilled from `handle`, because
--    the whole complaint in #252 is that the handle is not a name.
--  * "Settings"."focusQuickAccess" is NOT NULL DEFAULT true. Since PostgreSQL
--    11 an ADD COLUMN with a non-volatile DEFAULT is also metadata-only: the
--    default is stored in pg_attribute (attmissingval) and materialised lazily
--    as rows are next written, so this does not rewrite the table and does not
--    lock it for the length of one.
--
-- ── Why the boolean may carry a DEFAULT when focusSound may not ─────────────
--
-- src/lib/focus-sound-migration-hygiene.ts refuses an ADD COLUMN default on
-- focusSound, focusSoundCategories and focusShuffle, because for those three the
-- default IS the value the row will be read at, and #180's rule is that an
-- existing account never has audio switched on for it. This column is not in
-- that set and the reasoning does not carry over: `true` here means one more
-- 44px link in the header, it makes no sound, it changes no stored preference,
-- and it is reversible from Settings > Focus timer in one click. Defaulting it
-- to false instead would ship the feature switched off for every existing
-- account — i.e. hidden behind the settings page nobody opens, which is the
-- failure #180 was itself correcting.

ALTER TABLE "User" ADD COLUMN "displayName" TEXT;

ALTER TABLE "Settings" ADD COLUMN "focusQuickAccess" BOOLEAN NOT NULL DEFAULT true;
