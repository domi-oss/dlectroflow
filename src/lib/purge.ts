import { prisma } from "@/lib/db";
import { OWNER_WORKSPACE_ID } from "@/lib/constants";

export function guestSandboxTtlHours(): number {
  return Number(process.env.GUEST_SANDBOX_TTL_HOURS ?? 24);
}

/** Delete every workspace-scoped row for a guest workspace, then the row. */
export async function purgeWorkspace(id: string): Promise<void> {
  if (id === OWNER_WORKSPACE_ID) throw new Error("refusing to purge the owner workspace");
  await prisma.$transaction(async (tx) => {
    const w = { workspaceId: id };
    // Children first (Step/BreakdownTurn cascade from Task; delete explicitly to be safe).
    await tx.step.deleteMany({ where: { task: { workspaceId: id } } });
    await tx.breakdownTurn.deleteMany({ where: { task: { workspaceId: id } } });
    await tx.brainDumpItem.deleteMany({ where: w });
    await tx.focusSession.deleteMany({ where: w });
    await tx.dayRollup.deleteMany({ where: w });
    await tx.rewardEvent.deleteMany({ where: w });
    await tx.streak.deleteMany({ where: w });
    await tx.streakRecord.deleteMany({ where: w });
    await tx.badge.deleteMany({ where: w });
    await tx.dailySpark.deleteMany({ where: w });
    await tx.settings.deleteMany({ where: w });
    await tx.task.deleteMany({ where: w });
    await tx.workspace.delete({ where: { id } });
  });
}

/** Opportunistic purge of guest workspaces past their TTL. Returns count successfully purged. */
export async function purgeExpiredGuests(): Promise<number> {
  const expired = await prisma.workspace.findMany({
    where: { kind: "guest", expiresAt: { lt: new Date() } },
    select: { id: true },
    take: 25, // bound the work per call
  });
  let purged = 0;
  for (const w of expired) {
    try { await purgeWorkspace(w.id); purged++; }
    catch { /* best-effort; skip on error */ }
  }
  return purged;
}
