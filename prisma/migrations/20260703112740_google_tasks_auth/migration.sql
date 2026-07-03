-- AlterTable
ALTER TABLE "Step" ADD COLUMN "googleTaskId" TEXT;
ALTER TABLE "Step" ADD COLUMN "googleTaskListId" TEXT;

-- CreateTable
CREATE TABLE "GoogleAuth" (
    "id" TEXT NOT NULL PRIMARY KEY DEFAULT 'singleton',
    "accessToken" TEXT,
    "refreshToken" TEXT,
    "expiresAt" DATETIME,
    "scope" TEXT,
    "updatedAt" DATETIME NOT NULL
);
