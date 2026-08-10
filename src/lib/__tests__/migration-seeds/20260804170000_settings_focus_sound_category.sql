-- #190 — the other two pre-conversion focus-sound states.
--
-- `20260806100000_settings_focus_sound_categories` collapses three states into
-- two columns, and each state is handled by a different statement. The seed after
-- `20260726120000_focus_sound_lofi_library` covers "a track, no category"; these
-- two cover the rest, so every branch of that conversion runs on a row:
--
--   focusSoundCategory set, sound not off  ->  'on',  [that category]
--   focusSound = 'off', category set       ->  'off', []          (unchanged)
--
-- The second is the state the picker cannot produce — off with a category left
-- behind — and it is the one that matters most here. The conversion's first
-- statement carries `AND "focusSound" <> 'off'` precisely to leave it alone, so
-- without this row that clause is unexercised and dropping it would still be
-- green: an account that chose silence would come back with a playlist and
-- nothing would have noticed.
--
-- Seeded at this migration because it is the one that adds `focusSoundCategory`.

INSERT INTO "Workspace" ("id", "kind") VALUES
  ('seed-ws-category', 'guest'),
  ('seed-ws-silent', 'guest');

INSERT INTO "Settings" ("id", "workspaceId", "updatedAt", "focusSound", "focusSoundCategory")
VALUES
  ('seed-ws-category', 'seed-ws-category', now(), 'lofi_calm', 'jazzhop'),
  ('seed-ws-silent', 'seed-ws-silent', now(), 'off', 'hybrid');
