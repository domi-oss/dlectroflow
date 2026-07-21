import { describe, it, expect } from "vitest";
import { buildTaskIcs, icsFilename } from "./ics";

describe("buildTaskIcs", () => {
  // Local-time construction (month is 0-indexed: 6 = July) so local accessors
  // yield 20260708T090000 deterministically on any machine timezone.
  const ics = buildTaskIcs({
    title: "Ship the thing",
    parentEmoji: "🚀",
    steps: [
      { text: "Plan", estMinutes: 15, subtaskEmoji: "📝" },
      { text: "Build", estMinutes: 30, subtaskEmoji: "🔨" },
    ],
    start: new Date(2026, 6, 8, 9, 0, 0),
  });
  it("is a valid VCALENDAR with one VEVENT per step", () => {
    expect(ics).toContain("BEGIN:VCALENDAR");
    expect(ics).toContain("END:VCALENDAR");
    expect((ics.match(/BEGIN:VEVENT/g) ?? []).length).toBe(2);
  });
  it("DTSTAMP is a UTC stamp (RFC 5545 §3.8.7.2)", () => {
    expect(ics).toMatch(/DTSTAMP:\d{8}T\d{6}Z/);
  });
  it("sequences events back-to-back using durations", () => {
    // first event 09:00–09:15, second 09:15–09:45 (floating local time, no Z)
    expect(ics).toContain("DTSTART:20260708T090000");
    expect(ics).toContain("DTSTART:20260708T091500");
    expect(ics).toContain("DTEND:20260708T091500");
    expect(ics).toContain("DTEND:20260708T094500");
  });
  it("escapes commas in summaries", () => {
    const s = buildTaskIcs({
      title: "A, B",
      steps: [{ text: "x, y", estMinutes: 5 }],
    });
    expect(s).toContain("x\\, y");
  });
  it("no-steps task with fallbackDurationMin emits exactly one VEVENT titled with the task title", () => {
    const s = buildTaskIcs({
      title: "Call dentist",
      parentEmoji: "📞",
      steps: [],
      fallbackDurationMin: 45,
      start: new Date(2026, 6, 8, 9, 0, 0),
    });
    expect((s.match(/BEGIN:VEVENT/g) ?? []).length).toBe(1);
    expect(s).toContain("SUMMARY:📞 Call dentist");
    expect(s).toContain("DTSTART:20260708T090000");
    expect(s).toContain("DTEND:20260708T094500"); // +45 min
  });
  it("empty steps and no fallbackDurationMin emits zero VEVENTs (unchanged)", () => {
    const s = buildTaskIcs({ title: "x", steps: [] });
    expect((s.match(/BEGIN:VEVENT/g) ?? []).length).toBe(0);
  });

  it("embeds the note as a DESCRIPTION on every step VEVENT when provided (#39)", () => {
    const s = buildTaskIcs({
      title: "Ship the thing",
      steps: [
        { text: "Plan", estMinutes: 15 },
        { text: "Build", estMinutes: 30 },
      ],
      start: new Date(2026, 6, 8, 9, 0, 0),
      description:
        "▶ Open the focus timer for this:\nhttps://app.example/focus/s1",
    });
    // One DESCRIPTION per VEVENT (2 steps → 2)
    expect((s.match(/DESCRIPTION:/g) ?? []).length).toBe(2);
    expect(s).toContain("https://app.example/focus/s1");
    // newline in the note is ICS-escaped (RFC 5545 §3.3.11)
    expect(s).toContain("for this:\\nhttps://app.example/focus/s1");
  });

  it("embeds the note on the fallback (no-steps) VEVENT too (#39)", () => {
    const s = buildTaskIcs({
      title: "Call dentist",
      steps: [],
      fallbackDurationMin: 45,
      start: new Date(2026, 6, 8, 9, 0, 0),
      description: "note https://app.example/focus",
    });
    expect((s.match(/DESCRIPTION:/g) ?? []).length).toBe(1);
    expect(s).toContain("DESCRIPTION:note https://app.example/focus");
  });

  it("omits DESCRIPTION when no note is given (unchanged)", () => {
    const s = buildTaskIcs({
      title: "x",
      steps: [{ text: "a", estMinutes: 5 }],
      start: new Date(2026, 6, 8, 9, 0, 0),
    });
    expect(s).not.toContain("DESCRIPTION:");
  });
});

describe("icsFilename", () => {
  it("slugifies the title and prefixes dlectroflow-", () => {
    expect(icsFilename("Ship the thing")).toBe(
      "dlectroflow-Ship-the-thing.ics",
    );
  });
  it("falls back to 'task' for an empty title", () => {
    expect(icsFilename("")).toBe("dlectroflow-task.ics");
  });
});
