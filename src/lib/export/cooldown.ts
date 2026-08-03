/**
 * #129 — a per-workspace cooldown on the export endpoint.
 *
 * ## Why this exists at all
 *
 * One request to `/api/export` reads eleven tables, renders seven files and
 * deflates the lot in memory. Every other read in this app is bounded by a page
 * of content; this one is bounded by however much work somebody has ever done.
 * Left ungated it is the cheapest way to make the instance do expensive things,
 * and #129 names rate limiting in its scope for that reason.
 *
 * ## What it deliberately is NOT
 *
 * **It is not the per-user AI quota, and it must not be confused for one.** The
 * export costs a database read, not a model call, so it is metered separately and
 * counts against nothing that `user-quota.ts` or `guest-quota.ts` administers.
 * The issue's requirement that an export "should not be a way around the per-user
 * AI/quota accounting" is satisfied by the export never invoking a model at all —
 * there is no accounting to get around.
 *
 * **It is IN-PROCESS, and that is a stated limit rather than an oversight.** The
 * counter lives in this module's memory, so with two replicas a determined caller
 * gets one export per window per replica, and a restart forgets everything. The
 * alternatives were a database table (a migration, and a write on a read path) or
 * a shared cache (a dependency this app does not have). For a personal-scale,
 * invite-only instance the in-process version removes the accident — a
 * double-click, a retry loop, a tab that reloads — which is the whole realistic
 * threat. `src/lib/env-drift.ts` already records per-IP rate limiting as an
 * infrastructure-layer gap; this does not close it and does not claim to.
 *
 * ## Shape
 *
 * A factory rather than a module-level singleton with a reset hatch, so tests
 * exercise their own instance and can inject `now` instead of sleeping.
 */

/** One export per workspace per minute. Long enough that a retry loop is
 *  stopped, short enough that a person who genuinely wants a second copy is not
 *  told to come back later. */
export const EXPORT_COOLDOWN_SEC = 60;

export type CooldownVerdict =
  { allowed: true } | { allowed: false; retryAfterSec: number };

export type Cooldown = {
  check(key: string, now?: Date): CooldownVerdict;
};

export function createCooldown(windowSec: number): Cooldown {
  const windowMs = windowSec * 1000;
  /** key → the instant its last ALLOWED request was served. */
  const lastAllowed = new Map<string, number>();

  return {
    check(key, now = new Date()) {
      const at = now.getTime();

      // Prune on every call, before deciding. Without this the map is a slow leak
      // keyed by workspace id — bounded in practice by the number of accounts,
      // but a guest sandbox is a workspace too and there is no upper bound on
      // those. Entries outside the window carry no information, so dropping them
      // changes no verdict.
      for (const [existing, when] of lastAllowed) {
        if (at - when >= windowMs) lastAllowed.delete(existing);
      }

      const previous = lastAllowed.get(key);
      if (previous != null && at - previous < windowMs) {
        return {
          allowed: false,
          // Rounded UP: a `Retry-After` that expires a fraction of a second early
          // invites a client to retry into another refusal.
          retryAfterSec: Math.max(
            1,
            Math.ceil((windowMs - (at - previous)) / 1000),
          ),
        };
      }
      lastAllowed.set(key, at);
      return { allowed: true };
    },
  };
}

/**
 * The instance the route uses. Module-level so it survives between requests
 * within a process, which is the only way it can meter anything at all.
 */
export const exportCooldown = createCooldown(EXPORT_COOLDOWN_SEC);
