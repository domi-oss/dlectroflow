-- CreateTable
CREATE TABLE "Settings" (
    "id" TEXT NOT NULL PRIMARY KEY DEFAULT 'singleton',
    "agingThresholdMinutes" INTEGER NOT NULL DEFAULT 240,
    "demoOverrideSeconds" INTEGER,
    "defaultFromEstimate" BOOLEAN NOT NULL DEFAULT true,
    "addTimeIncrementMin" INTEGER NOT NULL DEFAULT 5,
    "workdayEndTime" TEXT NOT NULL DEFAULT '17:00',
    "roundupDemoOverride" BOOLEAN NOT NULL DEFAULT false,
    "roundupEmailEnabled" BOOLEAN NOT NULL DEFAULT false,
    "roundupEmail" TEXT,
    "workingDays" TEXT NOT NULL DEFAULT '1,2,3,4,5',
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "BrainDumpItem" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "text" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "status" TEXT NOT NULL DEFAULT 'inbox',
    "triagedAt" DATETIME,
    "remindedAt" DATETIME,
    "snoozedUntil" DATETIME,
    "taskId" TEXT,
    CONSTRAINT "BrainDumpItem_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "Task" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Task" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "title" TEXT NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'braindump',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "status" TEXT NOT NULL DEFAULT 'active',
    "parentEmoji" TEXT
);

-- CreateTable
CREATE TABLE "Step" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "taskId" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "order" INTEGER NOT NULL,
    "total" INTEGER NOT NULL,
    "estMinutes" INTEGER NOT NULL,
    "subtaskEmoji" TEXT,
    "reclaimTaskId" TEXT,
    "scheduledAt" DATETIME,
    "done" BOOLEAN NOT NULL DEFAULT false,
    "estimateHistory" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Step_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "Task" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "BreakdownTurn" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "taskId" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "proposedSteps" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "BreakdownTurn_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "Task" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "FocusSession" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "stepId" TEXT,
    "taskId" TEXT,
    "plannedMin" INTEGER NOT NULL,
    "addedMin" INTEGER NOT NULL DEFAULT 0,
    "startedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endedAt" DATETIME,
    "durationMin" INTEGER,
    "outcome" TEXT,
    "reclaimSynced" BOOLEAN NOT NULL DEFAULT false,
    CONSTRAINT "FocusSession_stepId_fkey" FOREIGN KEY ("stepId") REFERENCES "Step" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "DayRollup" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "date" TEXT NOT NULL,
    "focusMin" INTEGER NOT NULL DEFAULT 0,
    "sessions" INTEGER NOT NULL DEFAULT 0,
    "stepsDone" INTEGER NOT NULL DEFAULT 0,
    "pointsEarned" INTEGER NOT NULL DEFAULT 0,
    "streakDay" INTEGER NOT NULL DEFAULT 0,
    "narrative" TEXT,
    "emailedAt" DATETIME
);

-- CreateTable
CREATE TABLE "RewardEvent" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "type" TEXT NOT NULL,
    "points" INTEGER NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "Streak" (
    "id" TEXT NOT NULL PRIMARY KEY DEFAULT 'singleton',
    "current" INTEGER NOT NULL DEFAULT 0,
    "lastActiveWorkday" TEXT
);

-- CreateTable
CREATE TABLE "StreakRecord" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "length" INTEGER NOT NULL,
    "startedAt" DATETIME NOT NULL,
    "endedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "Badge" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "key" TEXT NOT NULL,
    "earnedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "DailySpark" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "date" TEXT NOT NULL,
    "quote" TEXT NOT NULL,
    "source" TEXT NOT NULL
);

-- CreateIndex
CREATE INDEX "BrainDumpItem_status_idx" ON "BrainDumpItem"("status");

-- CreateIndex
CREATE INDEX "Step_taskId_idx" ON "Step"("taskId");

-- CreateIndex
CREATE INDEX "BreakdownTurn_taskId_idx" ON "BreakdownTurn"("taskId");

-- CreateIndex
CREATE INDEX "FocusSession_stepId_idx" ON "FocusSession"("stepId");

-- CreateIndex
CREATE UNIQUE INDEX "DayRollup_date_key" ON "DayRollup"("date");

-- CreateIndex
CREATE INDEX "RewardEvent_createdAt_idx" ON "RewardEvent"("createdAt");

-- CreateIndex
CREATE INDEX "StreakRecord_length_idx" ON "StreakRecord"("length");

-- CreateIndex
CREATE UNIQUE INDEX "Badge_key_key" ON "Badge"("key");

-- CreateIndex
CREATE UNIQUE INDEX "DailySpark_date_key" ON "DailySpark"("date");
