-- AlterTable
ALTER TABLE "Settings" ADD COLUMN     "dailyReviewNudgeTime" TEXT NOT NULL DEFAULT '17:00',
ADD COLUMN     "notifyAging" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "notifyDailyReview" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "notifyRoundup" BOOLEAN NOT NULL DEFAULT true;
