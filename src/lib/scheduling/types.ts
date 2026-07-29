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
export type SchedulingMethod =
  (typeof SchedulingMethod)[keyof typeof SchedulingMethod];

/** The ACTING ACCOUNT's own Google connection status; `null` when nobody is
 *  signed in (#118 Phase C — mirrors the pages' `me ? googleStatus : null`,
 *  which replaced an `owner ? …` filter that hid a member's own connection). */
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
  | {
      ok: true;
      via: typeof SchedulingMethod.Ics;
      ics: string;
      icsFilename: string;
    }
  | {
      ok: true;
      via: typeof SchedulingMethod.GoogleTasks;
      scheduled: number;
      listTitle: string;
    }
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
  schedule(
    taskId: string,
    ctx: SchedulingContext,
    opts?: ScheduleOpts,
  ): Promise<ScheduleResult>;
}

/**
 * What the user asked for when they scheduled something (#104). Provider-agnostic
 * on purpose: the Reclaim encoder renders it as title parameters, the plain
 * Google Tasks encoder as a native due date, the ICS builder as VEVENT
 * properties. One vocabulary, three renderings.
 */
export const SchedulePriority = {
  Critical: "critical", // → Reclaim P1
  High: "high", // → P2. Reclaim's own default, and therefore ours.
  Normal: "normal", // → P3
  Low: "low", // → P4
} as const;
export type SchedulePriority =
  (typeof SchedulePriority)[keyof typeof SchedulePriority];

/** Which of Reclaim's scheduling-hours categories the work belongs to. */
export const ScheduleHours = { Work: "work", Personal: "personal" } as const;
export type ScheduleHours = (typeof ScheduleHours)[keyof typeof ScheduleHours];

/** One thing to place: a step of a task, or a single to-do. */
export type ScheduleUnit = {
  /** `Step.id`, or `Task.id` for a stepless to-do. */
  id: string;
  /** 1-based position in the sequence that must be preserved. */
  order: number;
  total: number;
  text: string;
  /** `Step.subtaskEmoji` — kept out of `text` so encoders can place it. */
  emoji?: string | null;
  /** The honest estimate, BEFORE the 30-minute floor. */
  estMinutes: number;
  /** Per-unit deadline override (sub-project C); derived when absent. */
  dueAt?: Date | null;
};

export type ScheduleIntent = {
  /** Deadline for the whole task. */
  dueAt: Date;
  priority: SchedulePriority;
  hours: ScheduleHours;
  /**
   * Whether the time should be defended. Honoured literally by ICS
   * (`TRANSP:OPAQUE`); for Reclaim it is advisory only — Reclaim decides free
   * vs busy itself as the deadline approaches, and exposes no parameter for it.
   */
  busy: boolean;
  /** Ordered by `order`, ascending. */
  units: ScheduleUnit[];
};
