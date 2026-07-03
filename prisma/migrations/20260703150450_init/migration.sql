-- CreateTable
CREATE TABLE "Settings" (
    "id" TEXT NOT NULL DEFAULT 'singleton',
    "agingThresholdMinutes" INTEGER NOT NULL DEFAULT 240,
    "demoOverrideSeconds" INTEGER,
    "defaultFromEstimate" BOOLEAN NOT NULL DEFAULT true,
    "addTimeIncrementMin" INTEGER NOT NULL DEFAULT 5,
    "workdayEndTime" TEXT NOT NULL DEFAULT '17:00',
    "roundupDemoOverride" BOOLEAN NOT NULL DEFAULT false,
    "roundupEmailEnabled" BOOLEAN NOT NULL DEFAULT false,
    "roundupEmail" TEXT,
    "workingDays" TEXT NOT NULL DEFAULT '1,2,3,4,5',
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReclaimAuth" (
    "id" TEXT NOT NULL DEFAULT 'singleton',
    "clientId" TEXT,
    "clientSecret" TEXT,
    "redirectUri" TEXT,
    "accessToken" TEXT,
    "refreshToken" TEXT,
    "expiresAt" TIMESTAMP(3),
    "scope" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ReclaimAuth_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GoogleAuth" (
    "id" TEXT NOT NULL DEFAULT 'singleton',
    "accessToken" TEXT,
    "refreshToken" TEXT,
    "expiresAt" TIMESTAMP(3),
    "scope" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GoogleAuth_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BrainDumpItem" (
    "id" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "status" TEXT NOT NULL DEFAULT 'inbox',
    "triagedAt" TIMESTAMP(3),
    "remindedAt" TIMESTAMP(3),
    "snoozedUntil" TIMESTAMP(3),
    "taskId" TEXT,

    CONSTRAINT "BrainDumpItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Task" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'braindump',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "status" TEXT NOT NULL DEFAULT 'active',
    "parentEmoji" TEXT,

    CONSTRAINT "Task_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Step" (
    "id" TEXT NOT NULL,
    "taskId" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "order" INTEGER NOT NULL,
    "total" INTEGER NOT NULL,
    "estMinutes" INTEGER NOT NULL,
    "subtaskEmoji" TEXT,
    "reclaimTaskId" TEXT,
    "googleTaskId" TEXT,
    "googleTaskListId" TEXT,
    "scheduledAt" TIMESTAMP(3),
    "done" BOOLEAN NOT NULL DEFAULT false,
    "estimateHistory" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Step_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BreakdownTurn" (
    "id" TEXT NOT NULL,
    "taskId" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "proposedSteps" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BreakdownTurn_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FocusSession" (
    "id" TEXT NOT NULL,
    "stepId" TEXT,
    "taskId" TEXT,
    "plannedMin" INTEGER NOT NULL,
    "addedMin" INTEGER NOT NULL DEFAULT 0,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endedAt" TIMESTAMP(3),
    "durationMin" INTEGER,
    "outcome" TEXT,
    "reclaimSynced" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "FocusSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DayRollup" (
    "id" TEXT NOT NULL,
    "date" TEXT NOT NULL,
    "focusMin" INTEGER NOT NULL DEFAULT 0,
    "sessions" INTEGER NOT NULL DEFAULT 0,
    "stepsDone" INTEGER NOT NULL DEFAULT 0,
    "pointsEarned" INTEGER NOT NULL DEFAULT 0,
    "streakDay" INTEGER NOT NULL DEFAULT 0,
    "narrative" TEXT,
    "emailedAt" TIMESTAMP(3),

    CONSTRAINT "DayRollup_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RewardEvent" (
    "id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "points" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RewardEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Streak" (
    "id" TEXT NOT NULL DEFAULT 'singleton',
    "current" INTEGER NOT NULL DEFAULT 0,
    "lastActiveWorkday" TEXT,

    CONSTRAINT "Streak_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StreakRecord" (
    "id" TEXT NOT NULL,
    "length" INTEGER NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL,
    "endedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StreakRecord_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Badge" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "earnedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Badge_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DailySpark" (
    "id" TEXT NOT NULL,
    "date" TEXT NOT NULL,
    "quote" TEXT NOT NULL,
    "source" TEXT NOT NULL,

    CONSTRAINT "DailySpark_pkey" PRIMARY KEY ("id")
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

-- AddForeignKey
ALTER TABLE "BrainDumpItem" ADD CONSTRAINT "BrainDumpItem_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "Task"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Step" ADD CONSTRAINT "Step_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "Task"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BreakdownTurn" ADD CONSTRAINT "BreakdownTurn_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "Task"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FocusSession" ADD CONSTRAINT "FocusSession_stepId_fkey" FOREIGN KEY ("stepId") REFERENCES "Step"("id") ON DELETE SET NULL ON UPDATE CASCADE;
