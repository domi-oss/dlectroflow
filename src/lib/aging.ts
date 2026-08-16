/**
 * Freshness: how long an inbox item has sat, and what to call it.
 *
 * ## The unit convention (#261 — settle it here, it is a deliverable)
 *
 * **Every duration a user can set on `Settings` is stored as a whole number of
 * HOURS, and there is exactly ONE setting per concept.** New freshness-adjacent
 * settings follow both halves — #260's "park until" snooze is the next one, and
 * it is hours.
 *
 * This is written down because the alternative is what #261 found. `Settings`
 * carried two answers to "is this item aging?": `agingThresholdMinutes`
 * (default 240) drove `isAging`, and `agingHours` (default 4) drove
 * `freshnessTier`. Same concept, same default, different units, both editable —
 * so moving the aging control changed the status pill and left the amber tint,
 * the nav's aging count and the desktop reminder where they were. Nothing
 * reconciled them because nothing could: they were two columns.
 *
 * The minutes column is gone (`20260816120000_aging_hours_single_source`
 * converts any non-default value to hours first) and `isAging` is now a name for
 * `freshnessTier(...) !== "recent"` rather than a second calculation. One
 * question has one answer.
 *
 * Boundaries that are NOT user-settable stay module constants — see
 * `PROMPT_BOUNDARY_HOURS`. A parameter that can only take one value is a setting
 * pretending to exist.
 *
 * ## `now` is a parameter, and it stays one (#105)
 *
 * Every function here takes the clock rather than reading it. A component that
 * calls `Date.now()` while rendering makes the server's output and the client's
 * hydration disagree the moment the two readings straddle a boundary, and these
 * answers are RENDERED — the amber age tint, the pill's words, the nav count,
 * and whether the "still needed?" nudge exists at all. So a render passes the
 * one clock it was handed (`initialNow`, stamped once per request) and every
 * answer on the page agrees with every other.
 *
 * #261 removed `demoOverrideSeconds`, which used to put these boundaries seconds
 * apart and made the mismatch trivially reproducible. **That does not make the
 * parameter removable.** A four-hour boundary crossed between render and
 * hydration is rarer, not impossible, and the failure it produces is the same
 * one. The default keeps non-render callers (effects, server-side checks)
 * writing the short form.
 */

/**
 * The freshness thresholds, in hours. One field per tier, ascending.
 *
 * Not range-validated here: `updateAgingSettings` clamps each to a whole number
 * ≥ 1, and a workspace that sets them out of order gets the tier `freshnessTier`
 * finds first, which is the same answer the Settings page has always produced.
 */
export type AgingSettings = {
  agingHours: number;
  overdueHours: number;
  wayOverdueHours: number;
};

const HOUR_MS = 3600_000;

/**
 * The "still needed?" nudge boundary, in hours. A constant rather than a
 * setting: it is the review cadence the inline prompt is named for, and #261
 * removed the only thing that ever changed it (the demo override's ×4 rescale).
 */
export const PROMPT_BOUNDARY_HOURS = 24;

/** The aging boundary in ms — where "recent" ends. */
export function agingBoundaryMs(s: AgingSettings): number {
  return s.agingHours * HOUR_MS;
}

export type FreshnessTier = "recent" | "aging" | "overdue" | "wayOverdue";

const toMs = (d: Date | string): number =>
  (typeof d === "string" ? new Date(d) : d).getTime();

/** age = now − max(createdAt, freshenedAt). freshenedAt resets the clock non-destructively. */
export function freshnessAgeMs(
  createdAt: Date | string,
  freshenedAt: Date | string | null,
  now: number = Date.now(),
): number {
  const base = freshenedAt
    ? Math.max(toMs(createdAt), toMs(freshenedAt))
    : toMs(createdAt);
  return now - base;
}

/** Tier boundaries in ms, straight from the hours trio. */
function tierBoundsMs(s: AgingSettings): {
  aging: number;
  overdue: number;
  wayOverdue: number;
} {
  return {
    aging: agingBoundaryMs(s),
    overdue: s.overdueHours * HOUR_MS,
    wayOverdue: s.wayOverdueHours * HOUR_MS,
  };
}

export function freshnessTier(
  createdAt: Date | string,
  freshenedAt: Date | string | null,
  s: AgingSettings,
  now: number = Date.now(),
): FreshnessTier {
  const age = freshnessAgeMs(createdAt, freshenedAt, now);
  const b = tierBoundsMs(s);
  if (age >= b.wayOverdue) return "wayOverdue";
  if (age >= b.overdue) return "overdue";
  if (age >= b.aging) return "aging";
  return "recent";
}

/**
 * True once an item has sat past the aging boundary — i.e. it is on any tier
 * but `recent`.
 *
 * #261 — a name for `freshnessTier(...) !== "recent"`, not a second calculation.
 * It is kept as a function rather than inlined at its four call sites because
 * three of them (the nav's aging count, the desktop reminder, the amber age
 * tint) ask the boolean question and not the tier one, and reading
 * `!== "recent"` at a call site that only wants "is it late" invites somebody to
 * re-derive it from a threshold again.
 *
 * ⚠️ It takes `freshenedAt` now, and that is a behaviour change, not a signature
 * tidy-up: the old version read `createdAt` alone, so answering "yes, still
 * needed" reset the status pill and left the row amber and still sending
 * reminders. Freshening resets every freshness answer or it resets none.
 */
export function isAging(
  createdAt: Date | string,
  freshenedAt: Date | string | null,
  s: AgingSettings,
  now: number = Date.now(),
): boolean {
  return freshnessTier(createdAt, freshenedAt, s, now) !== "recent";
}

/**
 * The inline "still needed?" prompt: shown once an item has gone
 * `PROMPT_BOUNDARY_HOURS` untouched, unless it has been dismissed.
 *
 * Takes no `AgingSettings` — #261 removed the demo override that was the only
 * reason it ever read one.
 */
export function shouldPrompt24h(
  createdAt: Date | string,
  freshenedAt: Date | string | null,
  promptDismissedAt: Date | string | null,
  now: number = Date.now(),
): boolean {
  if (promptDismissedAt) return false;
  return (
    freshnessAgeMs(createdAt, freshenedAt, now) >=
    PROMPT_BOUNDARY_HOURS * HOUR_MS
  );
}
