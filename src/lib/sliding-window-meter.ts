/**
 * The atomic sliding-window consume, shared by every metered AI allowance.
 *
 * #35 Phase B extracted this from `guest-quota.ts` rather than writing a second
 * copy for the per-user cap. That is not tidiness for its own sake: the design
 * chose a single-row `UserAiUsage` (not per-day rows) precisely so "rolling
 * window" means the same thing in both places, and two hand-written copies of a
 * concurrency-sensitive three-step sequence is exactly how that guarantee rots.
 * The concurrency correctness (#21 P5.1) is proved once, against real Postgres,
 * and both subjects inherit it.
 *
 * Pure with respect to the database: every statement is issued through a
 * `SlidingWindowStore` supplied by the caller, so the model and the primary key
 * live at the call site and this module holds only the ordering rules.
 */

/** One subject's meter row, as far as the window logic is concerned. */
export type MeterRow = { count: number; windowStartedAt: Date };

/**
 * The four statements the sequence needs, bound to one subject (one `ipHash`,
 * one `userId`). Each MUST be a single conditional statement whose guard
 * Postgres re-evaluates against the locked row — that is what makes concurrent
 * callers serialise instead of overshooting the quota.
 */
export type SlidingWindowStore = {
  /** The subject's row, or null if it has never consumed anything. */
  find(): Promise<MeterRow | null>;
  /**
   * Reset an EXPIRED window to `{ count: 1, windowStartedAt: now }`, matching
   * only when `windowStartedAt <= threshold`. Returns the rows matched, so
   * exactly one concurrent caller can win.
   */
  resetExpired(now: Date, threshold: Date): Promise<number>;
  /**
   * Increment inside an ACTIVE window, matching only while `count < quota`.
   * Returns the rows matched (0 = no room left, or no active window).
   */
  incrementUnderQuota(quota: number, threshold: Date): Promise<number>;
  /** First-use insert of `{ count: 1, windowStartedAt: now }`. */
  createFirstUse(now: Date): Promise<void>;
  /** Does this error mean "a concurrent first use won the insert race"? */
  isDuplicate(err: unknown): boolean;
};

export type MeterResult = { allowed: boolean; remaining: number };

/**
 * Has this subject's window lapsed? `null` (never used) is deliberately NOT
 * "expired" — there is no window to expire, and reporting one would make a
 * first-time subject look like a returning one to the caller.
 */
export function windowExpired(row: MeterRow | null, threshold: Date): boolean {
  return !!row && row.windowStartedAt <= threshold;
}

/** Consumed units in the CURRENT window (an expired window counts as unused). */
export function usedInWindow(row: MeterRow | null, threshold: Date): number {
  if (!row || windowExpired(row, threshold)) return 0;
  return row.count;
}

/**
 * Atomically consume one unit of a subject's rolling window.
 *
 * Three ordered steps, each a single conditional statement:
 *   1. reset an expired window (exactly one caller matches the `lte` predicate);
 *   2. guarded increment inside an active window (`count < quota` is re-checked
 *      on the locked row, so at most `quota` increments ever apply);
 *   3. nothing matched → the row is either absent (first use) or the active
 *      window is exhausted. Only pay for a create when it is genuinely absent,
 *      otherwise every blocked request would collide on the primary key.
 */
export async function meterConsume(
  store: SlidingWindowStore,
  quota: number,
  now: Date,
  windowThreshold: Date,
): Promise<MeterResult> {
  const reset = await store.resetExpired(now, windowThreshold);
  if (reset > 0) return { allowed: true, remaining: Math.max(0, quota - 1) };

  const inc = await store.incrementUnderQuota(quota, windowThreshold);
  if (inc > 0) {
    return {
      allowed: true,
      remaining: await remainingInWindow(store, quota, windowThreshold),
    };
  }

  const existing = await store.find();
  if (!existing) {
    try {
      await store.createFirstUse(now);
      return { allowed: true, remaining: Math.max(0, quota - 1) };
    } catch (err) {
      if (!store.isDuplicate(err)) throw err;
      // Lost the create race — a concurrent first use won; fall through and
      // increment against the row it created.
    }
  }
  const retry = await store.incrementUnderQuota(quota, windowThreshold);
  if (retry > 0) {
    return {
      allowed: true,
      remaining: await remainingInWindow(store, quota, windowThreshold),
    };
  }
  return { allowed: false, remaining: 0 };
}

/**
 * Remaining allowance after a consume. Informational only — under load it may
 * read a value another caller has since lowered, which is why the invariant is
 * enforced by the guarded statements above rather than by this number.
 */
export async function remainingInWindow(
  store: SlidingWindowStore,
  quota: number,
  windowThreshold: Date,
): Promise<number> {
  const row = await store.find();
  if (!row) return quota;
  return Math.max(0, quota - usedInWindow(row, windowThreshold));
}
