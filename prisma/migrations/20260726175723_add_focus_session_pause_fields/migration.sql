-- AlterTable
ALTER TABLE "FocusSession" ADD COLUMN     "accumulatedPausedMs" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "pausedAt" TIMESTAMP(3);
