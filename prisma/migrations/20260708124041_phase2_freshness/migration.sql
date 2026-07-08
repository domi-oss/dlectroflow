-- BrainDumpItem: non-destructive freshness + 24h prompt dismissal
ALTER TABLE "BrainDumpItem" ADD COLUMN "freshenedAt" TIMESTAMP(3);
ALTER TABLE "BrainDumpItem" ADD COLUMN "promptDismissedAt" TIMESTAMP(3);
-- Settings: per-tier freshness thresholds (hours)
ALTER TABLE "Settings" ADD COLUMN "agingHours" INTEGER NOT NULL DEFAULT 4;
ALTER TABLE "Settings" ADD COLUMN "overdueHours" INTEGER NOT NULL DEFAULT 8;
ALTER TABLE "Settings" ADD COLUMN "wayOverdueHours" INTEGER NOT NULL DEFAULT 12;
