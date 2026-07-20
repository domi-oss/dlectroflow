// Pure, client-safe vocabulary for the scheduling seam (#34, epic #29 S1).
// No server-only imports live here, so BOTH the server actions/pages AND client
// components can share one type for "which method + is it available" instead of
// re-deriving it five different ways.

/**
 * The two shipped scheduling methods. The VALUE is the persisted
 * `Task.scheduledVia` string — note GoogleTasks stores `"google"` (not
 * `"googleTasks"`) to match rows S0 already wrote, so there is no
 * migration/backfill. The provider *id* surfaced to the UI is `"googleTasks"`
 * (epic wording); this one constant owns both facts so they can't drift.
 */
export const SchedulingMethod = {
  Ics: "ics",
  GoogleTasks: "google",
} as const;
export type SchedulingMethod = (typeof SchedulingMethod)[keyof typeof SchedulingMethod];

/** Owner Google connection status; null for guests (mirrors today's
 *  `owner ? googleStatus : null`). */
export type GoogleConnStatus = {
  configured: boolean;
  connected: boolean;
  needsReconnect: boolean;
};

/** Context passed to the seam, resolved once at the server boundary (the page). */
export type SchedulingContext = {
  workspaceId: string;
  isOwner: boolean;
  google: GoogleConnStatus | null;
};

export type ScheduleOpts = { durationMin?: number };

/** The union of today's failure reasons across the two shipped methods. */
export type ScheduleFailReason =
  | "not_found"
  | "not_configured"
  | "not_connected"
  | "reconnect_required"
  | "no_reclaim_list"
  | "no_steps"
  | "error";

/**
 * Discriminated on `via` — keeps ICS's `{ics, icsFilename}` and Google's
 * `{scheduled, listTitle}` intact rather than forcing a lossy common shape.
 */
export type ScheduleResult =
  | { ok: true; via: typeof SchedulingMethod.Ics; ics: string; icsFilename: string }
  | { ok: true; via: typeof SchedulingMethod.GoogleTasks; scheduled: number; listTitle: string }
  | { ok: false; reason: ScheduleFailReason; message?: string };

/** Provider id surfaced to the UI/telemetry — distinct from the stored
 *  `scheduledVia` value (`"google"`). */
export type SchedulingProviderId = "ics" | "googleTasks";

export interface SchedulingProvider {
  /** Stable id for wiring/telemetry: `"ics" | "googleTasks"`. */
  readonly id: SchedulingProviderId;
  /** i18n key resolved to a label at the UI edge via `t(...)`. */
  readonly labelKey: string;
  /** Pure predicate over context — the single availability rule. */
  isAvailable(ctx: SchedulingContext): boolean;
  /** Stamp the marker + award once (via the shared helper), then perform the
   *  provider-specific side effect. */
  schedule(taskId: string, ctx: SchedulingContext, opts?: ScheduleOpts): Promise<ScheduleResult>;
}
