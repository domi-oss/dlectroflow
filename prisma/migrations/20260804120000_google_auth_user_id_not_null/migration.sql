-- #122 — a Google credential must belong to somebody. The enforce half of the
-- repair/enforce pair #118 deliberately split across two releases.
--
-- WHY THIS WAS NOT IN #118
--
-- The code #118 replaced wrote `create: { id: SINGLETON_ID }` with no `userId`
-- on every page load — including an anonymous guest's, via an unconditional
-- getGoogleStatus() on the inbox. SET NOT NULL applied while old pods were still
-- serving a rolling update would therefore have turned the inbox into a 500 for
-- the length of the rollout: the new column rejects the write the OLD pods are
-- still making. So Phase C shipped the repair (20260729140000_google_auth_orphan_purge
-- destroyed the one orphan production held) and left the column nullable, with
-- the reason recorded in the plan's Decision 2.
--
-- WHY IT IS SAFE NOW
--
-- #118 shipped in v0.5.0. src/lib/google.ts is the only non-test file that
-- touches prisma.googleAuth and all four of its statements name `userId`; the
-- e2e fixture (e2e/google-credential.ts) names it on both branches of its
-- upsert; nothing in prisma/seed.ts, prisma/seed-allowlist.ts or
-- prisma/scheduled-purge.ts references the table at all; and no raw SQL in the
-- tree writes it. There is no writer left that can produce a NULL.
--
-- WHAT THE CONSTRAINT IS FOR, GIVEN THAT
--
-- src/lib/__tests__/scoping.harness.test.ts stays the PRIMARY guard: it fails in
-- CI, with a file and an operation named, if any prisma.googleAuth.* call omits
-- `userId` — which is strictly better than a runtime 23502 in front of a user.
-- This constraint is the layer beneath it, for the writer a static scan of the
-- repo structurally cannot see: raw SQL, a psql session, a restore of an older
-- dump. A GoogleAuth row carries an encrypted access/refresh token pair, and a
-- NULL-userId one is unreachable (reads key on userId), unrevocable
-- (disconnectGoogle deletes by userId) AND uncascadable (the FK cascades FROM
-- User, and a NULL never reaches one) — so the last layer is worth having.

-- Repair before enforce (the convention set by
-- 20260727194512_step_est_minutes_check and followed by #118's purge).
--
-- ALTER COLUMN ... SET NOT NULL re-validates every existing row, so a single
-- orphan would abort this statement and wedge `prisma migrate deploy` partway
-- through a release. Deleting first means an unexpected orphan costs a reconnect
-- instead of a stuck deploy.
--
-- Expected to match zero rows: #118 purged the one that existed, and the
-- pre-flight for this change is `SELECT count(*) FROM "GoogleAuth" WHERE
-- "userId" IS NULL` returning 0 against production before it merges. A non-zero
-- count is a BUG REPORT, not routine cleanup — it means something wrote an
-- orphan after #118, and the writer is what needs finding. This statement is
-- deliberately not where that investigation happens; it only stops the deploy
-- being the thing that discovers it.
--
-- WHY THIS REPAIRS RATHER THAN ABORTING (RAISE EXCEPTION), which was raised in
-- review on !255 and is the right question to ask of an irreversible statement:
--
--   * Migrations run ON CONTAINER START in this project (see CLAUDE.md, Stack).
--     A RAISE EXCEPTION here is therefore not "the deploy pauses politely for an
--     investigation" — it is a pod that cannot boot, i.e. an outage, and the
--     investigation then happens under outage pressure. That converts a data
--     anomaly into downtime.
--   * Nothing is lost that anyone could reach. A NULL-userId row is unreachable
--     (every read keys on userId), unrevocable (disconnectGoogle deletes by
--     userId) and uncascadable. Before and after this statement, the owning
--     member sees exactly "Not connected". There is no user-visible difference.
--   * It is not a fresh call. #118 already decided, with owner authorisation,
--     that a NULL-userId credential is DESTROYED rather than adopted, for those
--     same three reasons — see 20260729140000_google_auth_orphan_purge. This
--     migration inherits that decision instead of quietly reversing it.
--
-- The legitimate half of the objection is the audit trail, so that is what got
-- stronger: a count alone told an investigator nothing about WHAT vanished. It
-- now names each row and when it was last written, which is what makes "find the
-- writer" actionable after the fact. It deliberately logs whether a token was
-- PRESENT, never any token material — the columns are ciphertext and a
-- migration log is not the place for it, even encrypted.
--
-- Logged, not silent: exactly as in #118's purge, this destroys real credentials
-- so it says so, loudly. Idempotent — matches zero rows on any re-run.
DO $$
DECLARE
  purged  integer;
  details text;
BEGIN
  WITH removed AS (
    DELETE FROM "GoogleAuth"
     WHERE "userId" IS NULL
    RETURNING "id",
              "updatedAt",
              ("accessToken"  IS NOT NULL) AS had_access,
              ("refreshToken" IS NOT NULL) AS had_refresh
  )
  SELECT count(*)::int,
         string_agg(
           format('%s (updatedAt=%s, hadAccessToken=%s, hadRefreshToken=%s)',
                  "id", "updatedAt", had_access, had_refresh),
           '; ' ORDER BY "updatedAt"
         )
    INTO purged, details
    FROM removed;

  IF purged > 0 THEN
    RAISE WARNING '#122: purged % orphaned GoogleAuth row(s) (userId IS NULL) — the pre-flight was supposed to return 0, so a writer produced these and needs finding: %', purged, details;
  ELSE
    RAISE NOTICE '#122: no orphaned GoogleAuth rows to purge, as expected';
  END IF;
END $$;

-- The one line the issue is actually about. The UNIQUE index and the ON DELETE
-- CASCADE foreign key both already exist (20260727230000_accounts_identity); all
-- that is missing is that the column was allowed to hold no owner at all.
--
-- LOCKING, because this is the other failure mode and it is not the one above.
-- SET NOT NULL takes an ACCESS EXCLUSIVE lock on "GoogleAuth" and full-scans it
-- to re-validate every row, so for the length of that scan it blocks READS as
-- well as writes — including from the old pods still serving during the rolling
-- update. That is a different hazard from an orphan aborting the statement, and
-- the DELETE above does nothing about it.
--
-- It is negligible here, and structurally so rather than by observation:
-- "GoogleAuth_userId_key" is UNIQUE on the column, and the FK cascades from
-- "User", so the table holds AT MOST one row per account and cannot exceed the
-- size of "User". A scan of that is sub-millisecond, and the lock is released
-- when the statement commits.
--
-- Which is why the zero-downtime dance is deliberately NOT used here: the
-- ADD CONSTRAINT ... CHECK ("userId" IS NOT NULL) NOT VALID → VALIDATE CONSTRAINT
-- → SET NOT NULL sequence (Postgres 12+ then skips the scan, because a validated
-- CHECK already proves it) trades one brief exclusive lock for three statements
-- and a permanent redundant constraint. That is the right trade on a table with
-- millions of rows. On one bounded by the account count it is cost without a
-- benefit. Revisit this comment, not just the statement, if that bound ever
-- changes.
ALTER TABLE "GoogleAuth" ALTER COLUMN "userId" SET NOT NULL;
