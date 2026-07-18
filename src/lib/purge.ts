/**
 * Guest-sandbox retention TTL.
 *
 * The actual purge logic (expired-guest sweep + stale-counter deletion) lives
 * in the self-contained CronJob entrypoint prisma/scheduled-purge.ts, NOT here:
 * that file must run inside the standalone prod image, which has no app source.
 * This module only exposes the TTL used when a guest workspace is created
 * (src/lib/workspace.ts), so it stays in app source where its consumer is.
 */

/** Guest sandbox lifetime in hours (default 24). Used to stamp Workspace.expiresAt. */
export function guestSandboxTtlHours(): number {
  return Number(process.env.GUEST_SANDBOX_TTL_HOURS ?? 24);
}
