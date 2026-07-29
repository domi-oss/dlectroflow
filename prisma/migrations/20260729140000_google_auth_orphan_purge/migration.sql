-- #118 Phase C — the pre-accounts Google credential is destroyed, not adopted.
--
-- BACKGROUND, because the schema comment was wrong about this until #119. Phase
-- A dropped the `@default("singleton")` id and DELETEd every row, but
-- src/lib/google.ts kept passing `id: 'singleton'` explicitly from application
-- code, so one instance-wide row was re-created on the next read and Google
-- Tasks sync never went down. What production therefore holds today is a row
-- with `userId = NULL` carrying REAL encrypted access + refresh tokens.
--
-- Phase C keys every read and write on `userId`. That makes this row:
--
--   * unreachable  — findUnique({ where: { userId } }) never matches it, and the
--                    UI reports a plain "Not connected" rather than an error;
--   * unrevocable  — disconnectGoogle's deleteMany({ where: { userId } }) does
--                    not match it either;
--   * uncascadable — the FK cascades FROM User, and a NULL userId never reaches
--                    a User row. Deleting every account would leave it behind.
--
-- So the choice is "bind it to the owner" or "destroy it". DESTROY, per the
-- owner's decision on #118: it removes a stale credential instead of silently
-- keeping one nobody can reach or revoke, and it matches the design's own
-- "the owner is starting fresh anyway and would have had to reconnect
-- regardless" posture (spec §Rollout). Cost is one manual reconnect, once,
-- after this deploy. That reconnect is a RELEASE STEP - see the plan's
-- "Post-deploy" checklist.
--
-- Ordering note: this runs AFTER the application code stopped writing
-- `id: 'singleton'` (same MR). Nothing re-creates the row.
--
-- Repair-before-enforce (see 20260727194512_step_est_minutes_check): this is the
-- repair half. `userId` deliberately stays NULLABLE in this release - see the
-- plan's Decision 2: the code being replaced writes a NULL userId on every page
-- load, so a SET NOT NULL applied while old pods still serve a rolling update
-- would 500 the inbox for the length of the rollout. The structural guard is
-- src/lib/__tests__/scoping.harness.test.ts, which fails in CI instead.
--
-- Logged, not silent: this destroys real credentials, so it says how many.
DO $$
DECLARE
  purged integer;
BEGIN
  DELETE FROM "GoogleAuth" WHERE "userId" IS NULL;
  GET DIAGNOSTICS purged = ROW_COUNT;
  RAISE NOTICE '#118: purged % orphaned GoogleAuth row(s) (userId IS NULL)', purged;
END $$;

-- ── User.llmProvider ← LlmProvider (anthropic | openai-compatible) ──────────
--
-- Phase C makes `llmKeyEnc` writable from the UI, which makes this column's
-- null-vs-value distinction load-bearing for the first time: user-quota.ts hands
-- it to getLLM(), which selects an ADAPTER from it and falls back to
-- LLM_PROVIDER for anything unrecognised. So a bad value is not a crash - it is
-- an account billed to its own key against the wrong vendor's endpoint. NULL
-- stays legal and means "use the instance default".
--
-- Mirrors LlmProvider in src/lib/constants.ts and is registered in
-- src/lib/enum-constraint-sync.integration.test.ts, so dropping it out of band
-- fails the suite.

-- Repair first. Nothing in the repo writes this column today, so this is
-- expected to match zero rows; it exists so a hand-edited value REPAIRS to the
-- documented default instead of wedging `prisma migrate deploy` halfway.
-- Idempotent: matches zero rows on any re-run.
UPDATE "User"
   SET "llmProvider" = NULL
 WHERE "llmProvider" IS NOT NULL
   AND "llmProvider" NOT IN ('anthropic', 'openai-compatible');

ALTER TABLE "User"
  ADD CONSTRAINT "User_llmProvider_check"
  CHECK ("llmProvider" IS NULL OR "llmProvider" IN ('anthropic', 'openai-compatible'));
