import { describe, it, expect } from "vitest";
import { scheduledIcs } from "./calendar";
import { makeSnapshot, makeEmptySnapshot } from "./__tests__/fixture";

const unfold = (ics: string) => ics.replace(/\r\n[ \t]/g, "");
const ics = scheduledIcs(makeSnapshot());

describe("scheduled.ics", () => {
  it("is a VCALENDAR built by the shared serialiser", () => {
    expect(ics).toContain("BEGIN:VCALENDAR");
    expect(ics).toContain("PRODID:-//dlectroflow//");
    expect(ics.endsWith("END:VCALENDAR\r\n")).toBe(true);
  });

  it("uses VEVENT, never VTODO", () => {
    // Agreed on the issue with the trade-off written down: VTODO is the
    // semantically correct component for a task, and Google Calendar ignores it
    // entirely, so the correct choice is the useless one. README.md says so.
    expect(ics).toContain("BEGIN:VEVENT");
    expect(ics).not.toContain("VTODO");
  });

  it("names the calendar, so an import is not labelled Untitled", () => {
    expect(ics).toContain("X-WR-CALNAME:dlectroflow");
  });

  it("emits one event per SCHEDULED STEP, at the instant it was scheduled for", () => {
    // step-1 is scheduled 2026-07-02T09:00Z for 15 minutes.
    expect(ics).toContain("DTSTART:20260702T090000Z");
    expect(ics).toContain("DTEND:20260702T091500Z");
  });

  it("emits one event per task DUE DATE", () => {
    // task-2 (stepless) is due 2026-07-10T12:00Z.
    expect(ics).toContain("DTSTART:20260710T120000Z");
    expect(unfold(ics)).toContain("Renew the passport (due)");
  });

  it("emits nothing for a step with no scheduled time", () => {
    // step-2 has scheduledAt null: it is on a list, not in a calendar.
    expect(unfold(ics)).not.toContain("Write it across two lines");
  });

  it("emits nothing for a task whose only timestamp is `scheduledAt`", () => {
    // task-3 was scheduled via Google but has no due date and no scheduled step.
    // `Task.scheduledAt` records WHEN IT WAS SCHEDULED, not when to do it, so an
    // event at that instant would be an appointment at the moment somebody
    // pressed a button. README.md states the rule.
    expect(unfold(ics)).not.toContain("Tidy the garage");
    expect(ics).not.toContain("DTSTART:20260704T110500Z");
  });

  it("emits exactly the events those rules describe, and no others", () => {
    // Three, from three tasks: step-1's slot, task-1's due date and task-2's due
    // date. Nothing for step-2 (no scheduled time) and nothing at all for task-3.
    expect((ics.match(/BEGIN:VEVENT/g) ?? []).length).toBe(3);
    expect([...ics.matchAll(/^UID:(.+)$/gm)].map((m) => m[1])).toEqual([
      "step-step-1@dlectroflow",
      "task-task-1@dlectroflow",
      "task-task-2@dlectroflow",
    ]);
  });

  it("names each event with its task and step, and its emoji", () => {
    expect(unfold(ics)).toContain(
      'SUMMARY:🚀 Ship "the thing"\\, with a newline\\; and a 🚀: 📝 Draft the outline\\, then stop',
    );
  });

  it("flattens a multi-line title into the SUMMARY", () => {
    // An escaped `\n` in a SUMMARY is legal and renders as a two-line event title
    // in some clients and as a literal `\n` in others. A calendar entry is a
    // one-line thing; the untouched text is in export.json.
    expect(ics).not.toMatch(/SUMMARY:[^\r\n]*\\n/);
  });

  it("derives every UID from the row it came from, so a re-import is idempotent", () => {
    // Stable ids (already cuid) mean importing the same file twice updates the
    // same events rather than duplicating them.
    expect(ics).toContain("UID:step-step-1@dlectroflow");
    expect(ics).toContain("UID:task-task-2@dlectroflow");
  });

  it("orders events chronologically", () => {
    expect(ics.indexOf("20260702T090000Z")).toBeLessThan(
      ics.indexOf("20260710T120000Z"),
    );
  });

  it("does not mark the imported time busy", () => {
    // TRANSP:OPAQUE is right for the per-task download, where the user is
    // actively defending a slot (#104). Importing an archive of past and future
    // scheduled work must not silently block somebody's calendar.
    expect(ics).not.toContain("TRANSP:OPAQUE");
  });

  it("folds long lines, so a strict parser accepts the file", () => {
    for (const line of ics.split("\r\n").filter(Boolean)) {
      expect(Buffer.byteLength(line, "utf8")).toBeLessThanOrEqual(75);
    }
  });

  it("uses UTC instants everywhere, with no floating times", () => {
    for (const match of ics.matchAll(/^DT(?:START|END|STAMP):(.+)$/gm)) {
      expect(match[1]).toMatch(/^\d{8}T\d{6}Z$/);
    }
  });

  it("produces a valid, event-less calendar for an account with nothing scheduled", () => {
    const empty = scheduledIcs(makeEmptySnapshot());
    expect(empty).toContain("BEGIN:VCALENDAR");
    expect(empty).toContain("END:VCALENDAR");
    expect(empty).not.toContain("BEGIN:VEVENT");
  });

  it("clamps a non-positive estimate rather than emitting DTEND before DTSTART", () => {
    // Step.estMinutes is CHECK-constrained to >= 1 in the database (#78), so this
    // is defence against a future writer, not against today's data — and an event
    // that ends before it starts is rejected by some clients and silently dropped
    // by others.
    const snapshot = makeSnapshot();
    snapshot.tasks[0].steps[0].estMinutes = 0;
    const out = scheduledIcs(snapshot);
    expect(out).toContain("DTSTART:20260702T090000Z");
    expect(out).toContain("DTEND:20260702T090100Z");
  });
});
