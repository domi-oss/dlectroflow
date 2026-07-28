-- #35 Phase B — repair the owner's AI policy before enforcement starts.
--
-- The owner's design decision (#35, "who pays for AI") is that the instance
-- owner's own account is UNCAPPED and invited members are capped until they
-- bring their own key. Phase A's provisioning left `aiPolicy` to the schema
-- default, so the live instance's owner row was created `capped`:
--
--   { role: "owner", status: "active", aiPolicy: "capped", handle: "…" }
--
-- That was harmless only because nothing enforced the cap. THIS RELEASE IS WHAT
-- ENFORCES IT — without this repair the owner would start hitting a 50-breakdown
-- rolling cap on their own instance the moment Phase B deploys.
--
-- src/lib/auth/provisioning.ts now sets the policy explicitly at creation, so a
-- fresh deploy is correct without this. This statement exists solely for
-- instances provisioned by Phase A.
--
-- Scoped to rows still carrying the DEFAULT value, so an owner who is
-- deliberately capped or on their own key is left alone. Migrations run once, so
-- a later hand-set policy is never re-asserted.

UPDATE "User"
   SET "aiPolicy" = 'uncapped'
 WHERE "role" = 'owner'
   AND "aiPolicy" = 'capped';
