import { prisma } from "@/lib/db";
import { AiPolicy } from "@/lib/constants";
import { decryptNullable } from "@/lib/crypto/token-cipher";
import {
  meterConsume,
  meterRecord,
  usedInWindow,
  type SlidingWindowStore,
} from "@/lib/sliding-window-meter";

/**
 * #35 Phase B — the per-user AI allowance.
 *
 * The counterpart to `guest-quota.ts`, and deliberately its mirror image: the
 * same single-row sliding window, metered through the same
 * `sliding-window-meter` statements. What differs is the subject (a `User`, not
 * an IP hash), the quota (a per-user column the owner sets, not one env var for
 * everybody) and the fact that a user may bring their own key and step out of
 * the meter entirely.
 *
 * The window is `USER_AI_WINDOW_HOURS`, default 720 (30 days), read exactly the
 * way `GUEST_AI_WINDOW_HOURS` is read in `guestQuotaConfig()`. It slides from
 * FIRST USE and resets on expiry — it is not a calendar month. The People panel
 * reports these same numbers (`peekUserAiUsage`), so what the owner sees is what
 * enforcement uses.
 */

/** 30 days. Named so the default appears once, in a place tests can point at. */
const DEFAULT_USER_AI_WINDOW_HOURS = 720;

export function userQuotaConfig(): { windowHours: number } {
  // `Number("") === 0` and `Number("x") === NaN`, either of which would make the
  // window collapse to "always expired" (a free breakdown on every request) or
  // to NaN (never expired). Both fail toward the documented default instead.
  const raw = Number(process.env.USER_AI_WINDOW_HOURS);
  return {
    windowHours:
      Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_USER_AI_WINDOW_HOURS,
  };
}

/** The user columns the policy decision needs — and nothing else. */
const POLICY_SELECT = {
  id: true,
  aiPolicy: true,
  aiQuota: true,
  llmProvider: true,
  llmKeyEnc: true,
} as const;

/**
 * What the breakdown route needs to know about a signed-in account's AI access.
 *
 * `ownKey` carries a DECRYPTED secret, so it is server-only by construction:
 * never log it, never put it in a response, never hand it to a client
 * component. `metered` records whether a unit was actually consumed, which is
 * what the refund path keys off.
 */
export type UserAiAccess = {
  policy: string;
  ownKey: { apiKey: string; provider: string | null } | null;
  metered: boolean;
  /** `"quota"` = over the cap; serve the same canned fallback a blocked guest gets. */
  blockedReason: "quota" | null;
};

/**
 * The four statements the shared meter needs, bound to one user.
 * `UserAiUsage.userId` is the primary key, so these mirror the guest store
 * one-for-one with `ipHash` swapped out.
 */
function userMeterStore(userId: string): SlidingWindowStore {
  return {
    find: () => prisma.userAiUsage.findUnique({ where: { userId } }),
    resetExpired: async (now, threshold) =>
      (
        await prisma.userAiUsage.updateMany({
          where: { userId, windowStartedAt: { lte: threshold } },
          data: { count: 1, windowStartedAt: now },
        })
      ).count,
    incrementInWindow: async (quota, threshold) =>
      (
        await prisma.userAiUsage.updateMany({
          where: {
            userId,
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
        await prisma.userAiUsage.createMany({
          data: { userId, count: 1, windowStartedAt: now },
          // See the guest store: ON CONFLICT DO NOTHING, so a concurrent first
          // use is reported by `count` rather than raised as a P2002 that
          // Prisma's client logger would print at error level first (#158).
          skipDuplicates: true,
        })
      ).count === 1,
  };
}

/**
 * Resolve a signed-in account's AI access, metering a unit when the policy says
 * the instance is paying and the account has a cap.
 *
 * Resolution order, exactly as the design specifies it:
 *
 *   1. A PRESENT KEY WINS — decrypt `llmKeyEnc`, use their provider/key, no
 *      cap and no meter (their key, their bill, not ours to count). This is why
 *      "capped until you bring your key" needs no fourth state: bringing a key
 *      is what lifts the cap, not a policy change.
 *   2. `uncapped` → instance key, usage RECORDED but never enforced. Owner
 *      decision on !175: "I at least want the owner usage uncapped but showing
 *      how much has been used in the people panel." So `uncapped` is emphatically
 *      NOT "unmetered" — it counts, and it can never refuse. `aiQuota` is inert
 *      on such an account, and `meterRecord` takes no quota argument at all, so
 *      there is nothing to compare against even by accident.
 *   3. `capped` (and anything else, including a hand-edited value) → instance
 *      key, metered against `UserAiUsage` AND enforced. Over quota returns the
 *      same shaped `"quota"` block the guest cap returns, so the route's
 *      fallback branch needs no new case.
 *
 * A user row that cannot be found is blocked rather than served: the caller
 * already holds a verified session, so a missing row means the account was
 * deleted mid-request, and spending the instance's key on it is the wrong guess.
 */
export async function consumeUserBreakdown(
  userId: string,
): Promise<UserAiAccess> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: POLICY_SELECT,
  });
  if (!user) {
    return {
      policy: AiPolicy.Capped,
      ownKey: null,
      metered: false,
      blockedReason: "quota",
    };
  }

  // 1. A present, DECRYPTABLE key wins. An undecryptable one (rotated key,
  //    corruption) counts as absent — see decryptNullable — so the account
  //    degrades onto the instance key and its meter rather than getting an
  //    uncapped allowance backed by a secret nobody can read.
  const apiKey = decryptNullable(user.llmKeyEnc);
  if (apiKey) {
    return {
      policy: user.aiPolicy,
      ownKey: { apiKey, provider: user.llmProvider },
      metered: false,
      blockedReason: null,
    };
  }

  // 2. Uncapped: the instance pays, the usage is COUNTED so the People panel can
  //    show it, and the request can never be refused. Note what is NOT here: no
  //    quota is read, and `meterRecord` has no parameter to pass one to.
  if (user.aiPolicy === AiPolicy.Uncapped) {
    const { windowHours } = userQuotaConfig();
    const now = new Date();
    await meterRecord(
      userMeterStore(userId),
      now,
      new Date(now.getTime() - windowHours * 3600_000),
    );
    return {
      policy: user.aiPolicy,
      ownKey: null,
      // TRUE: a unit was recorded, so a failed breakdown must be refunded — the
      // count is what the owner reads, and an over-count misreports their spend.
      metered: true,
      blockedReason: null,
    };
  }

  // 3. Metered AND enforced. Fails CLOSED: `capped`, `own_key`-without-a-key and
  //    any value the CHECK constraint would reject all land here.
  const quota = Math.max(0, user.aiQuota);
  if (quota === 0) {
    return {
      policy: user.aiPolicy,
      ownKey: null,
      metered: false,
      blockedReason: "quota",
    };
  }

  const { windowHours } = userQuotaConfig();
  const now = new Date();
  const windowThreshold = new Date(now.getTime() - windowHours * 3600_000);
  const res = await meterConsume(
    userMeterStore(userId),
    quota,
    now,
    windowThreshold,
  );

  return {
    policy: user.aiPolicy,
    ownKey: null,
    metered: res.allowed,
    blockedReason: res.allowed ? null : "quota",
  };
}

/**
 * Refund one consumed breakdown (the LLM call failed after metering). Never goes
 * below 0 — the guest path's `refundGuestBreakdown` behaves identically, and a
 * negative counter would hand out a free allowance on the next window.
 */
export async function refundUserBreakdown(userId: string): Promise<void> {
  const row = await prisma.userAiUsage.findUnique({ where: { userId } });
  if (row && row.count > 0) {
    await prisma.userAiUsage.update({
      where: { userId },
      data: { count: { decrement: 1 } },
    });
  }
}

/** Usage numbers for one account — what the owner-only People panel shows. */
export type UserAiUsageView = {
  used: number;
  quota: number;
  remaining: number;
  /** When the current (or last) window began; null if AI was never used. */
  windowStartedAt: Date | null;
  /** When that window lapses (start + USER_AI_WINDOW_HOURS). */
  windowEndsAt: Date | null;
};

/**
 * Read one account's usage this window WITHOUT consuming anything.
 *
 * Reports an expired window as 0 used, because that is what the next consume
 * will see once it resets the row. Showing the stale count would tell the owner
 * somebody is at their cap when their allowance has in fact already renewed.
 * `windowStartedAt` is still returned so the lapsed window is visible rather
 * than silently blank.
 */
export async function peekUserAiUsage(
  userId: string,
  quota: number,
): Promise<UserAiUsageView> {
  const { windowHours } = userQuotaConfig();
  const row = await prisma.userAiUsage.findUnique({ where: { userId } });
  return usageViewFor(row, quota, windowHours);
}

/**
 * The pure half of `peekUserAiUsage`, so a caller that has already loaded the
 * relation (the People panel loads every user's usage in one query) reports the
 * SAME numbers without a second round trip per person.
 */
export function usageViewFor(
  row: { count: number; windowStartedAt: Date } | null,
  quota: number,
  windowHours = userQuotaConfig().windowHours,
): UserAiUsageView {
  if (!row) {
    return {
      used: 0,
      quota,
      remaining: quota,
      windowStartedAt: null,
      windowEndsAt: null,
    };
  }
  const threshold = new Date(Date.now() - windowHours * 3600_000);
  const used = usedInWindow(row, threshold);
  return {
    used,
    quota,
    remaining: Math.max(0, quota - used),
    windowStartedAt: row.windowStartedAt,
    windowEndsAt: new Date(
      row.windowStartedAt.getTime() + windowHours * 3600_000,
    ),
  };
}
