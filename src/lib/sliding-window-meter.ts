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
   * Increment inside an ACTIVE window. Returns the rows matched (0 = no room
   * left, or no active window).
   *
   * `quota` is the guard: a number applies `count < quota`, and **`null` omits
   * the predicate entirely**. `null` is deliberately not "a very large number"
   * — see `meterRecord`. An implementation MUST leave the clause out rather
   * than substituting a bound of its own.
   */
  incrementInWindow(quota: number | null, threshold: Date): Promise<number>;
  /**
   * First-use insert of `{ count: 1, windowStartedAt: now }`, resolving to
   * whether THIS caller inserted the row.
   *
   * `false` means a concurrent first use won and its row is already committed —
   * not that anything failed. An implementation MUST get that answer without
   * raising: `createMany({ skipDuplicates: true })` compiles to
   * `INSERT ... ON CONFLICT DO NOTHING`, whose `count` is exactly this boolean.
   *
   * It used to be `Promise<void>` alongside an `isDuplicate(err)` predicate, and
   * the loser was identified by catching its P2002. That was correct and still
   * printed: `log: ["error"]` is Prisma's client-level logger, so the line is
   * emitted before the exception reaches any `catch` (#158, and the note on
   * `log` in src/lib/db.ts). A real failure must still reject.
   */
  createFirstUse(now: Date): Promise<boolean>;
};

export type MeterResult = { allowed: boolean; remaining: number };

/**
 * How a unit came to be recorded. `reset` and `created` both leave the row at
 * `count = 1`, which is the cheap answer the caller wants for "remaining" — the
 * distinction from `incremented` is what lets `meterConsume` avoid a re-read on
 * those two paths (and avoid a racy one).
 */
type MeterOutcome = "reset" | "created" | "incremented" | "blocked";

/**
 * The shared body of both modes: reset an expired window, else increment inside
 * the active one, else create the row on first use.
 *
 * `quota` is passed straight through to the store as the increment's guard, so
 * `null` really does mean "no limit was consulted anywhere" rather than "a limit
 * nobody expects to reach".
 *
 * `"blocked"` is only reachable with a numeric quota — with `null` there is no
 * condition under which the increment can fail for lack of room.
 */
async function applyMeter(
  store: SlidingWindowStore,
  quota: number | null,
  now: Date,
  windowThreshold: Date,
): Promise<MeterOutcome> {
  // 1) Reset an expired window (exactly one caller matches the `lte` predicate).
  if ((await store.resetExpired(now, windowThreshold)) > 0) return "reset";

  // 2) Increment inside an active window, guarded by `quota` when there is one.
  if ((await store.incrementInWindow(quota, windowThreshold)) > 0) {
    return "incremented";
  }

  // 3) Nothing matched: the row is either absent (first use) or — with a numeric
  //    quota — the active window is exhausted. Only pay for a create when it is
  //    genuinely absent, otherwise every blocked request collides on the PK.
  const existing = await store.find();
  // `false` = a concurrent first use won the insert; its row is committed, so
  // fall through and increment against that instead. The loser is identified by
  // the insert's own row count rather than by catching its P2002 (#158).
  if (!existing && (await store.createFirstUse(now))) return "created";

  return (await store.incrementInWindow(quota, windowThreshold)) > 0
    ? "incremented"
    : "blocked";
}

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
  const outcome = await applyMeter(store, quota, now, windowThreshold);
  if (outcome === "blocked") return { allowed: false, remaining: 0 };
  // A reset or a first-use create leaves the row at exactly one consumed unit,
  // so the answer is known without a re-read — which is also the non-racy one.
  if (outcome !== "incremented") {
    return { allowed: true, remaining: Math.max(0, quota - 1) };
  }
  return {
    allowed: true,
    remaining: await remainingInWindow(store, quota, windowThreshold),
  };
}

/**
 * Record one unit against a subject's rolling window, enforcing NOTHING.
 *
 * This is the `uncapped` path (owner decision on !175: "I at least want the
 * owner usage uncapped but showing how much has been used in the people
 * panel"). Usage has to be visible, so it must be counted; the account must
 * never be refused, so nothing may be compared.
 *
 * It takes NO quota parameter, on purpose. The tempting shortcut —
 * `meterConsume(store, Number.MAX_SAFE_INTEGER, …)` — would leave a bound in the
 * SQL and turn "unlimited" into "limited by a number nobody expects to reach",
 * which is a cap that silently exists and cannot be raised. With no argument
 * there is nothing for a later change to start comparing against, and the
 * increment carries no `count <` clause at all.
 */
export async function meterRecord(
  store: SlidingWindowStore,
  now: Date,
  windowThreshold: Date,
): Promise<void> {
  await applyMeter(store, null, now, windowThreshold);
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
