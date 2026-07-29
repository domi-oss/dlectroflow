/**
 * Timezone-aware working-hours calendar for the scheduling window model (#104).
 *
 * Pure and dependency-free: the repo carries no date library, so zoned
 * arithmetic goes through `Intl.DateTimeFormat`, the same way `ics.ts` avoids
 * one. Two operations are all the window model needs — how many working
 * minutes lie between two instants, and where you land after advancing N of
 * them — plus a snap for instants that fall outside hours entirely.
 *
 * Hours are the OWNER'S REAL HOURS (confirmed 2026-07-29): Mon–Fri 08:30–18:00
 * for work, evenings and weekends for personal. They are approximations of what
 * Reclaim itself knows; their job is to place plausible boundaries and drive the
 * feasibility warning, not to schedule anything.
 */

/** `days[0]` is Sunday. Each entry: `[startMinuteOfDay, endMinuteOfDay)` ranges. */
export type HoursProfile = {
  readonly timeZone: string;
  readonly days: ReadonlyArray<ReadonlyArray<readonly [number, number]>>;
};

const H = (h: number, m = 0) => h * 60 + m;

const WORK_DAY: ReadonlyArray<readonly [number, number]> = [[H(8, 30), H(18)]];
const EVENING: ReadonlyArray<readonly [number, number]> = [[H(18), H(22)]];
const WEEKEND_DAY: ReadonlyArray<readonly [number, number]> = [[H(9), H(22)]];
const NONE: ReadonlyArray<readonly [number, number]> = [];

/** Overridable for self-hosters; the owner's zone is the default. */
export function schedulingTimeZone(): string {
  return process.env.SCHEDULING_TIMEZONE || "Europe/London";
}

export const WORK_HOURS: HoursProfile = {
  get timeZone() {
    return schedulingTimeZone();
  },
  days: [NONE, WORK_DAY, WORK_DAY, WORK_DAY, WORK_DAY, WORK_DAY, NONE],
};

export const PERSONAL_HOURS: HoursProfile = {
  get timeZone() {
    return schedulingTimeZone();
  },
  days: [WEEKEND_DAY, EVENING, EVENING, EVENING, EVENING, EVENING, WEEKEND_DAY],
};

type Parts = {
  y: number;
  m: number; // 1-based
  d: number;
  weekday: number; // 0 = Sunday
  minuteOfDay: number;
  second: number;
};

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

const formatterCache = new Map<string, Intl.DateTimeFormat>();
function formatter(timeZone: string): Intl.DateTimeFormat {
  let f = formatterCache.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      weekday: "short",
    });
    formatterCache.set(timeZone, f);
  }
  return f;
}

/** Wall-clock parts of `date` as seen in `timeZone`. */
function zonedParts(date: Date, timeZone: string): Parts {
  const got: Record<string, string> = {};
  for (const p of formatter(timeZone).formatToParts(date)) {
    if (p.type !== "literal") got[p.type] = p.value;
  }
  return {
    y: Number(got.year),
    m: Number(got.month),
    d: Number(got.day),
    weekday: Math.max(0, WEEKDAYS.indexOf(got.weekday ?? "Sun")),
    minuteOfDay: Number(got.hour) * 60 + Number(got.minute),
    second: Number(got.second),
  };
}

/** Offset of `timeZone` from UTC at `date`, in ms. */
function offsetMs(date: Date, timeZone: string): number {
  const p = zonedParts(date, timeZone);
  const asUtc = Date.UTC(
    p.y,
    p.m - 1,
    p.d,
    Math.floor(p.minuteOfDay / 60),
    p.minuteOfDay % 60,
    p.second,
  );
  return asUtc - Math.floor(date.getTime() / 1000) * 1000;
}

/**
 * The instant at which `timeZone`'s wall clock reads the given date/minute.
 * Two-pass because the offset depends on the instant we are solving for; the
 * second pass fixes the DST-transition case.
 */
function zonedTime(
  y: number,
  m: number,
  d: number,
  minuteOfDay: number,
  timeZone: string,
): Date {
  const naive = Date.UTC(
    y,
    m - 1,
    d,
    Math.floor(minuteOfDay / 60),
    minuteOfDay % 60,
    0,
  );
  const first = new Date(naive - offsetMs(new Date(naive), timeZone));
  const second = new Date(naive - offsetMs(first, timeZone));
  return second;
}

/** The profile's ranges for the calendar day containing `date`. */
function rangesOn(date: Date, p: HoursProfile) {
  const parts = zonedParts(date, p.timeZone);
  return { parts, ranges: p.days[parts.weekday] ?? NONE };
}

function startOfNextDay(date: Date, p: HoursProfile): Date {
  const { y, m, d } = zonedParts(date, p.timeZone);
  // Midnight of the following day, resolved through the zone so DST is handled.
  return zonedTime(y, m, d + 1, 0, p.timeZone);
}

export function workingMinutesBetween(
  from: Date,
  to: Date,
  p: HoursProfile,
): number {
  if (!(to.getTime() > from.getTime())) return 0;
  let total = 0;
  let cursor = from;
  // Bounded: one iteration per calendar day in the span.
  while (cursor.getTime() < to.getTime()) {
    const { parts, ranges } = rangesOn(cursor, p);
    const dayEnd = startOfNextDay(cursor, p);
    const segmentEnd = Math.min(dayEnd.getTime(), to.getTime());
    for (const [rs, re] of ranges) {
      const rangeStart = zonedTime(
        parts.y,
        parts.m,
        parts.d,
        rs,
        p.timeZone,
      ).getTime();
      const rangeEnd = zonedTime(
        parts.y,
        parts.m,
        parts.d,
        re,
        p.timeZone,
      ).getTime();
      const lo = Math.max(rangeStart, cursor.getTime());
      const hi = Math.min(rangeEnd, segmentEnd);
      if (hi > lo) total += Math.round((hi - lo) / 60_000);
    }
    cursor = dayEnd;
  }
  return total;
}

export function advanceWorkingMinutes(
  from: Date,
  minutes: number,
  p: HoursProfile,
): Date {
  let remaining = Math.max(0, Math.round(minutes));
  let cursor = from;
  for (let guard = 0; guard < 1000; guard++) {
    const { parts, ranges } = rangesOn(cursor, p);
    for (const [rs, re] of ranges) {
      const rangeStart = zonedTime(
        parts.y,
        parts.m,
        parts.d,
        rs,
        p.timeZone,
      ).getTime();
      const rangeEnd = zonedTime(
        parts.y,
        parts.m,
        parts.d,
        re,
        p.timeZone,
      ).getTime();
      const lo = Math.max(rangeStart, cursor.getTime());
      if (rangeEnd <= lo) continue;
      const available = Math.round((rangeEnd - lo) / 60_000);
      if (remaining === 0) return new Date(lo);
      if (available >= remaining) return new Date(lo + remaining * 60_000);
      remaining -= available;
    }
    cursor = startOfNextDay(cursor, p);
  }
  // Unreachable for any sane profile; fail loudly rather than loop forever.
  throw new Error(
    "advanceWorkingMinutes: no working time found within 1000 days",
  );
}

/** Move `d` forward to the next instant inside the profile's hours (no-op if already inside). */
export function snapIntoHours(d: Date, p: HoursProfile): Date {
  return advanceWorkingMinutes(d, 0, p);
}
