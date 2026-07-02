-- CreateTable
CREATE TABLE "ReclaimAuth" (
    "id" TEXT NOT NULL PRIMARY KEY DEFAULT 'singleton',
    "clientId" TEXT,
    "clientSecret" TEXT,
    "accessToken" TEXT,
    "refreshToken" TEXT,
    "expiresAt" DATETIME,
    "scope" TEXT,
    "updatedAt" DATETIME NOT NULL
);
