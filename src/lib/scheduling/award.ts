import { RewardType, BadgeKey } from "@/lib/constants";
import { logReward, awardBadge } from "@/lib/rewards";

/**
 * First-schedule marker reward, idempotent on `Task.scheduledAt`.
 *
 * Callers pass `wasAlreadyScheduled` (their `task.scheduledAt != null` value,
 * CAPTURED BEFORE the marker write), so a task scheduled by EITHER method
 * (`ics`/`google`) never re-awards — no-op when already scheduled.
 *
 * Rewards are BEST-EFFORT: a `logReward`/`awardBadge` failure is logged, never
 * thrown — scheduling has already committed and must not be retried (a retry
 * would duplicate the provider side effect). Both run independently via
 * `allSettled` so a `logReward` failure can't skip the idempotent `awardBadge`.
 *
 * This is the one code path the three server actions (`scheduleViaIcs`,
 * `pushStepsToGoogleTasks`, `scheduleSingleTask`) previously copy-pasted with
 * two different error-handling styles; the ICS path adopts this more robust
 * `allSettled` behavior.
 */
export async function awardFirstSchedule(
  workspaceId: string,
  wasAlreadyScheduled: boolean,
): Promise<void> {
  if (wasAlreadyScheduled) return;
  const results = await Promise.allSettled([
    logReward(workspaceId, RewardType.Scheduled),
    awardBadge(workspaceId, BadgeKey.FirstSchedule),
  ]);
  for (const r of results) {
    if (r.status === "rejected") {
      console.error("[scheduling] best-effort reward failed:", r.reason);
    }
  }
}
