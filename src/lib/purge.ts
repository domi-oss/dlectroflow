import { prisma } from "@/lib/db";
import { OWNER_WORKSPACE_ID } from "@/lib/constants";

export function guestSandboxTtlHours(): number {
  return Number(process.env.GUEST_SANDBOX_TTL_HOURS ?? 24);
}

/** Delete a guest workspace. All workspace-scoped rows (Settings, Streak,
 * BrainDumpItem, Task, FocusSession, DayRollup, RewardEvent, StreakRecord,
 * Badge, DailySpark) cascade via their workspaceId FK; Step/BreakdownTurn
 * cascade transitively through Task. See
 * prisma/migrations/20260718180000_workspace_cascade_fks. */
export async function purgeWorkspace(id: string): Promise<void> {
  if (id === OWNER_WORKSPACE_ID) throw new Error("refusing to purge the owner workspace");
  await prisma.workspace.delete({ where: { id } });
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

/** Purge ipHash-keyed guest counters older than `days` (default 30). These are
 * not workspace-scoped (keyed by IP hash), so they need age-based retention. */
export async function purgeStaleGuestCounters(
  now: Date = new Date(),
  days = 30,
): Promise<{ dailyActivity: number; aiUsage: number }> {
  const cutoff = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
  const cutoffDay = cutoff.toISOString().slice(0, 10); // YYYY-MM-DD (day column is UTC date string)
  const [daily, ai] = await prisma.$transaction([
    prisma.guestDailyActivity.deleteMany({ where: { day: { lt: cutoffDay } } }),
    prisma.guestAiUsage.deleteMany({ where: { updatedAt: { lt: cutoff } } }),
  ]);
  return { dailyActivity: daily.count, aiUsage: ai.count };
}
