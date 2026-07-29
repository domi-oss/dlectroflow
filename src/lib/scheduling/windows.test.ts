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
    expect(windows[1].notBefore!.toISOString()).toBe(
      windows[0].due.toISOString(),
    );
    expect(windows[2].notBefore!.toISOString()).toBe(
      windows[1].due.toISOString(),
    );
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
      expect(w.due.getTime() - from.getTime()).toBeGreaterThanOrEqual(
        w.durationMin * 60_000,
      );
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
      units: [
        unit(1, 30, 3),
        { ...unit(2, 30, 3), dueAt: pinned },
        unit(3, 30, 3),
      ],
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
    const i = intent({
      dueAt: bst("2026-07-29T11:00"), // two hours away
      units: [1, 2, 3, 4, 5, 6, 7].map((n) => unit(n, 60, 7)),
    });
    const plan = deriveWindows(i, bst("2026-07-29T09:00"));
    expect(plan.feasible).toBe(false);
    expect(plan.requiredMin).toBe(420);
    expect(plan.earliestFeasibleDue).toBeInstanceOf(Date);
    // The suggestion is a deadline that actually fits the work, so it lands no
    // earlier than the end of the last window — and, being the point of the
    // warning, strictly LATER than the deadline the user asked for.
    expect(plan.earliestFeasibleDue!.getTime()).toBeGreaterThanOrEqual(
      plan.windows.at(-1)!.due.getTime(),
    );
    expect(plan.earliestFeasibleDue!.getTime()).toBeGreaterThan(
      i.dueAt.getTime(),
    );
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
