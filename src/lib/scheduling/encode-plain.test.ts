import { describe, it, expect } from "vitest";
import { encodePlain } from "./encode-plain";
import { ScheduleHours, SchedulePriority } from "./types";
import type { ScheduleIntent, ScheduleUnit } from "./types";
import type { ScheduleWindow } from "./windows";

const bst = (iso: string) => new Date(`${iso}:00.000+01:00`);
const unit: ScheduleUnit = {
  id: "step_6",
  order: 6,
  total: 7,
  text: "Note the quoting rules",
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

  // #44 — the plain encoder is what a self-hoster with a bare Google Tasks
  // list gets, so the note has to reach it too and not only the Reclaim path.
  it("carries the user's note above the deep-link (#44)", () => {
    const { notes } = encodePlain({ ...args, taskNote: "call before 5" });
    expect(notes).toContain("call before 5");
    expect(notes.indexOf("call before 5")).toBeLessThan(
      notes.indexOf("/focus/step_6"),
    );
  });

  it("is unchanged when there is no note (#44)", () => {
    expect(encodePlain({ ...args, taskNote: null }).notes).toBe(
      encodePlain(args).notes,
    );
  });

  it("still deep-links to this unit's step", () => {
    expect(encodePlain(args).notes).toContain("/focus/step_6");
  });
});
