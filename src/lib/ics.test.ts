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
    expect(buildTaskIcs({ title: "t", steps, busy: true })).toContain(
      "TRANSP:OPAQUE",
    );
    expect(buildTaskIcs({ title: "t", steps })).not.toContain("TRANSP:OPAQUE");
  });

  it("still lays steps back-to-back from the same start — placement is unchanged", () => {
    // Local-time construction (month 0-indexed: 6 = July), matching the top of
    // this file: `floating()` reads LOCAL accessors, so an offset-anchored
    // literal would assert 10:00 only on a +01:00 host and fail on UTC CI.
    const start = new Date(2026, 6, 29, 10, 0, 0);
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
