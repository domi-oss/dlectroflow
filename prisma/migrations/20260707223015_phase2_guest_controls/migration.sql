-- AlterTable
ALTER TABLE "Settings" ADD COLUMN     "breakdownModel" TEXT;

-- AlterTable
ALTER TABLE "Workspace" ADD COLUMN     "expiresAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "GuestAiUsage" (
    "ipHash" TEXT NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 0,
    "windowStartedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GuestAiUsage_pkey" PRIMARY KEY ("ipHash")
);

-- CreateTable
CREATE TABLE "GuestDailyActivity" (
    "day" TEXT NOT NULL,
    "ipHash" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GuestDailyActivity_pkey" PRIMARY KEY ("day","ipHash")
);

-- CreateIndex
CREATE INDEX "GuestDailyActivity_day_idx" ON "GuestDailyActivity"("day");
