/**
 * Window derivation — the fix for steps arriving on the calendar in reverse
 * order (#104).
 *
 * Reclaim receives one task per step with no sequence information, so it places
 * them in whatever order it likes (observed: exactly backwards). Giving each
 * step a DISJOINT [notBefore, due] window removes that freedom: step 6 cannot
 * start before step 5's deadline. That single property is the fix; everything
 * else here serves it.
 *
 * Windows are measured in WORKING minutes, not wall clock — a two-hour window
 * at 03:00 is useless because Reclaim only places work inside scheduling hours.
 */
import {
  PERSONAL_HOURS,
  WORK_HOURS,
  advanceWorkingMinutes,
  snapIntoHours,
  workingMinutesBetween,
  type HoursProfile,
} from "./hours";
import { ScheduleHours } from "./types";
import type { ScheduleIntent } from "./types";

/** Nothing shorter than this is worth a context switch, or survives Reclaim's splitting. */
export const SCHEDULE_MIN_BLOCK_MIN = 30;

/** Minutes we ask the provider to block for one unit. */
export function effectiveDurationMin(estMinutes: number): number {
  const est = Number.isFinite(estMinutes) && estMinutes > 0 ? estMinutes : 25;
  return Math.max(SCHEDULE_MIN_BLOCK_MIN, Math.round(est));
}

/** Lead-in so the first window is not already expired when Reclaim next syncs. */
const SYNC_LEAD_IN_MIN = 15;

export type ScheduleWindow = {
  unitId: string;
  /** `null` for the first unit — it may start immediately. */
  notBefore: Date | null;
  due: Date;
  durationMin: number;
  /** True when the 30-minute floor changed the estimate, so encoders can show the real one. */
  floored: boolean;
};

export type WindowPlan = {
  windows: ScheduleWindow[];
  feasible: boolean;
  availableMin: number;
  requiredMin: number;
  /** When infeasible, the earliest deadline that would fit. `null` when feasible. */
  earliestFeasibleDue: Date | null;
};

function profileFor(hours: ScheduleIntent["hours"]): HoursProfile {
  return hours === ScheduleHours.Personal ? PERSONAL_HOURS : WORK_HOURS;
}

export function deriveWindows(
  intent: ScheduleIntent,
  now: Date = new Date(),
): WindowPlan {
  const profile = profileFor(intent.hours);
  const units = [...intent.units].sort((a, b) => a.order - b.order);

  const durations = units.map((u) => ({
    unit: u,
    durationMin: effectiveDurationMin(u.estMinutes),
    floored: effectiveDurationMin(u.estMinutes) !== Math.round(u.estMinutes),
  }));
  const requiredMin = durations.reduce((t, d) => t + d.durationMin, 0);

  const start = snapIntoHours(
    new Date(now.getTime() + SYNC_LEAD_IN_MIN * 60_000),
    profile,
  );
  const availableMin = workingMinutesBetween(start, intent.dueAt, profile);
  const feasible = availableMin >= requiredMin;

  // When the deadline cannot hold the work we still emit ordered windows — the
  // menu warns and the owner decides. Fall back to allocating each unit its own
  // duration so the sequence is preserved even in the over-committed case.
  const budgetMin = feasible ? availableMin : requiredMin;

  const windows: ScheduleWindow[] = [];
  let cursor = start;
  let allocated = 0;

  durations.forEach(({ unit, durationMin, floored }, i) => {
    const isLast = i === durations.length - 1;
    let due: Date;

    if (unit.dueAt) {
      // Sub-project C: a pinned deadline wins, clamped so it cannot break order.
      const min = advanceWorkingMinutes(cursor, durationMin, profile);
      due = unit.dueAt.getTime() < min.getTime() ? min : unit.dueAt;
    } else if (isLast && feasible) {
      // Land the final window exactly on the requested deadline — but never
      // shorter than the block it has to hold, or the last step gets a window
      // it cannot possibly fit into.
      const min = advanceWorkingMinutes(cursor, durationMin, profile);
      due = intent.dueAt.getTime() < min.getTime() ? min : intent.dueAt;
    } else {
      const share = Math.max(
        durationMin,
        Math.round((budgetMin * durationMin) / requiredMin),
      );
      allocated += share;
      due = advanceWorkingMinutes(start, allocated, profile);
      const min = advanceWorkingMinutes(cursor, durationMin, profile);
      if (due.getTime() < min.getTime()) due = min;
    }

    windows.push({
      unitId: unit.id,
      notBefore: i === 0 ? null : cursor,
      due,
      durationMin,
      floored,
    });
    cursor = due;
  });

  return {
    windows,
    feasible,
    availableMin,
    requiredMin,
    earliestFeasibleDue: feasible
      ? null
      : advanceWorkingMinutes(start, requiredMin, profile),
  };
}
