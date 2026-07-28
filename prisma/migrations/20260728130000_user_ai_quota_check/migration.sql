-- #35 Phase B — User.aiQuota is now owner-editable, so bound it in the DB.
--
-- Phase A added the column with a default of 50 and nothing ever wrote it. The
-- People panel changes that: a number input is now the thing that decides how
-- much of the instance's AI budget an account may spend. `updatePersonAiPolicy`
-- clamps to [0, 10000] before writing, and this constraint is what stops a
-- FUTURE writer (a script, a fixture, a second admin surface) from skipping that
-- clamp — the same reasoning as Step_estMinutes_check (#78).
--
-- Zero is deliberately allowed: "capped at zero" is a legitimate state, meaning
-- "no instance-funded AI for this account". Negative is not, because a negative
-- quota reads as an allowance while behaving as a permanent block.
--
-- Registered in src/lib/enum-constraint-sync.integration.test.ts's
-- RANGE_REGISTRY, which pins the bound this migration declares.

ALTER TABLE "User"
  ADD CONSTRAINT "User_aiQuota_check"
  CHECK ("aiQuota" >= 0);
