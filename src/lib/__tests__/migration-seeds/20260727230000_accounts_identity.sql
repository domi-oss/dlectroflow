-- #190 — accounts, and the OAuth rows that outlive them.
--
-- Three later migrations do surgery on this data and all three were only ever
-- run against empty tables:
--
--   20260728130100_owner_uncapped_repair   UPDATE … WHERE role = 'owner'
--   20260729140000_google_auth_orphan_purge DELETE, plus a repair + CHECK on
--                                           User.llmProvider
--   20260804120000_google_auth_user_id_not_null  DELETE, then SET NOT NULL
--
-- Seeded here rather than at init because `User` is created by the migration this
-- file is named for, and because that migration ends with an unqualified
-- `DELETE FROM "GoogleAuth"` — an OAuth row seeded any earlier is gone by this
-- point, and every later GoogleAuth migration would be back to an empty table
-- while a static coverage check still called it seeded.
--
-- Each row is chosen so that a migration's WHERE clause has to DISCRIMINATE, not
-- merely match:
--
--   * an owner on the capped policy, which owner_uncapped_repair must change,
--     beside a member on the same policy, which it must leave alone;
--   * `aiQuota = 0`, the boundary `User_aiQuota_check` (>= 0) allows, so an
--     off-by-one written as `> 0` fails here rather than in production;
--   * `llmProvider = 'ollama'`, a value from before the provider list was fixed,
--     which google_auth_orphan_purge has to NULL out before its CHECK can be
--     added — beside 'anthropic', which must survive;
--   * a GoogleAuth row WITHOUT a userId, which is what both purges exist to
--     remove, beside one WITH a userId, which must survive to meet
--     `SET NOT NULL`. If only the orphan were seeded, SET NOT NULL would be
--     applied to an empty table again and the test would prove nothing.

INSERT INTO "User" ("id", "provider", "providerSub", "email", "role", "aiPolicy", "aiQuota", "llmProvider")
VALUES
  ('seed-user-owner', 'google', 'seed-sub-owner', 'owner@example.invalid', 'owner', 'capped', 0, 'ollama'),
  ('seed-user-member', 'google', 'seed-sub-member', 'member@example.invalid', 'member', 'capped', 50, 'anthropic');

-- 'user' becomes a legal kind in this same migration; before it the CHECK
-- permitted 'owner' and 'guest' only.
INSERT INTO "Workspace" ("id", "kind", "userId")
VALUES ('seed-ws-user', 'user', 'seed-user-owner');

-- `id` lost its default in this migration, so both rows name one.
--
-- The token columns are left NULL, the same discipline as
-- 20260713170000_clear_oauth_tokens_for_encryption and for the same reason: a
-- fake token string in a public repo is a secret-scanner finding waiting to
-- happen. It buys no coverage either. The only later migration that reads a
-- token is 20260804120000_google_auth_user_id_not_null, which asks whether one
-- IS NOT NULL purely to log it, and only for the orphan rows it is deleting —
-- never for this one, which survives precisely because it has a userId.
--
-- `scope` stays. It is a published Google constant rather than a credential,
-- and it is what makes this row read as a live calendar grant instead of a
-- bare foreign key.
INSERT INTO "GoogleAuth" ("id", "updatedAt", "userId", "scope")
VALUES ('seed-google-linked', now(), 'seed-user-owner', 'https://www.googleapis.com/auth/calendar');

INSERT INTO "GoogleAuth" ("id", "updatedAt", "userId")
VALUES ('seed-google-orphan', now(), NULL);
