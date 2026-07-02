import { PrismaClient } from "@prisma/client";
import { SINGLETON_ID } from "@/lib/constants";

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

/** Fetch (creating on first use) the singleton Settings row. */
export function getSettings() {
  return prisma.settings.upsert({
    where: { id: SINGLETON_ID },
    create: { id: SINGLETON_ID },
    update: {},
  });
}

/** Fetch (creating on first use) the singleton Streak row. */
export function getStreak() {
  return prisma.streak.upsert({
    where: { id: SINGLETON_ID },
    create: { id: SINGLETON_ID },
    update: {},
  });
}
