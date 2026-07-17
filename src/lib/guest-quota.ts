import { createHash } from "crypto";
import { prisma, isUniqueViolation } from "@/lib/db";

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
 *
 * Concurrency (issue #21 P5.1): the per-IP consume is atomic + conditional so
 * the invariant "never more than `quota` consumes per IP per rolling window"
 * holds even when many requests for one IP race. The old read→check→upsert was
 * a TOCTOU: N concurrent callers could each read `used < quota` then all
 * increment, overshooting the quota. See `meterConsume` below.
 */
export async function consumeGuestBreakdown(ipHash: string): Promise<AllowanceResult> {
  const { quota, windowHours, globalCap } = guestQuotaConfig();
  const now = new Date();
  const windowThreshold = new Date(now.getTime() - windowHours * 3600_000);

  // Cheap pre-check of the per-IP window: block an exhausted guest before we
  // reserve a global-cap slot (preserves the original ordering). This read is
  // only an optimisation — the real invariant is enforced by meterConsume.
  const usage = await prisma.guestAiUsage.findUnique({ where: { ipHash } });
  const windowExpired = !!usage && usage.windowStartedAt <= windowThreshold;
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
    } catch (e) {
      // Concurrent insert from the same IP — already counted today; proceed.
      if (!isUniqueViolation(e)) throw e;
    }
  }

  return meterConsume(ipHash, quota, now, windowThreshold);
}

/**
 * Atomically consume one unit of the per-IP rolling window. Each branch is a
 * single conditional statement whose guard Postgres re-evaluates against the
 * locked row, so concurrent callers serialise and the count can never exceed
 * `quota` within an active window.
 */
async function meterConsume(
  ipHash: string,
  quota: number,
  now: Date,
  windowThreshold: Date,
): Promise<AllowanceResult> {
  // 1) Reset an expired window. Exactly one concurrent caller matches the
  //    `windowStartedAt <= threshold` predicate (the row is bumped to `now`).
  const reset = await prisma.guestAiUsage.updateMany({
    where: { ipHash, windowStartedAt: { lte: windowThreshold } },
    data: { count: 1, windowStartedAt: now },
  });
  if (reset.count > 0) return { allowed: true, remaining: Math.max(0, quota - 1) };

  // 2) Guarded increment inside an active window. The `count < quota` guard is
  //    re-checked on the locked row, so at most `quota` increments ever apply.
  const inc = await prisma.guestAiUsage.updateMany({
    where: { ipHash, count: { lt: quota }, windowStartedAt: { gt: windowThreshold } },
    data: { count: { increment: 1 } },
  });
  if (inc.count > 0) {
    return { allowed: true, remaining: await remainingInWindow(ipHash, quota, windowThreshold) };
  }

  // 3) Nothing was incremented: the row is either absent (first use) or the
  //    active window is exhausted. Only pay for a create when the row is truly
  //    absent — otherwise a create would always throw P2002 on every blocked
  //    request (an expired row would already have been reset in step 1).
  const existing = await prisma.guestAiUsage.findUnique({ where: { ipHash } });
  if (!existing) {
    try {
      await prisma.guestAiUsage.create({ data: { ipHash, count: 1, windowStartedAt: now } });
      return { allowed: true, remaining: Math.max(0, quota - 1) };
    } catch (e) {
      if (!isUniqueViolation(e)) throw e;
      // Lost the create race — a concurrent first-use won; fall through to the
      // guarded increment against the row it created.
    }
  }
  // Row exists (present all along, or created concurrently): increment while the
  // active window still has room, else it is genuinely exhausted.
  const retry = await prisma.guestAiUsage.updateMany({
    where: { ipHash, count: { lt: quota }, windowStartedAt: { gt: windowThreshold } },
    data: { count: { increment: 1 } },
  });
  if (retry.count > 0) {
    return { allowed: true, remaining: await remainingInWindow(ipHash, quota, windowThreshold) };
  }
  return { allowed: false, remaining: 0, reason: "quota" };
}

/** Best-effort remaining after a consume (informational; may read a lower value under load). */
async function remainingInWindow(ipHash: string, quota: number, windowThreshold: Date): Promise<number> {
  const row = await prisma.guestAiUsage.findUnique({ where: { ipHash } });
  if (!row) return quota;
  const used = row.windowStartedAt <= windowThreshold ? 0 : row.count;
  return Math.max(0, quota - used);
}

/** Refund one consumed breakdown (e.g. the Claude call failed after metering). Never goes below 0. */
export async function refundGuestBreakdown(ipHash: string): Promise<void> {
  const row = await prisma.guestAiUsage.findUnique({ where: { ipHash } });
  if (row && row.count > 0) {
    await prisma.guestAiUsage.update({ where: { ipHash }, data: { count: { decrement: 1 } } });
  }
}
