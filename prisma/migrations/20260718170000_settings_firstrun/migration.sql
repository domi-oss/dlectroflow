-- AlterTable
ALTER TABLE "Settings" ADD COLUMN "welcomeDismissedAt" TIMESTAMP(3);
ALTER TABLE "Settings" ADD COLUMN "firstRunPreview" BOOLEAN NOT NULL DEFAULT false;
