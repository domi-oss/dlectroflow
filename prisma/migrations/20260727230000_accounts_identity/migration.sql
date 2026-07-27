-- #35 Phase A — accounts / per-user identity foundation.
--
-- Replaces the owner-binary model (OWNER_WORKSPACE_ID = "owner") with real User
-- records that own workspaces, provisioned only from an invite Allowlist. The
-- data layer was already workspace-scoped, so this migration changes *who a
-- workspace belongs to*, not how content is partitioned.
--
-- Pseudo-enum columns (User.role / User.status / User.aiPolicy) get CHECK
-- constraints mirroring src/lib/constants.ts, kept in lockstep by
-- src/lib/enum-constraint-sync.integration.test.ts (#38 pattern).
--
-- Allowlist.isOwnerSeed is a BOOLEAN, not a role string and emphatically not a
-- sentinel value in `note`: a free-text field deciding a privilege level is a
-- privilege-escalation hole. Only prisma/seed-allowlist.ts sets it.

-- ── New identity tables ───────────────────────────────────────────────────
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "providerSub" TEXT NOT NULL,
    "email" TEXT,
    "handle" TEXT,
    "role" TEXT NOT NULL DEFAULT 'member',
    "status" TEXT NOT NULL DEFAULT 'active',
    "aiPolicy" TEXT NOT NULL DEFAULT 'capped',
    "aiQuota" INTEGER NOT NULL DEFAULT 50,
    "llmProvider" TEXT,
    "llmKeyEnc" TEXT,
    "revokedAt" TIMESTAMP(3),
    "purgeAfter" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "Allowlist" (
    "id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "identity" TEXT NOT NULL,
    "isOwnerSeed" BOOLEAN NOT NULL DEFAULT false,
    "note" TEXT,
    "invitedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "claimedAt" TIMESTAMP(3),
    "claimedById" TEXT,

    CONSTRAINT "Allowlist_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "UserAiUsage" (
    "userId" TEXT NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 0,
    "windowStartedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UserAiUsage_pkey" PRIMARY KEY ("userId")
);

-- ── Workspace: 1:1 back-reference to its owning account ───────────────────
ALTER TABLE "Workspace" ADD COLUMN "userId" TEXT;

-- ── GoogleAuth: the singleton dies here ───────────────────────────────────
-- The pre-accounts install kept ONE GoogleAuth row literally keyed "singleton",
-- guarded only by `workspaceId !== OWNER_WORKSPACE_ID`. Phase A deletes that
-- guard, so leaving the row (and its encrypted refresh token) behind an
-- authorization check that no longer exists is worse than removing it. The rows
-- go, the magic default goes, and `userId` arrives nullable because Phase C is
-- what fills it in. Consequence, accepted in the design: Google Tasks sync is
-- down between the Phase A and Phase C deploys and the owner reconnects once.
DELETE FROM "GoogleAuth";
ALTER TABLE "GoogleAuth" ADD COLUMN "userId" TEXT,
ALTER COLUMN "id" DROP DEFAULT;

-- ── Indexes ───────────────────────────────────────────────────────────────
CREATE INDEX "User_status_purgeAfter_idx" ON "User"("status", "purgeAfter");
CREATE UNIQUE INDEX "User_provider_providerSub_key" ON "User"("provider", "providerSub");
CREATE UNIQUE INDEX "Allowlist_claimedById_key" ON "Allowlist"("claimedById");
CREATE UNIQUE INDEX "Allowlist_provider_identity_key" ON "Allowlist"("provider", "identity");
CREATE UNIQUE INDEX "GoogleAuth_userId_key" ON "GoogleAuth"("userId");
CREATE UNIQUE INDEX "Workspace_userId_key" ON "Workspace"("userId");

-- ── Foreign keys ──────────────────────────────────────────────────────────
-- Allowlist → User is SET NULL: deleting an account must not delete the record
-- that the invitation happened, only the pointer to the claimant.
ALTER TABLE "Allowlist" ADD CONSTRAINT "Allowlist_claimedById_fkey" FOREIGN KEY ("claimedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "UserAiUsage" ADD CONSTRAINT "UserAiUsage_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Workspace" ADD CONSTRAINT "Workspace_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "GoogleAuth" ADD CONSTRAINT "GoogleAuth_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ── CHECK constraints (mirror src/lib/constants.ts) ───────────────────────

-- Workspace.kind ← WorkspaceKind (owner | user | guest).
-- "owner" is retained ONLY for the legacy pre-accounts row that still exists in
-- production: ADD CONSTRAINT re-validates every existing row, so dropping the
-- value here would make this migration fail on deploy. The row is exported and
-- purged by hand in Phase D; the value goes with it.
ALTER TABLE "Workspace" DROP CONSTRAINT "Workspace_kind_check";
ALTER TABLE "Workspace"
  ADD CONSTRAINT "Workspace_kind_check"
  CHECK ("kind" IN ('owner', 'user', 'guest'));

-- User.role ← UserRole (owner | member)
ALTER TABLE "User"
  ADD CONSTRAINT "User_role_check"
  CHECK ("role" IN ('owner', 'member'));

-- User.status ← UserStatus (active | revoked)
ALTER TABLE "User"
  ADD CONSTRAINT "User_status_check"
  CHECK ("status" IN ('active', 'revoked'));

-- User.aiPolicy ← AiPolicy (uncapped | capped | own_key)
ALTER TABLE "User"
  ADD CONSTRAINT "User_aiPolicy_check"
  CHECK ("aiPolicy" IN ('uncapped', 'capped', 'own_key'));
