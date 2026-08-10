import { describe, it, expect } from "vitest";
import { focusUrl, buildScheduleNote } from "./note";

describe("focusUrl", () => {
  it("deep-links to the specific step when a stepId is given", () => {
    expect(focusUrl("https://app.example", "step_123")).toBe(
      "https://app.example/focus/step_123",
    );
  });
  it("links to the focus launcher when there is no step", () => {
    expect(focusUrl("https://app.example")).toBe("https://app.example/focus");
    expect(focusUrl("https://app.example", null)).toBe(
      "https://app.example/focus",
    );
  });
  it("tolerates a trailing slash on the origin", () => {
    expect(focusUrl("https://app.example/", "s1")).toBe(
      "https://app.example/focus/s1",
    );
  });
});

describe("buildScheduleNote", () => {
  it("plain voice: prompt line + the absolute step deep-link", () => {
    const note = buildScheduleNote({
      origin: "https://app.example",
      voice: "plain",
      stepId: "s1",
    });
    expect(note).toContain("https://app.example/focus/s1");
    expect(note).toMatch(/focus timer/i);
    expect(note).not.toContain("🍽️"); // plain voice has no decorative emoji
  });

  it("playful voice: uses the playful prompt but the same URL", () => {
    const note = buildScheduleNote({
      origin: "https://app.example",
      voice: "playful",
      stepId: "s1",
    });
    expect(note).toContain("🍽️");
    expect(note).toContain("https://app.example/focus/s1");
  });

  it("no step → launcher URL (never a bare /focus/)", () => {
    const note = buildScheduleNote({
      origin: "https://app.example",
      voice: "plain",
    });
    expect(note).toContain("https://app.example/focus");
    expect(note).not.toMatch(/\/focus\/(?:\s|$)/);
  });
});

describe("buildScheduleNote — the task's own note (#44)", () => {
  const base = { origin: "https://app.example", voice: "plain" as const };

  it("puts the user note FIRST, above the prompt and the link", () => {
    // Order is a product decision, not a formatting one. A calendar slot and a
    // Google Tasks list both show only the first line or two, and the note is
    // the part that carries the context ("bring the Figma link"); the deep-link
    // is the action you take once you have read it.
    const note = buildScheduleNote({
      ...base,
      stepId: "s1",
      taskNote: "Bring the Figma link",
    });
    expect(note.indexOf("Bring the Figma link")).toBeLessThan(
      note.indexOf("https://app.example/focus/s1"),
    );
    expect(note.startsWith("Bring the Figma link")).toBe(true);
  });

  it("separates the note from the prompt with a blank line", () => {
    // Without it the last line of a multi-line note reads as part of the prompt.
    const note = buildScheduleNote({
      ...base,
      stepId: "s1",
      taskNote: "call before 5",
    });
    expect(note).toMatch(/call before 5\n\n▶ /);
  });

  it("is byte-identical to the no-note output for every absent-note shape", () => {
    // The two callers that predate #44 (`ics-schedule.ts`, `encode-reclaim.ts`
    // via `encode-plain.ts`) pass nothing, and a task with no note must produce
    // exactly what it produced before this feature existed.
    const before = buildScheduleNote({ ...base, stepId: "s1" });
    for (const note of [undefined, null, "", "   \n  "]) {
      expect(buildScheduleNote({ ...base, stepId: "s1", taskNote: note })).toBe(
        before,
      );
      expect(buildScheduleNote({ ...base, stepId: "s1", stepNote: note })).toBe(
        before,
      );
    }
  });

  it("trims the note but keeps its interior line breaks", () => {
    const note = buildScheduleNote({
      ...base,
      stepId: "s1",
      taskNote: "  one\ntwo  ",
    });
    expect(note.startsWith("one\ntwo\n\n")).toBe(true);
  });

  it("carries the note on the launcher (stepless) note too", () => {
    const note = buildScheduleNote({
      ...base,
      stepId: null,
      taskNote: "no steps, still context",
    });
    expect(note).toContain("no steps, still context");
    expect(note).toContain("https://app.example/focus");
  });

  it("does NOT escape — escaping belongs to the serialiser that knows the format", () => {
    // Load-bearing. The same string goes into an ICS DESCRIPTION (RFC 5545
    // §3.3.11 escaping, via `esc()`) and into a Google Task `notes` field (JSON,
    // where a backslash-escaped semicolon would be visible junk). Escaping here
    // would be wrong for one of them, and double-escaping for the other.
    const note = buildScheduleNote({
      ...base,
      stepId: "s1",
      taskNote: "a;b,c\\d",
    });
    expect(note).toContain("a;b,c\\d");
  });
});

describe("buildScheduleNote — task note AND step note together (#44)", () => {
  const base = { origin: "https://app.example", voice: "plain" as const };

  it("carries BOTH, task note first, then the step's", () => {
    // The decision, and the reasoning is in the module: a calendar entry is read
    // ALONE, days later, with no access to the app. Dropping the task-level
    // context because the step happens to have its own note would mean the more
    // you annotate, the less context each entry carries.
    const note = buildScheduleNote({
      ...base,
      stepId: "s1",
      taskNote: "Bring the Figma link",
      stepNote: "call Sam first",
    });
    expect(note.indexOf("Bring the Figma link")).toBeLessThan(
      note.indexOf("call Sam first"),
    );
    expect(note.indexOf("call Sam first")).toBeLessThan(
      note.indexOf("https://app.example/focus/s1"),
    );
  });

  it("separates the two notes with a blank line, not a bare newline", () => {
    // They are two different people's-worth of thought written at different
    // times. Run together they read as one paragraph with a non-sequitur in it.
    const note = buildScheduleNote({
      ...base,
      stepId: "s1",
      taskNote: "task ctx",
      stepNote: "step ctx",
    });
    expect(note.startsWith("task ctx\n\nstep ctx\n\n")).toBe(true);
  });

  it("emits the text once when the two notes are identical", () => {
    // The copy-paste case. Printing the same sentence twice in a calendar entry
    // reads as a bug, and it is one the user cannot fix from the app.
    const note = buildScheduleNote({
      ...base,
      stepId: "s1",
      taskNote: "same thing",
      stepNote: "  same thing  ",
    });
    expect((note.match(/same thing/g) ?? []).length).toBe(1);
  });

  it("keeps a step note that is a SUBSTRING of the task note (!270)", () => {
    // The dedupe is whole-value equality, never a substring test. Duo review
    // (!270) named the bug the other reading would be, so it is pinned here
    // rather than left to the comment: a step note that merely appears inside
    // the task's is a DIFFERENT, narrower instruction, and dropping it would
    // silently lose the more specific one — the exact failure the both-notes
    // decision above exists to avoid.
    const note = buildScheduleNote({
      ...base,
      stepId: "s1",
      taskNote: "call Sam first, then the bank",
      stepNote: "call Sam",
    });
    expect(note).toContain("call Sam first, then the bank");
    expect(
      note.startsWith("call Sam first, then the bank\n\ncall Sam\n\n"),
    ).toBe(true);
  });

  it("uses whichever one exists when only one does", () => {
    const onlyStep = buildScheduleNote({
      ...base,
      stepId: "s1",
      taskNote: null,
      stepNote: "step only",
    });
    expect(onlyStep.startsWith("step only\n\n")).toBe(true);

    const onlyTask = buildScheduleNote({
      ...base,
      stepId: "s1",
      taskNote: "task only",
      stepNote: null,
    });
    expect(onlyTask.startsWith("task only\n\n")).toBe(true);
  });
});
