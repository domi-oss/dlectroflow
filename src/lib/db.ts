import { PrismaClient, Prisma } from "@prisma/client";

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

/** True when the error is a Prisma unique-constraint violation (P2002). */
export function isUniqueViolation(e: unknown): boolean {
  return (
    e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002"
  );
}

/**
 * Fetch (creating on first use) the Settings row for a workspace.
 *
 * The upsert's create sets both the `id` PK and the unique `workspaceId`, so
 * Prisma can't express it as a single atomic INSERT ... ON CONFLICT. Two
 * concurrent first-use calls for the same workspace (e.g. the app layout and a
 * page both reading settings in one request) can therefore race and one loses
 * with P2002. The row exists by then, so re-fetch instead of failing.
 */
export async function getSettings(workspaceId: string) {
  try {
    return await prisma.settings.upsert({
      where: { workspaceId },
      create: { id: workspaceId, workspaceId },
      update: {},
    });
  } catch (e) {
    if (isUniqueViolation(e)) {
      const existing = await prisma.settings.findUnique({
        where: { workspaceId },
      });
      if (existing) return existing;
    }
    throw e;
  }
}

/** Fetch (creating on first use) the Streak row for a workspace. Race-safe (see getSettings). */
export async function getStreak(workspaceId: string) {
  try {
    return await prisma.streak.upsert({
      where: { workspaceId },
      create: { id: workspaceId, workspaceId },
      update: {},
    });
  } catch (e) {
    if (isUniqueViolation(e)) {
      const existing = await prisma.streak.findUnique({
        where: { workspaceId },
      });
      if (existing) return existing;
    }
    throw e;
  }
}
