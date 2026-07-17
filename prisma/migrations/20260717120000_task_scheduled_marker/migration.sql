-- AlterTable: provider-agnostic "scheduled" marker (S0, epic #29)
ALTER TABLE "Task" ADD COLUMN     "scheduledAt" TIMESTAMP(3),
ADD COLUMN     "scheduledVia" TEXT;
