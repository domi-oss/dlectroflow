// src/lib/settings-read.ts
import { prisma } from "@/lib/db";

export async function getSettings(workspaceId: string) {
  return prisma.settings.findUnique({ where: { workspaceId } });
}
