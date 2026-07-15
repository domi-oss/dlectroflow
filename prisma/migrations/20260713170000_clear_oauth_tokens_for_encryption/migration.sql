-- Clean slate for #21 P2 (token encryption): drop the singleton OAuth rows so
-- no plaintext token survives the transition. getAuth() re-upserts an empty
-- row on next access; the owner reconnects Google + Reclaim once, and all new
-- writes are encrypted. Reclaim rows are removed entirely so ensureClient()
-- re-registers a fresh client (its clientSecret is encrypted from birth).
DELETE FROM "ReclaimAuth";
DELETE FROM "GoogleAuth";
