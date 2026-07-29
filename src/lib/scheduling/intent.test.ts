import { describe, it, expect } from "vitest";
import { defaultIntentFor } from "./intent";
import { ScheduleHours, SchedulePriority } from "./types";
import { deriveWindows } from "./windows";

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
    expect(defaultIntentFor(units, now).units.map((u) => u.order)).toEqual([
      1, 2,
    ]);
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
