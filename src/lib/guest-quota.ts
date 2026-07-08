import { createHash } from "crypto";
import { prisma } from "@/lib/db";

export function guestQuotaConfig() {
  return {
    quota: Number(process.env.GUEST_AI_QUOTA_PER_WINDOW || "5"),
    windowHours: Number(process.env.GUEST_AI_WINDOW_HOURS || "24"),
    globalCap: Number(process.env.GUEST_GLOBAL_DAILY_GUEST_CAP || "10"),
  };
}

/** Salted SHA-256 of the client IP; never store the raw IP. */
export function clientIpHash(headers: Headers): string | null {
  const xff = headers.get("x-forwarded-for");
  const ip = (xff ? xff.split(",")[0] : headers.get("x-real-ip"))?.trim();
  if (!ip) return null;
  const salt = process.env.GUEST_IP_HASH_SALT ?? "";
  if (!salt && process.env.NODE_ENV !== "test" && process.env.NODE_ENV !== "production") {
    console.warn("[guest-quota] GUEST_IP_HASH_SALT is not set — IP hashing provides no privacy");
  }
  return createHash("sha256").update(salt + ip).digest("hex");
}

function utcDay(d = new Date()): string {
  return d.toISOString().slice(0, 10); // YYYY-MM-DD (UTC)
}

export type AllowanceResult = {
  allowed: boolean;
  remaining: number;
  reason?: "quota" | "global_cap";
};

/** Read-only remaining allowance for the chip (does not consume). */
export async function peekGuestAllowance(ipHash: string): Promise<{ remaining: number }> {
  const { quota, windowHours } = guestQuotaConfig();
  const row = await prisma.guestAiUsage.findUnique({ where: { ipHash } });
  if (!row) return { remaining: quota };
  const expired = Date.now() - row.windowStartedAt.getTime() >= windowHours * 3600_000;
  const used = expired ? 0 : row.count;
  return { remaining: Math.max(0, quota - used) };
}

/**
 * Enforce the per-IP rolling window AND the global distinct-guest daily cap,
 * incrementing on success. Order: check per-IP window first; then, for a guest
 * not yet counted today, check the global cap; then record + increment.
 */
export async function consumeGuestBreakdown(ipHash: string): Promise<AllowanceResult> {
  const { quota, windowHours, globalCap } = guestQuotaConfig();
  const now = new Date();

  const usage = await prisma.guestAiUsage.findUnique({ where: { ipHash } });
  const windowExpired =
    !!usage && now.getTime() - usage.windowStartedAt.getTime() >= windowHours * 3600_000;
  const used = !usage || windowExpired ? 0 : usage.count;

  if (used >= quota) return { allowed: false, remaining: 0, reason: "quota" };

  // Global cap: only gates guests who have NOT already used AI today.
  const day = utcDay(now);
  const countedToday = await prisma.guestDailyActivity.findUnique({
    where: { day_ipHash: { day, ipHash } },
  });
  if (!countedToday) {
    const distinct = await prisma.guestDailyActivity.count({ where: { day } });
    if (distinct >= globalCap) return { allowed: false, remaining: quota - used, reason: "global_cap" };
    try {
      await prisma.guestDailyActivity.create({ data: { day, ipHash } });
    } catch {
      // Concurrent insert from same IP — already counted today; proceed.
    }
  }

  const newCount = used + 1;
  await prisma.guestAiUsage.upsert({
    where: { ipHash },
    create: { ipHash, count: newCount, windowStartedAt: now },
    update: windowExpired
      ? { count: newCount, windowStartedAt: now }
      : { count: { increment: 1 } },
  });

  return { allowed: true, remaining: Math.max(0, quota - newCount) };
}
