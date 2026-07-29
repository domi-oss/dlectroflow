# Schedule intent A — payload correctness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a scheduled task arrive in Reclaim with enough information to be placed **in order**, in blocks worth defending, labelled so the calendar slot says what to do.

**Architecture:** A provider-agnostic `ScheduleIntent` describes *what the user wants*; a pure window model turns it into a disjoint `[notBefore, due]` window per step; per-provider encoders render those windows as Reclaim title syntax, plain Google Tasks fields, or ICS properties. The server actions become thin: build intent → derive windows → encode → upsert. Every layer below the network call is pure and unit-tested.

**Tech Stack:** TypeScript, Next.js 16.2, Prisma, vitest 4.1 (`npm test`), Playwright (`npm run test:e2e`). No new dependencies — timezone arithmetic uses built-in `Intl`, matching the repo's existing zero-date-library approach.

**Spec:** [`docs/design/specs/2026-07-29-schedule-intent-design.md`](../specs/2026-07-29-schedule-intent-design.md)
**Issue:** #104. Sub-projects B (#106) and C (#107) build on the interfaces defined here.

## Global Constraints

- **No new npm dependencies.** The lockfile trap in this repo is real (see CONTRIBUTING and #81); everything here is doable with `Intl`.
- **`AGENTS.md` applies:** this is Next.js 16.2 and its APIs differ from training data. Read `node_modules/next/dist/docs/` before touching framework code. No framework code changes in this plan — all server actions and pure modules.
- **Working hours are Mon–Fri 08:30–18:00** work, Mon–Fri 18:00–22:00 + Sat–Sun 09:00–22:00 personal, timezone `Europe/London`. These are the owner's real hours; do not "tidy" them to 09:00–17:00.
- **30-minute floor:** `dur = max(30, round(estMinutes || 25))`.
- **Priority default `high` → `P2`.** Today the code sends no priority and inherits Reclaim's P2 default; anything else silently downgrades every task the owner already schedules.
- **`(type work)`** unless personal is explicitly chosen.
- **Month-name dates only** (`Jul 31 2026 9:00am`). Never `31/07/2026` — ambiguous between the owner's `en-GB` locale and a US-format parser.
- **Commit trailer** on every commit: `Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>`
- **No behaviour change for guests** beyond the per-step description fix. The `.ics` download keeps back-to-back placement from the next top of the hour.
- Gates that must be green before the MR: `npm test`, `npx tsc --noEmit`, `npm run lint`, `npm run format:check`, `npm run test:e2e`.

## File Structure

| File | Responsibility |
|---|---|
| `src/lib/scheduling/hours.ts` **(create)** | Timezone-aware working-hours calendar: how many working minutes lie between two instants, and where you land after advancing N of them. Knows nothing about tasks. |
| `src/lib/scheduling/windows.ts` **(create)** | Turns a deadline + ordered units into disjoint, monotonic `[notBefore, due]` windows, plus a feasibility verdict. Knows nothing about Reclaim. |
| `src/lib/scheduling/encode-reclaim.ts` **(create)** | Renders one unit + window as a Reclaim-syntax title and a description. The only file that knows Reclaim's parameter vocabulary. |
| `src/lib/scheduling/encode-plain.ts` **(create)** | Renders one unit + window for a plain Google Tasks list: clean title, native RFC 3339 `due`. |
| `src/lib/scheduling/encoder.ts` **(create)** | Picks an encoder from the list title / `SCHEDULING_SYNTAX`. One decision, one place. |
| `src/lib/scheduling/types.ts` **(modify)** | Adds `SchedulePriority`, `ScheduleHours`, `ScheduleUnit`, `ScheduleIntent`. Stays client-safe and pure. |
| `src/lib/google.ts` **(modify)** | `patchGoogleTask` widens to `{title, notes, due}`; new `upsertGoogleTask` does POST / PATCH / POST-after-404. |
| `src/app/actions/google-schedule.ts` **(modify)** | Becomes thin: build intent → windows → encode → upsert. `buildScheduleNote` moves *inside* the loop. |
| `src/lib/ics.ts` **(modify)** | `buildTaskIcs` takes a per-step description and a `busy` flag. |
| `src/app/actions/ics-schedule.ts` **(modify)** | Passes one description per step instead of one for all. |
| `scripts/verify-reclaim-syntax.ts` **(create)** | One-shot manual verification against the live account (Task 9). Not part of CI. |

Each new module is pure and independently testable, which is the point of the split: the network call is the only impure step and it stays in `google.ts`.

---

### Task 1: Working-hours calendar

**Files:**
- Create: `src/lib/scheduling/hours.ts`
- Test: `src/lib/scheduling/hours.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `type HoursProfile = { timeZone: string; days: ReadonlyArray<ReadonlyArray<readonly [number, number]>> }` — `days[0]` is Sunday, each entry a list of `[startMinuteOfDay, endMinuteOfDay]` ranges.
  - `WORK_HOURS: HoursProfile`, `PERSONAL_HOURS: HoursProfile`
  - `workingMinutesBetween(from: Date, to: Date, p: HoursProfile): number`
  - `advanceWorkingMinutes(from: Date, minutes: number, p: HoursProfile): Date`
  - `snapIntoHours(d: Date, p: HoursProfile): Date`

- [ ] **Step 1: Write the failing tests**

Create `src/lib/scheduling/hours.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import {
  WORK_HOURS,
  PERSONAL_HOURS,
  workingMinutesBetween,
  advanceWorkingMinutes,
  snapIntoHours,
} from "./hours";

/** A London wall-clock instant, built without depending on the host timezone. */
function london(
  iso: string, // "2026-07-29T09:00" — BST, so UTC+1
  offsetHours: number,
): Date {
  return new Date(`${iso}:00.000${offsetHours >= 0 ? "+" : "-"}${String(Math.abs(offsetHours)).padStart(2, "0")}:00`);
}
const bst = (iso: string) => london(iso, 1); // late March – late October
const gmt = (iso: string) => london(iso, 0);

describe("workingMinutesBetween — work profile (Mon–Fri 08:30–18:00)", () => {
  it("counts a full working day as 570 minutes", () => {
    // Wednesday 29 July 2026, 08:30 → 18:00 BST
    expect(
      workingMinutesBetween(bst("2026-07-29T08:30"), bst("2026-07-29T18:00"), WORK_HOURS),
    ).toBe(570);
  });

  it("clips to the start of the working day", () => {
    // 06:00 → 09:30 contains only 08:30–09:30
    expect(
      workingMinutesBetween(bst("2026-07-29T06:00"), bst("2026-07-29T09:30"), WORK_HOURS),
    ).toBe(60);
  });

  it("clips to the end of the working day", () => {
    // 17:00 → 23:00 contains only 17:00–18:00
    expect(
      workingMinutesBetween(bst("2026-07-29T17:00"), bst("2026-07-29T23:00"), WORK_HOURS),
    ).toBe(60);
  });

  it("skips the weekend entirely", () => {
    // Friday 18:00 → Monday 08:30 is zero working minutes
    expect(
      workingMinutesBetween(bst("2026-07-31T18:00"), bst("2026-08-03T08:30"), WORK_HOURS),
    ).toBe(0);
  });

  it("spans several days additively", () => {
    // Wed 08:30 → Fri 18:00 = three full days
    expect(
      workingMinutesBetween(bst("2026-07-29T08:30"), bst("2026-07-31T18:00"), WORK_HOURS),
    ).toBe(570 * 3);
  });

  it("returns 0 when the range is inverted or empty", () => {
    expect(workingMinutesBetween(bst("2026-07-29T12:00"), bst("2026-07-29T12:00"), WORK_HOURS)).toBe(0);
    expect(workingMinutesBetween(bst("2026-07-29T14:00"), bst("2026-07-29T10:00"), WORK_HOURS)).toBe(0);
  });

  it("is correct across the autumn DST change (clocks go back 25 Oct 2026)", () => {
    // Friday 23 Oct (BST) 08:30 → Monday 26 Oct (GMT) 18:00 = two working days
    expect(
      workingMinutesBetween(bst("2026-10-23T08:30"), gmt("2026-10-26T18:00"), WORK_HOURS),
    ).toBe(570 * 2);
  });
});

describe("workingMinutesBetween — personal profile", () => {
  it("counts a weekday evening as 240 minutes (18:00–22:00)", () => {
    expect(
      workingMinutesBetween(bst("2026-07-29T18:00"), bst("2026-07-29T22:00"), PERSONAL_HOURS),
    ).toBe(240);
  });

  it("counts a Saturday as 780 minutes (09:00–22:00)", () => {
    expect(
      workingMinutesBetween(bst("2026-08-01T09:00"), bst("2026-08-01T22:00"), PERSONAL_HOURS),
    ).toBe(780);
  });

  it("excludes the working day", () => {
    // Wednesday 09:00–17:00 is work time, so zero personal minutes
    expect(
      workingMinutesBetween(bst("2026-07-29T09:00"), bst("2026-07-29T17:00"), PERSONAL_HOURS),
    ).toBe(0);
  });
});

describe("advanceWorkingMinutes", () => {
  it("advances inside a single day", () => {
    expect(
      advanceWorkingMinutes(bst("2026-07-29T09:00"), 120, WORK_HOURS).toISOString(),
    ).toBe(bst("2026-07-29T11:00").toISOString());
  });

  it("rolls over the end of the day into the next working morning", () => {
    // 17:00 + 90 working minutes = 60 today, 30 tomorrow → 09:00 Thursday
    expect(
      advanceWorkingMinutes(bst("2026-07-29T17:00"), 90, WORK_HOURS).toISOString(),
    ).toBe(bst("2026-07-30T09:00").toISOString());
  });

  it("skips the weekend", () => {
    // Friday 17:30 + 60 = 30 on Friday, 30 on Monday → 09:00 Monday
    expect(
      advanceWorkingMinutes(bst("2026-07-31T17:30"), 60, WORK_HOURS).toISOString(),
    ).toBe(bst("2026-08-03T09:00").toISOString());
  });

  it("advancing zero minutes from outside hours snaps to the next window", () => {
    expect(
      advanceWorkingMinutes(bst("2026-07-29T06:00"), 0, WORK_HOURS).toISOString(),
    ).toBe(bst("2026-07-29T08:30").toISOString());
  });

  it("is the inverse of workingMinutesBetween", () => {
    const from = bst("2026-07-29T09:00");
    const to = advanceWorkingMinutes(from, 1234, WORK_HOURS);
    expect(workingMinutesBetween(from, to, WORK_HOURS)).toBe(1234);
  });
});

describe("snapIntoHours", () => {
  it("leaves an instant already inside working hours alone", () => {
    const d = bst("2026-07-29T10:00");
    expect(snapIntoHours(d, WORK_HOURS).toISOString()).toBe(d.toISOString());
  });
  it("moves a 3am instant to the start of the working day", () => {
    expect(snapIntoHours(bst("2026-07-29T03:00"), WORK_HOURS).toISOString()).toBe(
      bst("2026-07-29T08:30").toISOString(),
    );
  });
  it("moves a Saturday instant to Monday morning (work profile)", () => {
    expect(snapIntoHours(bst("2026-08-01T12:00"), WORK_HOURS).toISOString()).toBe(
      bst("2026-08-03T08:30").toISOString(),
    );
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/lib/scheduling/hours.test.ts`
Expected: FAIL — `Failed to resolve import "./hours"`.

- [ ] **Step 3: Write the implementation**

Create `src/lib/scheduling/hours.ts`:

```ts
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
  const naive = Date.UTC(y, m - 1, d, Math.floor(minuteOfDay / 60), minuteOfDay % 60, 0);
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
      const rangeStart = zonedTime(parts.y, parts.m, parts.d, rs, p.timeZone).getTime();
      const rangeEnd = zonedTime(parts.y, parts.m, parts.d, re, p.timeZone).getTime();
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
      const rangeStart = zonedTime(parts.y, parts.m, parts.d, rs, p.timeZone).getTime();
      const rangeEnd = zonedTime(parts.y, parts.m, parts.d, re, p.timeZone).getTime();
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
  throw new Error("advanceWorkingMinutes: no working time found within 1000 days");
}

/** Move `d` forward to the next instant inside the profile's hours (no-op if already inside). */
export function snapIntoHours(d: Date, p: HoursProfile): Date {
  return advanceWorkingMinutes(d, 0, p);
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/lib/scheduling/hours.test.ts`
Expected: PASS, all cases.

If the DST case fails, the bug is almost certainly in `zonedTime`'s second pass — log `offsetMs` for both passes on 25 Oct 2026 before changing anything else.

- [ ] **Step 5: Commit**

```bash
git add src/lib/scheduling/hours.ts src/lib/scheduling/hours.test.ts
git commit -m "feat(scheduling): timezone-aware working-hours calendar (#104)

Two operations the window model needs - working minutes between two
instants, and where you land after advancing N of them - under the
owner's real hours (Mon-Fri 08:30-18:00 work, evenings and weekends
personal, Europe/London).

No date library: zoned arithmetic goes through Intl, matching how ics.ts
already avoids one. Tested across the autumn DST change, because a
one-hour error in a boundary is a due date an hour off for half the year.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: `ScheduleIntent` vocabulary + window derivation

**Files:**
- Modify: `src/lib/scheduling/types.ts` (append; do not reorder existing exports)
- Create: `src/lib/scheduling/windows.ts`
- Test: `src/lib/scheduling/windows.test.ts`

**Interfaces:**
- Consumes: `WORK_HOURS`, `PERSONAL_HOURS`, `workingMinutesBetween`, `advanceWorkingMinutes`, `snapIntoHours` from Task 1.
- Produces:
  - `SchedulePriority`, `ScheduleHours`, `ScheduleUnit`, `ScheduleIntent` (types.ts)
  - `SCHEDULE_MIN_BLOCK_MIN = 30`, `effectiveDurationMin(estMinutes: number): number`
  - `deriveWindows(intent: ScheduleIntent, now?: Date): WindowPlan`
  - `type ScheduleWindow = { unitId: string; notBefore: Date | null; due: Date; durationMin: number; floored: boolean }`
  - `type WindowPlan = { windows: ScheduleWindow[]; feasible: boolean; availableMin: number; requiredMin: number; earliestFeasibleDue: Date | null }`

- [ ] **Step 1: Add the vocabulary to `types.ts`**

Append to `src/lib/scheduling/types.ts`:

```ts
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
export type ScheduleHours =
  (typeof ScheduleHours)[keyof typeof ScheduleHours];

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
```

- [ ] **Step 2: Write the failing tests**

Create `src/lib/scheduling/windows.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { deriveWindows, effectiveDurationMin } from "./windows";
import { ScheduleHours, SchedulePriority } from "./types";
import type { ScheduleIntent, ScheduleUnit } from "./types";

const bst = (iso: string) => new Date(`${iso}:00.000+01:00`);

function unit(order: number, estMinutes: number, total: number): ScheduleUnit {
  return { id: `s${order}`, order, total, text: `step ${order}`, estMinutes };
}

function intent(over: Partial<ScheduleIntent> = {}): ScheduleIntent {
  return {
    dueAt: bst("2026-07-31T17:00"), // Friday
    priority: SchedulePriority.High,
    hours: ScheduleHours.Work,
    busy: true,
    units: [1, 2, 3].map((i) => unit(i, 30, 3)),
    ...over,
  };
}

describe("effectiveDurationMin", () => {
  it("floors short estimates to 30", () => {
    expect(effectiveDurationMin(15)).toBe(30);
    expect(effectiveDurationMin(1)).toBe(30);
  });
  it("leaves estimates at or above 30 alone", () => {
    expect(effectiveDurationMin(30)).toBe(30);
    expect(effectiveDurationMin(90)).toBe(90);
  });
  it("substitutes 25 for a missing or nonsense estimate, then floors it", () => {
    expect(effectiveDurationMin(0)).toBe(30);
    expect(effectiveDurationMin(Number.NaN)).toBe(30);
  });
  it("rounds fractional estimates", () => {
    expect(effectiveDurationMin(44.4)).toBe(44);
  });
});

describe("deriveWindows — the ordering guarantee", () => {
  const now = bst("2026-07-29T09:00"); // Wednesday morning

  it("gives each unit a window that starts where the previous one ended", () => {
    const { windows } = deriveWindows(intent(), now);
    expect(windows).toHaveLength(3);
    expect(windows[0].notBefore).toBeNull(); // first unit may start immediately
    expect(windows[1].notBefore!.toISOString()).toBe(windows[0].due.toISOString());
    expect(windows[2].notBefore!.toISOString()).toBe(windows[1].due.toISOString());
  });

  it("produces strictly increasing due dates", () => {
    const { windows } = deriveWindows(intent(), now);
    const times = windows.map((w) => w.due.getTime());
    expect(times).toEqual([...times].sort((a, b) => a - b));
    expect(new Set(times).size).toBe(3);
  });

  it("ends the last window exactly on the deadline", () => {
    const i = intent();
    const { windows } = deriveWindows(i, now);
    expect(windows.at(-1)!.due.toISOString()).toBe(i.dueAt.toISOString());
  });

  it("never makes a window shorter than the block it must hold", () => {
    const { windows } = deriveWindows(intent(), now);
    for (const w of windows) {
      const from = w.notBefore ?? now;
      expect(w.due.getTime() - from.getTime()).toBeGreaterThanOrEqual(w.durationMin * 60_000);
    }
  });

  it("allocates proportionally to duration, not evenly", () => {
    const i = intent({
      units: [unit(1, 30, 3), unit(2, 120, 3), unit(3, 30, 3)],
    });
    const { windows } = deriveWindows(i, now);
    const span = (n: number) =>
      windows[n].due.getTime() - (windows[n].notBefore ?? now).getTime();
    expect(span(1)).toBeGreaterThan(span(0));
    expect(span(1)).toBeGreaterThan(span(2));
  });

  it("marks a floored unit so the encoder can show the real estimate", () => {
    const i = intent({ units: [unit(1, 15, 2), unit(2, 45, 2)] });
    const { windows } = deriveWindows(i, now);
    expect(windows[0]).toMatchObject({ durationMin: 30, floored: true });
    expect(windows[1]).toMatchObject({ durationMin: 45, floored: false });
  });

  it("honours a per-unit override and keeps the sequence monotonic (sub-project C)", () => {
    const pinned = bst("2026-07-30T12:00");
    const i = intent({
      units: [unit(1, 30, 3), { ...unit(2, 30, 3), dueAt: pinned }, unit(3, 30, 3)],
    });
    const { windows } = deriveWindows(i, now);
    expect(windows[1].due.toISOString()).toBe(pinned.toISOString());
    expect(windows[0].due.getTime()).toBeLessThanOrEqual(pinned.getTime());
    expect(windows[2].due.getTime()).toBeGreaterThan(pinned.getTime());
  });

  it("places boundaries inside working hours, never overnight", () => {
    const i = intent({
      dueAt: bst("2026-08-05T17:00"),
      units: [1, 2, 3, 4, 5].map((n) => unit(n, 60, 5)),
    });
    const { windows } = deriveWindows(i, now);
    for (const w of windows) {
      const h = Number(
        new Intl.DateTimeFormat("en-GB", {
          timeZone: "Europe/London",
          hour: "2-digit",
          hourCycle: "h23",
        }).format(w.due),
      );
      expect(h).toBeGreaterThanOrEqual(8);
      expect(h).toBeLessThanOrEqual(18);
    }
  });
});

describe("deriveWindows — a single unit", () => {
  it("has no notBefore and is due on the deadline", () => {
    const i = intent({ units: [unit(1, 20, 1)] });
    const { windows } = deriveWindows(i, bst("2026-07-29T09:00"));
    expect(windows).toHaveLength(1);
    expect(windows[0].notBefore).toBeNull();
    expect(windows[0].due.toISOString()).toBe(i.dueAt.toISOString());
    expect(windows[0].durationMin).toBe(30);
  });
});

describe("deriveWindows — feasibility", () => {
  it("reports a comfortable plan as feasible", () => {
    const plan = deriveWindows(intent(), bst("2026-07-29T09:00"));
    expect(plan.feasible).toBe(true);
    expect(plan.requiredMin).toBe(90);
    expect(plan.availableMin).toBeGreaterThan(90);
    expect(plan.earliestFeasibleDue).toBeNull();
  });

  it("reports infeasible and suggests a later deadline when the work cannot fit", () => {
    const plan = deriveWindows(
      intent({
        dueAt: bst("2026-07-29T11:00"), // two hours away
        units: [1, 2, 3, 4, 5, 6, 7].map((n) => unit(n, 60, 7)),
      }),
      bst("2026-07-29T09:00"),
    );
    expect(plan.feasible).toBe(false);
    expect(plan.requiredMin).toBe(420);
    expect(plan.earliestFeasibleDue).toBeInstanceOf(Date);
    expect(plan.earliestFeasibleDue!.getTime()).toBeGreaterThan(plan.windows.at(-1)!.due.getTime());
  });

  it("still returns usable, ordered windows when infeasible — it warns, it does not block", () => {
    const plan = deriveWindows(
      intent({
        dueAt: bst("2026-07-29T11:00"),
        units: [1, 2, 3].map((n) => unit(n, 60, 3)),
      }),
      bst("2026-07-29T09:00"),
    );
    expect(plan.windows).toHaveLength(3);
    const times = plan.windows.map((w) => w.due.getTime());
    expect(times).toEqual([...times].sort((a, b) => a - b));
  });

  it("treats a deadline in the past as infeasible without throwing", () => {
    const plan = deriveWindows(
      intent({ dueAt: bst("2026-07-28T17:00") }),
      bst("2026-07-29T09:00"),
    );
    expect(plan.feasible).toBe(false);
    expect(plan.windows).toHaveLength(3);
  });
});

describe("deriveWindows — personal hours", () => {
  it("places boundaries in the evening, not the working day", () => {
    const plan = deriveWindows(
      intent({
        hours: ScheduleHours.Personal,
        dueAt: bst("2026-08-01T21:00"), // Saturday
        units: [unit(1, 30, 2), unit(2, 30, 2)],
      }),
      bst("2026-07-29T09:00"),
    );
    const hour = (d: Date) =>
      Number(
        new Intl.DateTimeFormat("en-GB", {
          timeZone: "Europe/London",
          hour: "2-digit",
          hourCycle: "h23",
        }).format(d),
      );
    expect(hour(plan.windows[0].due)).toBeGreaterThanOrEqual(9);
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npx vitest run src/lib/scheduling/windows.test.ts`
Expected: FAIL — `Failed to resolve import "./windows"`.

- [ ] **Step 4: Write the implementation**

Create `src/lib/scheduling/windows.ts`:

```ts
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
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run src/lib/scheduling/windows.test.ts`
Expected: PASS.

- [ ] **Step 6: Run the whole suite — nothing else may move**

Run: `npm test`
Expected: the pre-existing count plus the new files, no failures. `types.ts` was appended to, not reordered, so no existing import should break.

- [ ] **Step 7: Commit**

```bash
git add src/lib/scheduling/types.ts src/lib/scheduling/windows.ts src/lib/scheduling/windows.test.ts
git commit -m "feat(scheduling): disjoint windows so steps stop arriving reversed (#104)

Reclaim gets one task per step with no sequence information, so it places
them in whatever order it likes - observed on the live calendar as exactly
backwards, step 7 first and step 1 last. Each unit now gets a disjoint
[notBefore, due] window, so step 6 cannot start before step 5's deadline
and the inversion becomes impossible rather than unlikely.

Windows are measured in working minutes, proportional to duration, and the
plan reports feasibility so the caller can warn instead of silently
over-stuffing the week. ScheduleIntent is the provider-agnostic vocabulary
the encoders render three different ways.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Reclaim encoder

**Files:**
- Create: `src/lib/scheduling/encode-reclaim.ts`
- Test: `src/lib/scheduling/encode-reclaim.test.ts`

**Interfaces:**
- Consumes: `ScheduleIntent`, `ScheduleUnit` (Task 2), `ScheduleWindow` (Task 2), `buildScheduleNote` (`./note`).
- Produces:
  - `formatReclaimDate(d: Date, timeZone?: string): string` — e.g. `"Jul 31 2026 5:00pm"`
  - `PRIORITY_PARAM: Record<SchedulePriority, string>`
  - `encodeReclaim(args: EncodeArgs): { title: string; notes: string }`
  - `stripReclaimParams(title: string): string` — the round-trip guard, exported for tests *and* used by nothing else.
  - `type EncodeArgs = { unit: ScheduleUnit; window: ScheduleWindow; intent: ScheduleIntent; taskTitle: string; parentEmoji?: string | null; origin: string; voice: Voice }`

- [ ] **Step 1: Write the failing tests**

Create `src/lib/scheduling/encode-reclaim.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { encodeReclaim, formatReclaimDate, stripReclaimParams } from "./encode-reclaim";
import { ScheduleHours, SchedulePriority } from "./types";
import type { ScheduleIntent, ScheduleUnit } from "./types";
import type { ScheduleWindow } from "./windows";

const bst = (iso: string) => new Date(`${iso}:00.000+01:00`);

const unit: ScheduleUnit = {
  id: "step_6",
  order: 6,
  total: 7,
  text: "Note any steps or rules in the quoting process you want to remember",
  emoji: "✏️",
  estMinutes: 15,
};

const window: ScheduleWindow = {
  unitId: "step_6",
  notBefore: bst("2026-07-31T09:00"),
  due: bst("2026-07-31T11:00"),
  durationMin: 30,
  floored: true,
};

const intent: ScheduleIntent = {
  dueAt: bst("2026-07-31T17:00"),
  priority: SchedulePriority.High,
  hours: ScheduleHours.Work,
  busy: true,
  units: [unit],
};

const args = {
  unit,
  window,
  intent,
  taskTitle: "do flex training",
  parentEmoji: "🏷️",
  origin: "https://dlectroflow.dev",
  voice: "plain" as const,
};

describe("formatReclaimDate", () => {
  it("uses a month NAME, never a numeric date", () => {
    expect(formatReclaimDate(bst("2026-07-31T17:00"))).toBe("Jul 31 2026 5:00pm");
  });
  it("formats morning times with am", () => {
    expect(formatReclaimDate(bst("2026-07-31T09:00"))).toBe("Jul 31 2026 9:00am");
  });
  it("formats midday and midnight unambiguously", () => {
    expect(formatReclaimDate(bst("2026-07-31T12:00"))).toBe("Jul 31 2026 12:00pm");
    expect(formatReclaimDate(bst("2026-07-31T00:30"))).toBe("Jul 31 2026 12:30am");
  });
  it("renders in the scheduling timezone, not UTC", () => {
    // 23:30 UTC on 30 July is 00:30 BST on 31 July.
    expect(formatReclaimDate(new Date("2026-07-30T23:30:00.000Z"))).toBe(
      "Jul 31 2026 12:30am",
    );
  });
  it("never emits a slash", () => {
    expect(formatReclaimDate(bst("2026-07-31T17:00"))).not.toContain("/");
  });
});

describe("encodeReclaim — title", () => {
  it("is the exact expected string", () => {
    expect(encodeReclaim(args).title).toBe(
      "[6/7] ✏️ Note any steps or rules in the quoting process you want to remember ~15m " +
        "(duration:30m) (nosplit) (not before Jul 31 2026 9:00am) (due Jul 31 2026 11:00am) " +
        "(priority:P2) (type work)",
    );
  });

  it("leads with the counter badge so position survives truncation", () => {
    expect(encodeReclaim(args).title.startsWith("[6/7] ")).toBe(true);
  });

  it("shows the real estimate ONLY when the floor changed it", () => {
    const notFloored = {
      ...args,
      unit: { ...unit, estMinutes: 45 },
      window: { ...window, durationMin: 45, floored: false },
    };
    expect(encodeReclaim(notFloored).title).toContain("(duration:45m)");
    expect(encodeReclaim(notFloored).title).not.toContain("~");
  });

  it("omits (not before) for the first unit", () => {
    const first = {
      ...args,
      unit: { ...unit, order: 1 },
      window: { ...window, notBefore: null },
    };
    const title = encodeReclaim(first).title;
    expect(title).not.toContain("not before");
    expect(title).toContain("(due Jul 31 2026 11:00am)");
  });

  it("omits (nosplit) and the badge for a single-unit task", () => {
    const single = {
      ...args,
      unit: { ...unit, order: 1, total: 1, emoji: null, text: "Book the dentist" },
      window: { ...window, notBefore: null },
    };
    const title = encodeReclaim(single).title;
    expect(title).not.toContain("[1/1]");
    expect(title).not.toContain("(nosplit)");
    expect(title.startsWith("Book the dentist ")).toBe(true);
  });

  it("maps every priority to its Reclaim code", () => {
    const p = (priority: SchedulePriority) =>
      encodeReclaim({ ...args, intent: { ...intent, priority } }).title;
    expect(p(SchedulePriority.Critical)).toContain("(priority:P1)");
    expect(p(SchedulePriority.High)).toContain("(priority:P2)");
    expect(p(SchedulePriority.Normal)).toContain("(priority:P3)");
    expect(p(SchedulePriority.Low)).toContain("(priority:P4)");
  });

  it("emits (type personal) when the work is personal", () => {
    expect(
      encodeReclaim({
        ...args,
        intent: { ...intent, hours: ScheduleHours.Personal },
      }).title,
    ).toContain("(type personal)");
  });

  it("omits an absent step emoji without leaving a double space", () => {
    const noEmoji = { ...args, unit: { ...unit, emoji: null } };
    expect(encodeReclaim(noEmoji).title.startsWith("[6/7] Note any")).toBe(true);
    expect(encodeReclaim(noEmoji).title).not.toContain("  ");
  });
});

describe("stripReclaimParams — the contract with Reclaim's parser", () => {
  it("leaves exactly the text the user should see on the calendar", () => {
    expect(stripReclaimParams(encodeReclaim(args).title)).toBe(
      "[6/7] ✏️ Note any steps or rules in the quoting process you want to remember ~15m",
    );
  });

  it("does not eat parentheses that belong to the step text", () => {
    const parenthetical = {
      ...args,
      unit: { ...unit, text: "Read the overview (the short one)" },
    };
    expect(stripReclaimParams(encodeReclaim(parenthetical).title)).toBe(
      "[6/7] ✏️ Read the overview (the short one) ~15m",
    );
  });
});

describe("encodeReclaim — notes", () => {
  it("carries the parent task, the position and the honest estimate", () => {
    const { notes } = encodeReclaim(args);
    expect(notes).toContain("🏷️ do flex training");
    expect(notes).toContain("step 6 of 7");
    expect(notes).toContain("15m");
  });

  it("deep-links to THIS unit's step, not the task's first step", () => {
    const { notes } = encodeReclaim(args);
    expect(notes).toContain("https://dlectroflow.dev/focus/step_6");
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/lib/scheduling/encode-reclaim.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

Create `src/lib/scheduling/encode-reclaim.ts`:

```ts
/**
 * Reclaim's Google Tasks title syntax (#104).
 *
 * Reclaim parses parenthetical parameters out of a synced task's title, acts on
 * them, then STRIPS them — so whatever is left outside the parentheses is what
 * the owner reads in their calendar slot. That makes the title two things at
 * once, and the layout is chosen for the ~30 characters a slot actually shows:
 * counter badge first (position at a glance), then the step text (the part that
 * tells you what to do), then the honest estimate when the 30-minute floor
 * changed it. The parent task title lives in the description, because it is
 * identical across every event of a task and was eating the visible width.
 *
 * This is the ONLY module that knows Reclaim's vocabulary.
 */
import { buildScheduleNote } from "./note";
import { schedulingTimeZone } from "./hours";
import { SchedulePriority, ScheduleHours } from "./types";
import type { ScheduleIntent, ScheduleUnit } from "./types";
import type { ScheduleWindow } from "./windows";
import type { Voice } from "@/lib/strings";

const PRIORITY_PARAM: Record<SchedulePriority, string> = {
  [SchedulePriority.Critical]: "P1",
  [SchedulePriority.High]: "P2",
  [SchedulePriority.Normal]: "P3",
  [SchedulePriority.Low]: "P4",
};

const MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];

/**
 * `Jul 31 2026 5:00pm` — a month NAME, deliberately. Reclaim accepts numeric
 * dates, but `31/07/2026` is ambiguous between the owner's en-GB locale and a
 * US-format parser, and a silently misread deadline is the worst failure this
 * feature can have.
 */
export function formatReclaimDate(d: Date, timeZone = schedulingTimeZone()): string {
  const parts: Record<string, string> = {};
  for (const p of new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(d)) {
    if (p.type !== "literal") parts[p.type] = p.value;
  }
  const h24 = Number(parts.hour);
  const suffix = h24 < 12 ? "am" : "pm";
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
  const month = MONTHS[Number(parts.month) - 1];
  return `${month} ${parts.day} ${parts.year} ${h12}:${parts.minute}${suffix}`;
}

/** Every `(…)` group Reclaim would consume. Used only to prove the contract in tests. */
export function stripReclaimParams(title: string): string {
  const known =
    /\s*\((?:duration:[^)]*|nosplit|upnext|priority:[^)]*|type\s+[^)]*|due\s+[^)]*|not before\s+[^)]*)\)/gi;
  return title.replace(known, "").trim();
}

export type EncodeArgs = {
  unit: ScheduleUnit;
  window: ScheduleWindow;
  intent: ScheduleIntent;
  taskTitle: string;
  parentEmoji?: string | null;
  origin: string;
  voice: Voice;
};

export function encodeReclaim(a: EncodeArgs): { title: string; notes: string } {
  const { unit, window: w, intent } = a;
  const multi = unit.total > 1;

  const visible = [
    multi ? `[${unit.order}/${unit.total}]` : null,
    unit.emoji || null,
    unit.text.trim(),
    // The floor changed the number, so keep the honest estimate readable.
    w.floored ? `~${Math.round(unit.estMinutes)}m` : null,
  ]
    .filter(Boolean)
    .join(" ");

  const params = [
    `(duration:${w.durationMin}m)`,
    // A step is one sitting; without this a floored 30-minute block can split
    // into two 15s, which is exactly the sliver the floor exists to avoid.
    multi ? "(nosplit)" : null,
    w.notBefore ? `(not before ${formatReclaimDate(w.notBefore)})` : null,
    `(due ${formatReclaimDate(w.due)})`,
    `(priority:${PRIORITY_PARAM[intent.priority]})`,
    `(type ${intent.hours === ScheduleHours.Personal ? "personal" : "work"})`,
  ].filter(Boolean);

  const parentEmoji = a.parentEmoji ? `${a.parentEmoji} ` : "";
  const context = multi
    ? `${parentEmoji}${a.taskTitle} — step ${unit.order} of ${unit.total} · est. ${Math.round(unit.estMinutes)}m`
    : `${parentEmoji}${a.taskTitle} · est. ${Math.round(unit.estMinutes)}m`;

  return {
    title: `${visible} ${params.join(" ")}`,
    // Per-unit deep link: the defect this replaces reused the FIRST step's id
    // for every event, so step 6's calendar entry opened the timer on step 1.
    notes: `${context}\n${buildScheduleNote({ origin: a.origin, voice: a.voice, stepId: unit.id })}`,
  };
}

export { PRIORITY_PARAM };
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/lib/scheduling/encode-reclaim.test.ts`
Expected: PASS. If the exact-string test fails on spacing, fix the *code*, not the expectation — the expected string is the spec's format.

- [ ] **Step 5: Commit**

```bash
git add src/lib/scheduling/encode-reclaim.ts src/lib/scheduling/encode-reclaim.test.ts
git commit -m "feat(scheduling): Reclaim title/notes encoder (#104)

Reclaim strips its parenthetical parameters, so the title is two things at
once: instructions for the scheduler and the text the owner reads in a
calendar slot. Laid out for the ~30 characters a slot shows - counter badge,
step text, honest estimate when the floor changed it - with the parent task
moved into the description where it is not eating visible width.

Dates use a month name, never 31/07/2026, because that is ambiguous between
the owner's en-GB locale and a US-format parser and a misread deadline is
the worst thing this can get wrong. A round-trip test proves that stripping
every parameter group leaves exactly the intended visible text.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Plain Google Tasks encoder + encoder selection

**Files:**
- Create: `src/lib/scheduling/encode-plain.ts`, `src/lib/scheduling/encoder.ts`
- Test: `src/lib/scheduling/encode-plain.test.ts`, `src/lib/scheduling/encoder.test.ts`
- Modify: `src/lib/google.ts` (the `RECLAIM_LIST_MATCH` comment only, lines 14–18)

**Interfaces:**
- Consumes: `EncodeArgs` (Task 3).
- Produces:
  - `encodePlain(a: EncodeArgs): { title: string; notes: string; due?: string }` — `due` is RFC 3339.
  - `type EncodedTask = { title: string; notes: string; due?: string }`
  - `pickEncoder(listTitle: string): (a: EncodeArgs) => EncodedTask`

- [ ] **Step 1: Write the failing tests**

Create `src/lib/scheduling/encode-plain.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { encodePlain } from "./encode-plain";
import { ScheduleHours, SchedulePriority } from "./types";
import type { ScheduleIntent, ScheduleUnit } from "./types";
import type { ScheduleWindow } from "./windows";

const bst = (iso: string) => new Date(`${iso}:00.000+01:00`);
const unit: ScheduleUnit = {
  id: "step_6", order: 6, total: 7, text: "Note the quoting rules",
  emoji: "✏️", estMinutes: 15,
};
const window: ScheduleWindow = {
  unitId: "step_6", notBefore: bst("2026-07-31T09:00"),
  due: bst("2026-07-31T11:00"), durationMin: 30, floored: true,
};
const intent: ScheduleIntent = {
  dueAt: bst("2026-07-31T17:00"), priority: SchedulePriority.High,
  hours: ScheduleHours.Work, busy: true, units: [unit],
};
const args = {
  unit, window, intent, taskTitle: "do flex training", parentEmoji: "🏷️",
  origin: "https://dlectroflow.dev", voice: "plain" as const,
};

describe("encodePlain", () => {
  it("puts NO parenthetical parameters in the title", () => {
    const { title } = encodePlain(args);
    expect(title).toBe("[6/7] ✏️ Note the quoting rules");
    expect(title).not.toMatch(/\(duration|\(due|\(priority|\(type|\(nosplit/);
  });

  it("uses Google Tasks' native due field, in RFC 3339", () => {
    const { due } = encodePlain(args);
    expect(due).toBe(window.due.toISOString());
  });

  it("keeps the duration and the earliest start in the notes, where a human can read them", () => {
    const { notes } = encodePlain(args);
    expect(notes).toContain("30m");
    expect(notes).toContain("est. 15m");
    expect(notes).toMatch(/not before|earliest/i);
  });

  it("still deep-links to this unit's step", () => {
    expect(encodePlain(args).notes).toContain("/focus/step_6");
  });
});
```

Create `src/lib/scheduling/encoder.test.ts`:

```ts
import { describe, it, expect, afterEach } from "vitest";
import { pickEncoder } from "./encoder";
import { encodeReclaim } from "./encode-reclaim";
import { encodePlain } from "./encode-plain";

afterEach(() => {
  delete process.env.SCHEDULING_SYNTAX;
});

describe("pickEncoder", () => {
  it("uses the Reclaim encoder for Reclaim's own list", () => {
    expect(pickEncoder("🗓 Reclaim")).toBe(encodeReclaim);
    expect(pickEncoder("my reclaim tasks")).toBe(encodeReclaim);
  });

  it("uses the plain encoder for any other list", () => {
    expect(pickEncoder("My Tasks")).toBe(encodePlain);
    expect(pickEncoder("")).toBe(encodePlain);
  });

  it("lets SCHEDULING_SYNTAX override the detection in both directions", () => {
    process.env.SCHEDULING_SYNTAX = "plain";
    expect(pickEncoder("🗓 Reclaim")).toBe(encodePlain);
    process.env.SCHEDULING_SYNTAX = "reclaim";
    expect(pickEncoder("My Tasks")).toBe(encodeReclaim);
  });

  it("ignores an unrecognised override rather than throwing", () => {
    process.env.SCHEDULING_SYNTAX = "nonsense";
    expect(pickEncoder("🗓 Reclaim")).toBe(encodeReclaim);
  });
});
```

- [ ] **Step 2: Run both tests to verify they fail**

Run: `npx vitest run src/lib/scheduling/encode-plain.test.ts src/lib/scheduling/encoder.test.ts`
Expected: FAIL — modules not found.

- [ ] **Step 3: Write both implementations**

Create `src/lib/scheduling/encode-plain.ts`:

```ts
/**
 * Plain Google Tasks encoder (#104, epic #29 generalisation).
 *
 * A self-hoster with a Google account and no Reclaim gains nothing from
 * parenthetical parameters — they are noise nobody strips. So this encoder
 * writes a clean title, uses Google Tasks' OWN due-date field (which
 * `createGoogleTask` has always accepted and never been given), and puts the
 * duration and earliest-start in the notes where a human reads them.
 */
import { buildScheduleNote } from "./note";
import { formatReclaimDate } from "./encode-reclaim";
import type { EncodeArgs } from "./encode-reclaim";

export type EncodedTask = { title: string; notes: string; due?: string };

export function encodePlain(a: EncodeArgs): EncodedTask {
  const { unit, window: w } = a;
  const multi = unit.total > 1;

  const title = [
    multi ? `[${unit.order}/${unit.total}]` : null,
    unit.emoji || null,
    unit.text.trim(),
  ]
    .filter(Boolean)
    .join(" ");

  const parentEmoji = a.parentEmoji ? `${a.parentEmoji} ` : "";
  const lines = [
    multi
      ? `${parentEmoji}${a.taskTitle} — step ${unit.order} of ${unit.total}`
      : `${parentEmoji}${a.taskTitle}`,
    `Block ${w.durationMin}m · est. ${Math.round(unit.estMinutes)}m`,
    w.notBefore ? `Not before ${formatReclaimDate(w.notBefore)}` : null,
    buildScheduleNote({ origin: a.origin, voice: a.voice, stepId: unit.id }),
  ].filter(Boolean);

  return { title, notes: lines.join("\n"), due: w.due.toISOString() };
}
```

Create `src/lib/scheduling/encoder.ts`:

```ts
/**
 * Which title syntax to speak (#104).
 *
 * Reclaim syncs EXCLUSIVELY from its own `🗓 Reclaim` list — "any other tasks in
 * other lists will not be synced" — so the list we found already tells us
 * whether a Reclaim is listening. That makes the right encoder detectable with
 * zero configuration for either audience, which is the whole point: the owner
 * gets the parameters, a self-hoster with a plain list gets a clean title.
 */
import { encodeReclaim, type EncodeArgs } from "./encode-reclaim";
import { encodePlain, type EncodedTask } from "./encode-plain";

export type Encoder = (a: EncodeArgs) => EncodedTask;

export function pickEncoder(listTitle: string): Encoder {
  const override = (process.env.SCHEDULING_SYNTAX || "").toLowerCase();
  if (override === "plain") return encodePlain;
  if (override === "reclaim") return encodeReclaim;
  return listTitle.toLowerCase().includes("reclaim") ? encodeReclaim : encodePlain;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/lib/scheduling/encode-plain.test.ts src/lib/scheduling/encoder.test.ts`
Expected: PASS.

- [ ] **Step 5: Record the list-name footgun where the constant lives**

In `src/lib/google.ts`, replace the comment above `RECLAIM_LIST_MATCH` (lines 14–15) with:

```ts
// The Google Tasks list Reclaim syncs from. Reclaim syncs EXCLUSIVELY from its
// own "🗓 Reclaim" list — per its docs, "any other tasks in other lists will not
// be synced" — so pointing GOOGLE_TASKS_LIST_NAME at a different list means
// Reclaim never sees anything we push. That is not a broken push: it is a list
// with no scheduler attached, which is a legitimate setup for a self-hoster
// without Reclaim, and `pickEncoder` detects it and drops the Reclaim syntax.
// Match is case-insensitive "contains".
```

- [ ] **Step 6: Commit**

```bash
git add src/lib/scheduling/encode-plain.ts src/lib/scheduling/encode-plain.test.ts src/lib/scheduling/encoder.ts src/lib/scheduling/encoder.test.ts src/lib/google.ts
git commit -m "feat(scheduling): plain Google Tasks encoder, detected from the list (#104)

Reclaim syncs exclusively from its own list, so the list we found already
tells us whether a Reclaim is listening. Self-hosters with a plain list get
a clean title and Google Tasks' native due field - which createGoogleTask
has always accepted and never once been given - while the owner keeps the
parameters. Zero configuration for either audience; SCHEDULING_SYNTAX
overrides it if someone needs to.

Also records the footgun next to the constant: pointing
GOOGLE_TASKS_LIST_NAME elsewhere is not a broken push, it is a list with no
scheduler attached.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: `upsertGoogleTask` — stop duplicating on re-schedule

**Files:**
- Modify: `src/lib/google.ts` (`patchGoogleTask` ~line 291, then append `upsertGoogleTask`)
- Test: `src/lib/google-upsert.test.ts` (create — `google.ts` has no test file today; keep the new tests in their own file rather than inventing a home for the whole module)

**Interfaces:**
- Consumes: `EncodedTask` (Task 4).
- Produces: `upsertGoogleTask(token: string, listId: string, existingTaskId: string | null, body: EncodedTask): Promise<{ id: string; created: boolean }>`
- Changes: `patchGoogleTask(token, listId, taskId, patch: { title?, notes?, due?, status? }): Promise<boolean>`

- [ ] **Step 1: Write the failing tests**

Create `src/lib/google-upsert.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { upsertGoogleTask } from "./google";

const TOKEN = "tok";
const LIST = "list_1";
const body = { title: "[1/2] do the thing", notes: "note", due: "2026-07-31T10:00:00.000Z" };

let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

const ok = (json: unknown) =>
  ({ ok: true, status: 200, json: async () => json, text: async () => "" }) as unknown as Response;
const fail = (status: number) =>
  ({ ok: false, status, json: async () => ({}), text: async () => "err" }) as unknown as Response;

describe("upsertGoogleTask", () => {
  it("POSTs and reports created when there is no existing id", async () => {
    fetchMock.mockResolvedValueOnce(ok({ id: "new_1" }));
    await expect(upsertGoogleTask(TOKEN, LIST, null, body)).resolves.toEqual({
      id: "new_1",
      created: true,
    });
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ method: "POST" });
  });

  it("PATCHes the existing task instead of creating a second one", async () => {
    fetchMock.mockResolvedValueOnce(ok({ id: "old_1" }));
    await expect(upsertGoogleTask(TOKEN, LIST, "old_1", body)).resolves.toEqual({
      id: "old_1",
      created: false,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ method: "PATCH" });
    expect(fetchMock.mock.calls[0][0]).toContain("old_1");
  });

  it("sends title, notes AND due on the PATCH — a moved deadline is the point", () => {
    fetchMock.mockResolvedValueOnce(ok({ id: "old_1" }));
    return upsertGoogleTask(TOKEN, LIST, "old_1", body).then(() => {
      const sent = JSON.parse(String(fetchMock.mock.calls[0][1].body));
      expect(sent).toMatchObject({ title: body.title, notes: body.notes, due: body.due });
    });
  });

  it("re-creates when the task was deleted in Google (404)", async () => {
    fetchMock.mockResolvedValueOnce(fail(404)).mockResolvedValueOnce(ok({ id: "new_2" }));
    await expect(upsertGoogleTask(TOKEN, LIST, "gone", body)).resolves.toEqual({
      id: "new_2",
      created: true,
    });
    expect(fetchMock.mock.calls[1][1]).toMatchObject({ method: "POST" });
  });

  it("throws on a non-404 failure rather than silently losing the schedule", async () => {
    fetchMock.mockResolvedValueOnce(fail(500));
    await expect(upsertGoogleTask(TOKEN, LIST, "old_1", body)).rejects.toThrow(/500/);
  });

  it("omits due entirely when the encoder did not supply one", async () => {
    fetchMock.mockResolvedValueOnce(ok({ id: "new_3" }));
    await upsertGoogleTask(TOKEN, LIST, null, { title: "t", notes: "n" });
    expect(JSON.parse(String(fetchMock.mock.calls[0][1].body))).not.toHaveProperty("due");
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/lib/google-upsert.test.ts`
Expected: FAIL — `upsertGoogleTask` is not exported.

- [ ] **Step 3: Widen `patchGoogleTask` and add `upsertGoogleTask`**

In `src/lib/google.ts`, change `patchGoogleTask`'s `patch` parameter type from

```ts
  patch: { title?: string; status?: "needsAction" | "completed" },
```

to

```ts
  patch: {
    title?: string;
    notes?: string;
    /** RFC 3339. Google Tasks stores date-only precision but accepts a timestamp. */
    due?: string;
    status?: "needsAction" | "completed";
  },
```

Then append:

```ts
/**
 * Create-or-update one Google Task (#104).
 *
 * Both scheduling call sites used to POST unconditionally, so every re-schedule
 * added a second task and Reclaim dutifully booked a second block. `Step`
 * already persists `googleTaskId`; this is the function that finally reads it.
 * Reclaim two-way-syncs title/duration/due edits, so a PATCH MOVES the existing
 * calendar block rather than leaving a stale twin behind.
 *
 * A 404 means the task was deleted in Google since we stored the id — recreate
 * rather than fail, since the user's intent is "this should be scheduled".
 * Anything else throws: silently dropping a schedule is worse than an error.
 */
export async function upsertGoogleTask(
  token: string,
  listId: string,
  existingTaskId: string | null,
  body: { title: string; notes?: string; due?: string },
): Promise<{ id: string; created: boolean }> {
  const payload = {
    title: body.title,
    ...(body.notes != null ? { notes: body.notes } : {}),
    ...(body.due ? { due: body.due } : {}),
  };

  if (existingTaskId) {
    const res = await fetch(tasksUrl("lists", listId, "tasks", existingTaskId), {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });
    if (res.ok) return { id: existingTaskId, created: false };
    if (res.status !== 404) {
      const detail = await res.text().catch(() => "");
      throw new Error(`Google Tasks update failed (${res.status}) ${detail}`);
    }
    // Fall through: it is gone in Google, so create a replacement.
  }

  const created = await createGoogleTask(token, listId, {
    title: body.title,
    notes: body.notes,
    due: body.due,
  });
  return { id: created.id, created: true };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/lib/google-upsert.test.ts`
Expected: PASS.

- [ ] **Step 5: Confirm nothing else regressed**

Run: `npm test`
Expected: green. `patchGoogleTask`'s type only widened, so existing callers still compile.

- [ ] **Step 6: Commit**

```bash
git add src/lib/google.ts src/lib/google-upsert.test.ts
git commit -m "feat(google): upsert instead of duplicating on re-schedule (#104)

Both scheduling call sites POSTed unconditionally, so re-scheduling a task
added a second Google Task and Reclaim booked a second block. Step already
persists googleTaskId; this is the function that finally reads it. Because
Reclaim two-way-syncs title/duration/due edits, a PATCH moves the existing
block instead of leaving a stale twin.

A 404 recreates - the id is stale, the user's intent stands - and any other
failure throws, because silently dropping a schedule is worse than an error.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: Wire `pushStepsToGoogleTasks`

**Files:**
- Modify: `src/app/actions/google-schedule.ts` (delete `reclaimTitle` at lines 42–54; rewrite the body of `pushStepsToGoogleTasks`, lines 86–156)
- Test: `src/app/actions/google-schedule.test.ts` (check whether it exists; if it does, extend it, otherwise create it)

**Interfaces:**
- Consumes: `deriveWindows` (Task 2), `pickEncoder` (Task 4), `upsertGoogleTask` (Task 5), `ScheduleIntent` (Task 2).
- Produces: `defaultIntentFor(units: ScheduleUnit[], now?: Date): ScheduleIntent` — exported so sub-project B's menu starts from exactly the same defaults the no-menu path uses.
- `GoogleScheduleResult` gains nothing; the existing shape is preserved so no caller changes.

- [ ] **Step 1: Write the failing test**

Add to (or create) `src/app/actions/google-schedule.test.ts`. Mock at the module boundary so the test exercises the wiring, not Google:

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { defaultIntentFor } from "./google-schedule";
import { ScheduleHours, SchedulePriority } from "@/lib/scheduling/types";

describe("defaultIntentFor — what the no-menu path sends", () => {
  const now = new Date("2026-07-29T09:00:00.000+01:00");
  const units = [
    { id: "s1", order: 1, total: 2, text: "a", estMinutes: 15 },
    { id: "s2", order: 2, total: 2, text: "b", estMinutes: 45 },
  ];

  it("defaults the deadline to three days out, matching Reclaim's own default", () => {
    const i = defaultIntentFor(units, now);
    expect(i.dueAt.getTime()).toBe(now.getTime() + 3 * 24 * 60 * 60_000);
  });

  it("defaults to HIGH priority, because sending nothing already meant P2", () => {
    expect(defaultIntentFor(units, now).priority).toBe(SchedulePriority.High);
  });

  it("defaults to work hours", () => {
    expect(defaultIntentFor(units, now).hours).toBe(ScheduleHours.Work);
  });

  it("defaults to wanting the time defended", () => {
    expect(defaultIntentFor(units, now).busy).toBe(true);
  });

  it("keeps the units in order", () => {
    expect(defaultIntentFor(units, now).units.map((u) => u.order)).toEqual([1, 2]);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/app/actions/google-schedule.test.ts`
Expected: FAIL — `defaultIntentFor` is not exported.

- [ ] **Step 3: Rewrite the action**

In `src/app/actions/google-schedule.ts`: **delete** the `reclaimTitle` helper (lines 42–54) — the encoder owns that now — and add the imports plus:

```ts
/** Reclaim's own default due date is 3 days out; matching it means the no-menu
 *  path behaves exactly as it did before the menu existed (sub-project B). */
const DEFAULT_DUE_DAYS = 3;

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
```

Then replace the body of the `try` block in `pushStepsToGoogleTasks` (from `const list = await findReclaimList(token);` to the end of the step loop) with:

```ts
    const list = await findReclaimList(token);
    if (!list) {
      const names = (await listTaskLists(token)).map((l) => l.title).join(", ");
      return {
        ok: false,
        reason: "no_reclaim_list",
        message: `Couldn't find the "🗓 Reclaim" Google Tasks list. Available: ${names || "none"}. Reclaim only syncs from that list — create it in Google Tasks, or set GOOGLE_TASKS_LIST_NAME if you use a different scheduler.`,
      };
    }

    const settings = await getSettings(workspaceId);
    const voice: Voice = settings.voice === "playful" ? "playful" : "plain";
    const origin = publicOrigin();
    const encode = pickEncoder(list.title);

    const units: ScheduleUnit[] = task.steps.map((s) => ({
      id: s.id,
      order: s.order,
      total: task.steps.length,
      text: s.text,
      emoji: s.subtaskEmoji,
      estMinutes: s.estMinutes,
      dueAt: null,
    }));
    const intent = defaultIntentFor(units);
    const { windows } = deriveWindows(intent);
    const byUnit = new Map(windows.map((w) => [w.unitId, w]));

    let scheduled = 0;
    for (const s of task.steps) {
      const unit = units.find((u) => u.id === s.id)!;
      const window = byUnit.get(s.id)!;
      const encoded = encode({
        unit,
        window,
        intent,
        taskTitle: task.title,
        parentEmoji: task.parentEmoji ?? "🗂️",
        origin,
        voice,
      });
      const { id } = await upsertGoogleTask(
        token,
        list.id,
        s.googleTaskId,
        encoded,
      );
      // Guard step ownership before update (unchanged from before).
      const stepCheck = await prisma.step.findFirst({
        where: { id: s.id, task: { workspaceId } },
      });
      if (stepCheck) {
        await prisma.step.update({
          where: { id: s.id },
          data: { googleTaskId: id, googleTaskListId: list.id },
        });
      }
      scheduled++;
    }
```

Leave the reward/marker block and `revalidatePath` below it exactly as they are — the idempotency reasoning in those comments still holds.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/app/actions/google-schedule.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck — this is where a wrong field name shows up**

Run: `npx tsc --noEmit`
Expected: no errors in `src/`. `.next/` validator errors from a stale build are pre-existing and not yours.

- [ ] **Step 6: Commit**

```bash
git add src/app/actions/google-schedule.ts src/app/actions/google-schedule.test.ts
git commit -m "feat(scheduling): brief Reclaim properly when pushing steps (#104)

The action becomes thin: build a default intent, derive disjoint windows,
encode, upsert. The reclaimTitle helper is gone - the encoder owns the
format - and buildScheduleNote is now called PER STEP, so step 6's calendar
event finally opens the timer on step 6 instead of step 1.

defaultIntentFor is exported because sub-project B's menu must start from
exactly the same defaults the no-menu path uses, or scheduling without
opening the menu would quietly behave differently.

The no_reclaim_list message now names the list Reclaim actually requires
instead of implying the app dropped Reclaim.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: Wire `scheduleSingleTask`

**Files:**
- Modify: `src/app/actions/google-schedule.ts` (`scheduleSingleTask`, lines 260–282)
- Test: `src/app/actions/google-schedule.test.ts` (extend)

**Interfaces:**
- Consumes: everything from Task 6. No new exports.

- [ ] **Step 1: Write the failing test**

Append to `src/app/actions/google-schedule.test.ts`:

```ts
import { deriveWindows } from "@/lib/scheduling/windows";

describe("a single to-do has nothing to sequence", () => {
  it("gets one window, no notBefore, due on the deadline", () => {
    const now = new Date("2026-07-29T09:00:00.000+01:00");
    const intent = defaultIntentFor(
      [{ id: "t1", order: 1, total: 1, text: "Book the dentist", estMinutes: 20 }],
      now,
    );
    const { windows } = deriveWindows(intent, now);
    expect(windows).toHaveLength(1);
    expect(windows[0].notBefore).toBeNull();
    expect(windows[0].due.toISOString()).toBe(intent.dueAt.toISOString());
    expect(windows[0].durationMin).toBe(30);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/app/actions/google-schedule.test.ts -t "single to-do"`
Expected: FAIL only if Task 2's floor or single-unit handling regressed. If it passes immediately, that is fine — it is a guard on the wiring below; proceed.

- [ ] **Step 3: Replace the title construction in `scheduleSingleTask`**

Replace:

```ts
    const title = `${item.text} (duration:${minutes}m)`;
    const created = await createGoogleTask(token, list.id, { title });
```

with:

```ts
    const encode = pickEncoder(list.title);
    const unit: ScheduleUnit = {
      id: taskId,
      order: 1,
      total: 1,
      text: item.text,
      emoji: null,
      // The caller's clamped duration IS the estimate for a stepless to-do.
      estMinutes: minutes,
    };
    const intent = defaultIntentFor([unit]);
    const { windows } = deriveWindows(intent);
    const settings = await getSettings(workspaceId);
    const voice: Voice = settings.voice === "playful" ? "playful" : "plain";
    const encoded = encode({
      unit,
      window: windows[0],
      intent,
      taskTitle: item.text,
      parentEmoji: null,
      origin: publicOrigin(),
      voice,
    });
    const existing = await prisma.task.findFirst({
      where: { id: taskId, workspaceId },
      select: { googleTaskId: true },
    });
    const created = await upsertGoogleTask(
      token,
      list.id,
      existing?.googleTaskId ?? null,
      encoded,
    );
```

The subsequent `prisma.task.update` already writes `googleTaskId: created.id` — that still holds, since `upsertGoogleTask` returns `{ id }`.

- [ ] **Step 4: Run the tests**

Run: `npm test`
Expected: green.

- [ ] **Step 5: Typecheck**

Run: `npx tsc --noEmit`
Expected: clean in `src/`.

- [ ] **Step 6: Commit**

```bash
git add src/app/actions/google-schedule.ts src/app/actions/google-schedule.test.ts
git commit -m "feat(scheduling): single to-dos go through the same intent (#104)

One code path for the format, so a to-do and a step cannot drift apart. A
stepless to-do has nothing to sequence, so it gets no (not before) - but it
does get the 30-minute floor, the priority, the hours category, and the
upsert that stops a re-schedule adding a second block.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 8: Per-step descriptions and defended time in the `.ics` path

**Files:**
- Modify: `src/lib/ics.ts` (`IcsStep`, `buildTaskIcs`)
- Modify: `src/app/actions/ics-schedule.ts` (lines 50–65)
- Test: `src/lib/ics.test.ts` (extend the existing file)

**Interfaces:**
- Changes: `IcsStep` gains `id?: string | null` and `description?: string | null`; `buildTaskIcs` gains `busy?: boolean`; the top-level `description` input stays as the fallback so no existing caller breaks.

- [ ] **Step 1: Write the failing tests**

Append to `src/lib/ics.test.ts`:

```ts
describe("buildTaskIcs — per-step descriptions (#104)", () => {
  it("gives each VEVENT its own DESCRIPTION when one is supplied", () => {
    const ics = buildTaskIcs({
      title: "do flex training",
      steps: [
        { text: "one", estMinutes: 30, description: "link to step one" },
        { text: "two", estMinutes: 30, description: "link to step two" },
      ],
    });
    expect(ics).toContain("link to step one");
    expect(ics).toContain("link to step two");
  });

  it("falls back to the shared description when a step has none", () => {
    const ics = buildTaskIcs({
      title: "t",
      steps: [{ text: "one", estMinutes: 30 }],
      description: "shared",
    });
    expect(ics).toContain("shared");
  });

  it("marks events busy when asked, and free otherwise", () => {
    const steps = [{ text: "one", estMinutes: 30 }];
    expect(buildTaskIcs({ title: "t", steps, busy: true })).toContain("TRANSP:OPAQUE");
    expect(buildTaskIcs({ title: "t", steps })).not.toContain("TRANSP:OPAQUE");
  });

  it("still lays steps back-to-back from the same start — placement is unchanged", () => {
    const start = new Date("2026-07-29T10:00:00.000+01:00");
    const ics = buildTaskIcs({
      title: "t",
      start,
      steps: [
        { text: "one", estMinutes: 30 },
        { text: "two", estMinutes: 30 },
      ],
    });
    expect(ics).toContain("20260729T100000");
    expect(ics).toContain("20260729T103000");
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run src/lib/ics.test.ts`
Expected: FAIL on the per-step description and `TRANSP` cases; the placement case should already pass (it is the regression guard).

- [ ] **Step 3: Implement**

In `src/lib/ics.ts`, extend the step type and the builder:

```ts
type IcsStep = {
  text: string;
  estMinutes: number;
  subtaskEmoji?: string | null;
  /** Per-step DESCRIPTION (#104). Falls back to the builder's shared `description`. */
  description?: string | null;
};
```

Add `busy?: boolean` to `buildTaskIcs`'s input, and inside the `forEach`, use the step's own description and emit transparency:

```ts
    const stepDescription = s.description?.trim() || description;
    // ... where the VEVENT lines are pushed, alongside SUMMARY/DESCRIPTION:
    ...(input.busy ? ["TRANSP:OPAQUE"] : []),
```

Keep the existing `DESCRIPTION` escaping (`esc`) exactly as it is — it already handles the newline in the focus note.

In `src/app/actions/ics-schedule.ts`, replace the single `buildScheduleNote` call (lines 50–53) with a per-step one, so each `VEVENT` deep-links to its own step:

```ts
  const steps = task.steps.map((s) => ({
    text: s.text,
    estMinutes: s.estMinutes,
    subtaskEmoji: s.subtaskEmoji,
    description: buildScheduleNote({
      origin: publicOrigin(),
      voice,
      stepId: s.id,
    }),
  }));
```

and pass `steps` plus `busy: true` into `buildTaskIcs`, dropping the now-redundant shared `description` for the multi-step case.

- [ ] **Step 4: Run the tests**

Run: `npx vitest run src/lib/ics.test.ts`
Expected: PASS, including the untouched pre-existing cases.

- [ ] **Step 5: Commit**

```bash
git add src/lib/ics.ts src/app/actions/ics-schedule.ts src/lib/ics.test.ts
git commit -m "fix(ics): each VEVENT deep-links to its own step (#104)

The .ics path had the same defect as the Google one: one description built
from steps[0] and reused for every event, so a downloaded calendar sent all
of a task's events to step 1's timer. This affects guests, who have no other
scheduling method.

Events are also marked TRANSP:OPAQUE now - the ICS path is the one place the
intent's busy flag can be honoured literally, since Reclaim decides free vs
busy itself. Placement is deliberately unchanged: back-to-back from the next
top of the hour, because a downloaded file is a do-this-now artifact and
spreading it over three days would regress the guest flow.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 9: Verify the format against the live account, then the e2e guard

**Files:**
- Create: `scripts/verify-reclaim-syntax.ts`
- Create: `e2e/smoke/schedule-order.spec.ts`

**Interfaces:** none — this task consumes everything and exports nothing.

This is the task that closes the spec's only unverified assumption: whether Reclaim reads `[6/7]` as *6 July*.

- [ ] **Step 1: Write the one-shot verification script**

Create `scripts/verify-reclaim-syntax.ts`:

```ts
/**
 * One-shot manual check of the assumption the title format rests on: that
 * Reclaim treats `[6/7]` as text, not as a date (#104).
 *
 * NOT part of CI — it writes to the owner's real Google Tasks list. Run it once,
 * read the result, delete the task it created.
 *
 *   npx tsx scripts/verify-reclaim-syntax.ts
 */
import { getValidAccessToken, findReclaimList } from "../src/lib/google";
import { upsertGoogleTask } from "../src/lib/google";

async function main() {
  const token = await getValidAccessToken();
  if (!token) throw new Error("no Google token — connect in Settings first");
  const list = await findReclaimList(token);
  if (!list) throw new Error("no 🗓 Reclaim list found");

  const title =
    "[6/7] ✏️ dlectroflow syntax probe — delete me ~15m " +
    "(duration:30m) (nosplit) (due Aug 7 2026 5:00pm) (priority:P4) (type work)";

  const { id } = await upsertGoogleTask(token, list.id, null, { title, notes: "probe" });
  console.log(`created ${id} in "${list.title}"`);
  console.log("Now check, in Reclaim or the calendar:");
  console.log("  1. does the event title still start with [6/7] ?");
  console.log("  2. is it due 7 August 2026 17:00 — not 6 July ?");
  console.log("  3. is it one 30-minute block, not two 15s ?");
  console.log("Then delete the task.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
```

- [ ] **Step 2: Run it and record the answer**

Run: `npx tsx scripts/verify-reclaim-syntax.ts`

Wait for Reclaim to sync (up to 5 minutes on a free plan), then read the event back — via the Reclaim UI, or `get_schedule` if MCP access is available.

**If the badge survived and the due date is 7 August:** note it in the MR description as verified, with the date checked. Nothing to change.

**If the badge was eaten or the date moved:** change the badge in `encode-reclaim.ts` to `[${order} of ${total}]`, update the exact-string expectations in `encode-reclaim.test.ts`, re-run the probe, and record both results in the MR. Do **not** proceed to Step 3 with an unverified format.

- [ ] **Step 3: Write the e2e guard — for the path e2e can actually reach**

**Read this before writing the spec.** The Google Tasks path is **not** reachable from the e2e environment, and the plan does not pretend otherwise:

- `row-actions.tsx:137` picks the control's label from whether the workspace has a usable Google connection: `iconLabel = isIcs ? "Add to calendar (.ics)" : "Schedule"`. The e2e environment has no `GOOGLE_CLIENT_ID` and no `GoogleAuth` row, so `googleTasksProvider.isAvailable` is false and the 📅 button runs `scheduleViaIcs`. Stubbing `tasks.googleapis.com` would intercept requests that are never made.
- A task with **three steps** needs the breakdown coach, which needs an LLM call. There is no offline fixture for it, and `focus-timer.spec.ts:26` shows the only step a to-do gets is the single one `Start Focus` creates lazily.

So the multi-step ordering guarantee is covered by the unit tests (Task 2, exhaustively) and by the live probe (Step 2 above, against the real Reclaim). What e2e adds that unit tests cannot is that the **wiring survives a production build** — the `"rolling 30 dayswindow"` lesson. That is the `.ics` path, and it is worth having.

Create `e2e/smoke/schedule-ics.spec.ts`:

```ts
import { test, expect } from "@playwright/test";
import { captureItem, needsReviewRow } from "../helpers";

/**
 * The .ics schedule path, end to end in a production build (#104).
 *
 * This is the only scheduling method reachable in e2e: with no Google
 * connection the 📅 control renders as "Add to calendar (.ics)"
 * (row-actions.tsx:137). It guards the wiring — action → buildTaskIcs → Blob
 * download — and the two properties #104 changed in that file: the focus
 * deep-link travels in DESCRIPTION, and events defend their time.
 */
test("scheduling a to-do downloads an .ics with a focus link and busy time", async ({
  page,
}) => {
  const label = `E2E schedule ${Date.now()}`;
  await page.goto("/");
  await captureItem(page, label);

  const row = needsReviewRow(page, label);
  await expect(row).toBeVisible();

  // 📅 opens the duration popover (15/30/60 presets) for a stepless to-do.
  await row.getByRole("button", { name: "Add to calendar (.ics)" }).click();
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "30 min" }).click();

  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(/\.ics$/);

  const stream = await download.createReadStream();
  const chunks: Buffer[] = [];
  for await (const c of stream) chunks.push(Buffer.from(c));
  const ics = Buffer.concat(chunks).toString("utf8");

  expect(ics).toContain("BEGIN:VEVENT");
  expect(ics).toContain(label);
  // The per-step deep link (#104): a real absolute URL into /focus.
  expect(ics).toMatch(/DESCRIPTION:.*\/focus/);
  // busy, not free — the one place the intent's `busy` flag is literal.
  expect(ics).toContain("TRANSP:OPAQUE");
});
```

- [ ] **Step 4: Run the e2e suite**

Run: `npm run build && npm run test:e2e`
Expected: the new spec passes and the existing specs stay green.

If the download event never fires, check whether the row is in the Needs-review bucket (a fresh capture lands there) and whether the button's accessible name is `"Add to calendar (.ics)"` in *this* environment — if a Google connection happens to be configured it will read `"Schedule"` instead, and the spec should be skipped rather than rewritten to chase it.

- [ ] **Step 5: Commit**

```bash
git add scripts/verify-reclaim-syntax.ts e2e/smoke/schedule-ics.spec.ts
git commit -m "test(scheduling): verify the format for real, guard the wiring (#104)

Two checks for two different risks.

The probe settles the one assumption the title format rests on: that Reclaim
reads [6/7] as text and not as 6 July. It writes to the real account, so it
is deliberately not in CI - run once, read the answer, delete the task.

The e2e spec covers the .ics path, which is the only scheduling method
reachable in e2e: with no Google connection the control renders as \"Add to
calendar (.ics)\". Stubbing tasks.googleapis.com would intercept requests
that are never made, and a three-step task needs the breakdown coach and so
an LLM. Ordering stays proven by the window unit tests and the probe; what
e2e adds is that the wiring survives a production build, which is where the
\"rolling 30 dayswindow\" bug got through before.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## Final verification (run before opening the MR)

- [ ] `npm test` — all green, and the count went **up** by the new files
- [ ] `npx tsc --noEmit` — no errors under `src/` (stale `.next/` validator errors are pre-existing)
- [ ] `npm run lint` — clean
- [ ] `npm run format:check` — clean
- [ ] `npm run build && npm run test:e2e` — green, including the new spec
- [ ] The live probe from Task 9 was **actually run** and its answer recorded in the MR description. If the badge changed as a result, the exact-string tests changed with it.
- [ ] Grep for leftovers: `grep -rn "reclaimTitle" src/` returns nothing
- [ ] MR opened with `--reviewer GitLabDuo --milestone v0.5.0 --assignee gitlab_dlectronique`, description containing `Closes #104`, and **not** created with `--fill` (it drags the commit trailer into the description)

## Spec-coverage map (self-review)

| Spec section | Task |
|---|---|
| §1 `ScheduleIntent` vocabulary | Task 2 Step 1 |
| §2 window derivation, working hours, 30-min floor, feasibility | Tasks 1, 2 |
| §3 Reclaim encoder, title format, month-name dates, per-step notes | Task 3 |
| §4 plain encoder, encoder detection, list-name footgun | Task 4 |
| §5 update-in-place | Task 5 |
| §6 `.ics` keeps its placement, takes per-step description + `busy` | Task 8 |
| §7 per-step overrides (C) | Out of scope — `ScheduleUnit.dueAt` and the pinning branch in `deriveWindows` are built and tested here (Task 2) so #107 is UI only |
| Testing: round-trip guard, update-in-place, e2e, real push | Tasks 3, 5, 9 |
| Risks: `[6/7]` date parse, numeric-date ambiguity | Task 9 Step 2, Task 3 |
| Rollout: `no_reclaim_list` message | Task 6 Step 3 |

**Not in this plan, by design:** the three persisted `Task` columns and `Step.scheduleDueAt` (sub-project B/C own their own migrations), and the menu itself. `defaultIntentFor` is exported precisely so B builds on it rather than reinventing the defaults.
