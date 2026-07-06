-- 1. Workspace table
-- CreateTable
CREATE TABLE "Workspace" (
    "id" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'guest',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Workspace_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Workspace_lastSeenAt_idx" ON "Workspace"("lastSeenAt");

-- 2. Seed the owner workspace
INSERT INTO "Workspace" ("id","kind","createdAt","lastSeenAt")
VALUES ('owner','owner', now(), now())
ON CONFLICT ("id") DO NOTHING;

-- 3. Add workspaceId as NULLABLE first (backfill before NOT NULL)
ALTER TABLE "BrainDumpItem" ADD COLUMN "workspaceId" TEXT;
ALTER TABLE "Task"          ADD COLUMN "workspaceId" TEXT;
ALTER TABLE "FocusSession"  ADD COLUMN "workspaceId" TEXT;
ALTER TABLE "RewardEvent"   ADD COLUMN "workspaceId" TEXT;
ALTER TABLE "StreakRecord"  ADD COLUMN "workspaceId" TEXT;
ALTER TABLE "Badge"         ADD COLUMN "workspaceId" TEXT;
ALTER TABLE "DayRollup"     ADD COLUMN "workspaceId" TEXT;
ALTER TABLE "DailySpark"    ADD COLUMN "workspaceId" TEXT;
ALTER TABLE "Settings"      ADD COLUMN "workspaceId" TEXT;
ALTER TABLE "Streak"        ADD COLUMN "workspaceId" TEXT;

-- 4. Backfill every existing row to the owner workspace
UPDATE "BrainDumpItem" SET "workspaceId"='owner' WHERE "workspaceId" IS NULL;
UPDATE "Task"          SET "workspaceId"='owner' WHERE "workspaceId" IS NULL;
UPDATE "FocusSession"  SET "workspaceId"='owner' WHERE "workspaceId" IS NULL;
UPDATE "RewardEvent"   SET "workspaceId"='owner' WHERE "workspaceId" IS NULL;
UPDATE "StreakRecord"  SET "workspaceId"='owner' WHERE "workspaceId" IS NULL;
UPDATE "Badge"         SET "workspaceId"='owner' WHERE "workspaceId" IS NULL;
UPDATE "DayRollup"     SET "workspaceId"='owner' WHERE "workspaceId" IS NULL;
UPDATE "DailySpark"    SET "workspaceId"='owner' WHERE "workspaceId" IS NULL;
UPDATE "Settings"      SET "workspaceId"='owner' WHERE "workspaceId" IS NULL;
UPDATE "Streak"        SET "workspaceId"='owner' WHERE "workspaceId" IS NULL;

-- 5. Enforce NOT NULL now that data is backfilled
ALTER TABLE "BrainDumpItem" ALTER COLUMN "workspaceId" SET NOT NULL;
ALTER TABLE "Task"          ALTER COLUMN "workspaceId" SET NOT NULL;
ALTER TABLE "FocusSession"  ALTER COLUMN "workspaceId" SET NOT NULL;
ALTER TABLE "RewardEvent"   ALTER COLUMN "workspaceId" SET NOT NULL;
ALTER TABLE "StreakRecord"  ALTER COLUMN "workspaceId" SET NOT NULL;
ALTER TABLE "Badge"         ALTER COLUMN "workspaceId" SET NOT NULL;
ALTER TABLE "DayRollup"     ALTER COLUMN "workspaceId" SET NOT NULL;
ALTER TABLE "DailySpark"    ALTER COLUMN "workspaceId" SET NOT NULL;
ALTER TABLE "Settings"      ALTER COLUMN "workspaceId" SET NOT NULL;
ALTER TABLE "Streak"        ALTER COLUMN "workspaceId" SET NOT NULL;

-- 6. Drop old single-column unique indexes that are being replaced
-- DropIndex
DROP INDEX "DayRollup_date_key";

-- DropIndex
DROP INDEX "Badge_key_key";

-- DropIndex
DROP INDEX "DailySpark_date_key";

-- 7. Create new indexes and unique constraints
-- CreateIndex
CREATE INDEX "BrainDumpItem_workspaceId_idx" ON "BrainDumpItem"("workspaceId");

-- CreateIndex
CREATE INDEX "Task_workspaceId_idx" ON "Task"("workspaceId");

-- CreateIndex
CREATE INDEX "FocusSession_workspaceId_idx" ON "FocusSession"("workspaceId");

-- CreateIndex
CREATE INDEX "RewardEvent_workspaceId_idx" ON "RewardEvent"("workspaceId");

-- CreateIndex
CREATE INDEX "StreakRecord_workspaceId_idx" ON "StreakRecord"("workspaceId");

-- CreateIndex
CREATE INDEX "Badge_workspaceId_idx" ON "Badge"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "Badge_workspaceId_key_key" ON "Badge"("workspaceId", "key");

-- CreateIndex
CREATE UNIQUE INDEX "DayRollup_workspaceId_date_key" ON "DayRollup"("workspaceId", "date");

-- CreateIndex
CREATE UNIQUE INDEX "DailySpark_workspaceId_date_key" ON "DailySpark"("workspaceId", "date");

-- CreateIndex
CREATE UNIQUE INDEX "Settings_workspaceId_key" ON "Settings"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "Streak_workspaceId_key" ON "Streak"("workspaceId");
