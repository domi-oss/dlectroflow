import { PrismaClient } from "@prisma/client";

// Reuse a single PrismaClient across dev HMR reloads to avoid exhausting
// connections (Next.js re-imports modules on every change in development).
const globalForPrisma = globalThis as unknown as {
  prisma?: PrismaClient;
};

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: process.env.NODE_ENV === "development" ? ["error", "warn"] : ["error"],
  });

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = prisma;

/** Fetch (creating on first use) the Settings row for a workspace. */
export function getSettings(workspaceId: string) {
  return prisma.settings.upsert({
    where: { workspaceId },
    create: { id: workspaceId, workspaceId },
    update: {},
  });
}

/** Fetch (creating on first use) the Streak row for a workspace. */
export function getStreak(workspaceId: string) {
  return prisma.streak.upsert({
    where: { workspaceId },
    create: { id: workspaceId, workspaceId },
    update: {},
  });
}
