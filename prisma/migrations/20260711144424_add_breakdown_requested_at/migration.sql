-- AlterTable
ALTER TABLE "BrainDumpItem" ADD COLUMN     "breakdownRequestedAt" TIMESTAMP(3),
ALTER COLUMN "completedAt" SET DATA TYPE TIMESTAMP(3);
