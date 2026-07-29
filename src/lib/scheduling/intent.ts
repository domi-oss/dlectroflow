/**
 * The default `ScheduleIntent` the no-menu path sends (#104).
 *
 * Deliberately NOT in `src/app/actions/google-schedule.ts`: that file carries
 * `"use server"`, and every export of a server-action module must be an async
 * function — `next build` rejects a synchronous one outright. Exporting this as
 * an async action would also turn "what are the defaults?" into a network
 * round-trip for sub-project B's menu, which is a client component. So it lives
 * here, pure and client-safe, next to the vocabulary it builds.
 */
import { SchedulePriority, ScheduleHours } from "./types";
import type { ScheduleIntent, ScheduleUnit } from "./types";

/** Reclaim's own default due date is 3 days out; matching it means the no-menu
 *  path behaves exactly as it did before the menu existed (sub-project B). */
export const DEFAULT_DUE_DAYS = 3;

export function defaultIntentFor(
  units: ScheduleUnit[],
  now: Date = new Date(),
): ScheduleIntent {
  return {
    dueAt: new Date(now.getTime() + DEFAULT_DUE_DAYS * 24 * 60 * 60_000),
    // High, not Normal: today we send no priority at all and inherit Reclaim's
    // P2 default, so anything lower would silently downgrade every task the
    // owner already schedules.
    priority: SchedulePriority.High,
    hours: ScheduleHours.Work,
    busy: true,
    units: [...units].sort((a, b) => a.order - b.order),
  };
}

/** The three nullable `Task` columns #106 added, exactly as Prisma returns them. */
export type PersistedIntentColumns = {
  scheduleDueAt: Date | null;
  schedulePriority: string | null;
  scheduleHours: string | null;
};

const PRIORITIES = new Set<string>(Object.values(SchedulePriority));
const HOURS = new Set<string>(Object.values(ScheduleHours));

/**
 * The intent the Schedule menu opens with (#106): what the owner said last time,
 * or `defaultIntentFor`'s fallback for anything they have never said.
 *
 * Built on `defaultIntentFor` rather than restating the defaults, so the menu path
 * and the bare-📅 path cannot drift. Pure and client-safe, so the two read sites
 * that already hold the task row (the inbox page) and the one that does not
 * (`loadScheduleIntent`) share one merge instead of two that agree today.
 *
 * Both pseudo-enum columns are re-validated even though a CHECK constraint makes
 * an illegal value unreachable: this output goes straight into a Reclaim title
 * parameter, and "trust the database" is how one bad row becomes a malformed
 * schedule.
 */
export function mergePersistedIntent(
  units: ScheduleUnit[],
  persisted: PersistedIntentColumns,
  now: Date = new Date(),
): ScheduleIntent {
  const base = defaultIntentFor(units, now);
  const { scheduleDueAt, schedulePriority, scheduleHours } = persisted;
  return {
    ...base,
    dueAt: scheduleDueAt ?? base.dueAt,
    priority:
      schedulePriority && PRIORITIES.has(schedulePriority)
        ? (schedulePriority as SchedulePriority)
        : base.priority,
    hours:
      scheduleHours && HOURS.has(scheduleHours)
        ? (scheduleHours as ScheduleHours)
        : base.hours,
  };
}
