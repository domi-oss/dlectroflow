import { describe, it, expect } from "vitest";
import { buildTaskIcs } from "./ics";

describe("buildTaskIcs", () => {
  const ics = buildTaskIcs({
    title: "Ship the thing",
    parentEmoji: "🚀",
    steps: [
      { text: "Plan", estMinutes: 15, subtaskEmoji: "📝" },
      { text: "Build", estMinutes: 30, subtaskEmoji: "🔨" },
    ],
    start: new Date("2026-07-08T09:00:00Z"),
  });
  it("is a valid VCALENDAR with one VEVENT per step", () => {
    expect(ics).toContain("BEGIN:VCALENDAR");
    expect(ics).toContain("END:VCALENDAR");
    expect((ics.match(/BEGIN:VEVENT/g) ?? []).length).toBe(2);
  });
  it("sequences events back-to-back using durations", () => {
    // first event 09:00–09:15, second 09:15–09:45 (floating local time, no Z)
    expect(ics).toContain("DTSTART:20260708T090000");
    expect(ics).toContain("DTSTART:20260708T091500");
  });
  it("escapes commas in summaries", () => {
    const s = buildTaskIcs({ title: "A, B", steps: [{ text: "x, y", estMinutes: 5 }] });
    expect(s).toContain("x\\, y");
  });
});
