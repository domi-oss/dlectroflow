import { describe, it, expect } from "vitest";
import {
  DEFAULT_DUE_DAYS,
  defaultIntentFor,
  mergePersistedIntent,
} from "./intent";
import { ScheduleHours, SchedulePriority } from "./types";
import { deriveWindows } from "./windows";

describe("defaultIntentFor — what the no-menu path sends", () => {
  const now = new Date("2026-07-29T09:00:00.000+01:00");
  const units = [
    { id: "s1", order: 1, total: 2, text: "a", estMinutes: 15 },
    { id: "s2", order: 2, total: 2, text: "b", estMinutes: 45 },
  ];

  it("defaults the deadline a week out, so the scheduler is not fighting it", () => {
    const i = defaultIntentFor(units, now);
    expect(i.dueAt.getTime()).toBe(
      now.getTime() + DEFAULT_DUE_DAYS * 24 * 60 * 60_000,
    );
  });

  // Pins the VALUE, not just the arithmetic. Reclaim placed work sessions after
  // a 3-day deadline in production, which is the at-risk state this app should
  // not manufacture by default (#106 is where a tighter deadline gets chosen
  // deliberately). Regressing this to 3 should fail loudly, not silently.
  it("is a week, not Reclaim's 3-day default", () => {
    expect(DEFAULT_DUE_DAYS).toBe(7);
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
    expect(defaultIntentFor(units, now).units.map((u) => u.order)).toEqual([
      1, 2,
    ]);
  });
});

describe("mergePersistedIntent — what the Schedule menu opens with (#106)", () => {
  const now = new Date("2026-07-29T09:00:00.000+01:00");
  const units = [
    { id: "s1", order: 1, total: 2, text: "a", estMinutes: 15 },
    { id: "s2", order: 2, total: 2, text: "b", estMinutes: 45 },
  ];
  const nothingPersisted = {
    scheduleDueAt: null,
    schedulePriority: null,
    scheduleHours: null,
  };

  it("falls back to the defaults when nothing has ever been persisted", () => {
    const i = mergePersistedIntent(units, nothingPersisted, now);
    expect(i).toEqual(defaultIntentFor(units, now));
  });

  it("prefers every persisted field over the default", () => {
    const dueAt = new Date("2026-08-07T16:00:00.000Z");
    const i = mergePersistedIntent(
      units,
      {
        scheduleDueAt: dueAt,
        schedulePriority: "critical",
        scheduleHours: "personal",
      },
      now,
    );
    expect(i.dueAt.toISOString()).toBe(dueAt.toISOString());
    expect(i.priority).toBe(SchedulePriority.Critical);
    expect(i.hours).toBe(ScheduleHours.Personal);
  });

  it("mixes persisted and default fields independently", () => {
    const i = mergePersistedIntent(
      units,
      { ...nothingPersisted, schedulePriority: "low" },
      now,
    );
    expect(i.priority).toBe(SchedulePriority.Low);
    expect(i.hours).toBe(ScheduleHours.Work);
    // The persisted priority wins; the ABSENT deadline still falls back to the
    // shared default, so this reads it from the constant rather than repeating
    // the number (which is how it went stale when the default changed).
    expect(i.dueAt.getTime()).toBe(
      now.getTime() + DEFAULT_DUE_DAYS * 24 * 60 * 60_000,
    );
  });

  // A CHECK constraint makes this unreachable, but this output goes straight
  // into a Reclaim title parameter: "trust the database" is how one bad row
  // becomes a malformed schedule.
  it("ignores values the columns should never have held", () => {
    const i = mergePersistedIntent(
      units,
      { scheduleDueAt: null, schedulePriority: "urgent", scheduleHours: "" },
      now,
    );
    expect(i.priority).toBe(SchedulePriority.High);
    expect(i.hours).toBe(ScheduleHours.Work);
  });

  it("carries the units through in order", () => {
    const i = mergePersistedIntent([units[1], units[0]], nothingPersisted, now);
    expect(i.units.map((u) => u.id)).toEqual(["s1", "s2"]);
  });
});

describe("a single to-do has nothing to sequence", () => {
  it("gets one window, no notBefore, due on the deadline", () => {
    const now = new Date("2026-07-29T09:00:00.000+01:00");
    const intent = defaultIntentFor(
      [
        {
          id: "t1",
          order: 1,
          total: 1,
          text: "Book the dentist",
          estMinutes: 20,
        },
      ],
      now,
    );
    const { windows } = deriveWindows(intent, now);
    expect(windows).toHaveLength(1);
    expect(windows[0].notBefore).toBeNull();
    expect(windows[0].due.toISOString()).toBe(intent.dueAt.toISOString());
    expect(windows[0].durationMin).toBe(30);
  });
});
