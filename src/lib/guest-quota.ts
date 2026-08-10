import { createHash } from "crypto";
import { prisma } from "@/lib/db";
import {
  meterConsume,
  usedInWindow,
  type SlidingWindowStore,
} from "@/lib/sliding-window-meter";

export function guestQuotaConfig() {
  return {
    quota: Number(process.env.GUEST_AI_QUOTA_PER_WINDOW || "5"),
    windowHours: Number(process.env.GUEST_AI_WINDOW_HOURS || "24"),
    globalCap: Number(process.env.GUEST_GLOBAL_DAILY_GUEST_CAP || "10"),
  };
}

/**
 * Salted SHA-256 of the client IP; never store the raw IP.
 *
 * Item 9 (#21 P5 batch B): trust the RIGHT-MOST x-forwarded-for hop — the value
 * appended by our trusted ingress — not the LEFT-MOST, which is client-supplied
 * and spoofable (a guest could forge it to rotate the per-IP quota key). Falls
 * back to x-real-ip.
 *
 * ⚠️ CLUSTER-CONFIG ASSUMPTION (owner must verify): this is only correct if the
 * ingress produces a trustworthy right-most XFF hop / x-real-ip — i.e.
 * ingress-nginx `use-forwarded-headers` is false (or the trusted-hop count is
 * configured) so inbound client-supplied XFF is not preserved on the left, and
 * no upstream L4 LB hides the real client. If the ingress trusts inbound XFF,
 * revisit this derivation.
 */
export function clientIpHash(headers: Headers): string | null {
  const ip = clientIp(headers);
  if (!ip) return null;
  const salt = process.env.GUEST_IP_HASH_SALT ?? "";
  if (
    !salt &&
    process.env.NODE_ENV !== "test" &&
    process.env.NODE_ENV !== "production"
  ) {
    console.warn(
      "[guest-quota] GUEST_IP_HASH_SALT is not set — IP hashing provides no privacy",
    );
  }
  return createHash("sha256")
    .update(salt + ip)
    .digest("hex");
}

/**
 * Resolve the trustworthy client IP: the RIGHT-MOST x-forwarded-for hop (added
 * by the trusted ingress), else x-real-ip. See clientIpHash for the topology
 * assumption the deployment must satisfy.
 */
function clientIp(headers: Headers): string | null {
  const xff = headers.get("x-forwarded-for");
  if (xff) {
    const hops = xff
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (hops.length) return hops[hops.length - 1];
  }
  return headers.get("x-real-ip")?.trim() || null;
}

function utcDay(d = new Date()): string {
  return d.toISOString().slice(0, 10); // YYYY-MM-DD (UTC)
}

export type AllowanceResult = {
  allowed: boolean;
  remaining: number;
  reason?: "quota" | "global_cap";
};

/**
 * The four statements the shared sliding-window meter needs, bound to one
 * ipHash. Extracted with the meter itself in #35 Phase B — the per-user cap
 * supplies the same shape against `UserAiUsage`, so the ordering rules and the
 * concurrency guards live in exactly one place (see sliding-window-meter.ts).
 */
function guestMeterStore(ipHash: string): SlidingWindowStore {
  return {
    find: () => prisma.guestAiUsage.findUnique({ where: { ipHash } }),
    resetExpired: async (now, threshold) =>
      (
        await prisma.guestAiUsage.updateMany({
          where: { ipHash, windowStartedAt: { lte: threshold } },
          data: { count: 1, windowStartedAt: now },
        })
      ).count,
    incrementInWindow: async (quota, threshold) =>
      (
        await prisma.guestAiUsage.updateMany({
          where: {
            ipHash,
            // `null` = no limit was consulted: the clause is OMITTED rather than
            // given a large bound (see meterRecord).
            ...(quota === null ? {} : { count: { lt: quota } }),
            windowStartedAt: { gt: threshold },
          },
          data: { count: { increment: 1 } },
        })
      ).count,
    createFirstUse: async (now) =>
      (
        await prisma.guestAiUsage.createMany({
          data: { ipHash, count: 1, windowStartedAt: now },
          // ON CONFLICT DO NOTHING: a concurrent first use for this IP gets
          // `count: 0` instead of a P2002 the meter would have to catch — and
          // that Prisma would have printed at error level first (#158).
          skipDuplicates: true,
        })
      ).count === 1,
  };
}

/** Read-only remaining allowance for the chip (does not consume). */
export async function peekGuestAllowance(
  ipHash: string,
): Promise<{ remaining: number }> {
  const { quota, windowHours } = guestQuotaConfig();
  const row = await prisma.guestAiUsage.findUnique({ where: { ipHash } });
  if (!row) return { remaining: quota };
  const threshold = new Date(Date.now() - windowHours * 3600_000);
  return { remaining: Math.max(0, quota - usedInWindow(row, threshold)) };
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
export async function consumeGuestBreakdown(
  ipHash: string,
): Promise<AllowanceResult> {
  const { quota, windowHours, globalCap } = guestQuotaConfig();
  const now = new Date();
  const windowThreshold = new Date(now.getTime() - windowHours * 3600_000);

  const store = guestMeterStore(ipHash);

  // Cheap pre-check of the per-IP window: block an exhausted guest before we
  // reserve a global-cap slot (preserves the original ordering). This read is
  // only an optimisation — the real invariant is enforced by meterConsume.
  const usage = await store.find();
  const used = usedInWindow(usage, windowThreshold);
  if (used >= quota) return { allowed: false, remaining: 0, reason: "quota" };

  // Global cap: only gates guests who have NOT already used AI today.
  const day = utcDay(now);
  const countedToday = await prisma.guestDailyActivity.findUnique({
    where: { day_ipHash: { day, ipHash } },
  });
  if (!countedToday) {
    const distinct = await prisma.guestDailyActivity.count({ where: { day } });
    if (distinct >= globalCap)
      return { allowed: false, remaining: quota - used, reason: "global_cap" };
    // Nothing here reads the row back or cares which caller wrote it — the
    // tally is "this IP used AI today", and presence is the whole fact. So the
    // concurrent insert from the same IP is skipped rather than caught: ON
    // CONFLICT DO NOTHING never raises, and therefore never prints (#158).
    await prisma.guestDailyActivity.createMany({
      data: { day, ipHash },
      skipDuplicates: true,
    });
  }

  // The per-IP invariant itself: see sliding-window-meter.ts. `reason` is added
  // here because "quota" vs "global_cap" is a guest-only distinction.
  const res = await meterConsume(store, quota, now, windowThreshold);
  return res.allowed ? res : { ...res, reason: "quota" };
}

/** Refund one consumed breakdown (e.g. the Claude call failed after metering). Never goes below 0. */
export async function refundGuestBreakdown(ipHash: string): Promise<void> {
  const row = await prisma.guestAiUsage.findUnique({ where: { ipHash } });
  if (row && row.count > 0) {
    await prisma.guestAiUsage.update({
      where: { ipHash },
      data: { count: { decrement: 1 } },
    });
  }
}
