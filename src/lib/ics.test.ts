import { describe, it, expect } from "vitest";
import {
  buildTaskIcs,
  buildIcsCalendar,
  icsFilename,
  scheduledStepEvents,
  type ScheduledTask,
} from "./ics";

/**
 * Undo RFC 5545 §3.1 line folding: CRLF followed by a single space or tab is a
 * continuation, not a line break. Written here rather than exported from
 * `ics.ts` because nothing in the app unfolds — calendar clients do — so it is a
 * test affordance, and a test that used the production folder's own inverse
 * would prove only that the two agree with each other.
 */
function unfoldIcs(ics: string): string {
  return ics.replace(/\r\n[ \t]/g, "");
}

/** Every physical line's length in OCTETS — folding is a byte limit, not a
 *  character limit, which is what makes emoji and accents the interesting case. */
function octetLengths(ics: string): number[] {
  return ics
    .split("\r\n")
    .filter((l) => l.length > 0)
    .map((l) => Buffer.byteLength(l, "utf8"));
}

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
    // #129 — this DESCRIPTION is 76 octets, so it is now FOLDED (RFC 5545 §3.1)
    // and the URL is split across two physical lines. Asserted against the
    // unfolded text, which is what every calendar client sees: the property
    // under test is the escaping, not the line breaking.
    expect(unfoldIcs(s)).toContain("https://app.example/focus/s1");
    // newline in the note is ICS-escaped (RFC 5545 §3.3.11)
    expect(unfoldIcs(s)).toContain("for this:\\nhttps://app.example/focus/s1");
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

/**
 * #129 — the shared calendar emitter.
 *
 * `buildTaskIcs` used to be the whole serialiser: one task, steps laid
 * back-to-back from an implied start, floating local times. The data export
 * needs the other shape — many tasks, events at the instants they were actually
 * scheduled for — and #154's subscription feed will need the same. So the
 * escaping, structure, DTSTAMP and folding moved into `buildIcsCalendar`, which
 * `buildTaskIcs` now calls. One serialiser, three callers.
 */
describe("buildIcsCalendar (#129)", () => {
  const stamp = new Date(Date.UTC(2026, 7, 3, 9, 30, 0));
  const one = {
    uid: "step-abc@dlectroflow",
    start: new Date(Date.UTC(2026, 7, 3, 10, 0, 0)),
    end: new Date(Date.UTC(2026, 7, 3, 10, 25, 0)),
    summary: "Write the thing",
  };

  it("wraps events in a VCALENDAR with VERSION and PRODID", () => {
    const ics = buildIcsCalendar({ events: [one], stamp });
    expect(ics.startsWith("BEGIN:VCALENDAR\r\n")).toBe(true);
    expect(ics).toContain("VERSION:2.0");
    expect(ics).toContain("PRODID:-//dlectroflow//");
    expect(ics).toContain("CALSCALE:GREGORIAN");
    expect(ics.endsWith("END:VCALENDAR\r\n")).toBe(true);
  });

  it("uses CRLF throughout, with no bare LF anywhere (RFC 5545 §3.1)", () => {
    const ics = buildIcsCalendar({ events: [one], stamp });
    expect(ics.replace(/\r\n/g, "")).not.toContain("\n");
  });

  it("writes UTC instants with a trailing Z by default", () => {
    const ics = buildIcsCalendar({ events: [one], stamp });
    expect(ics).toContain("DTSTART:20260803T100000Z");
    expect(ics).toContain("DTEND:20260803T102500Z");
    expect(ics).toContain("DTSTAMP:20260803T093000Z");
  });

  it("writes floating local wall-clock when asked (§3.3.5), for the per-task download", () => {
    // Local-time construction so local accessors are deterministic on any host.
    const ics = buildIcsCalendar({
      events: [
        {
          uid: "u",
          start: new Date(2026, 6, 8, 9, 0, 0),
          end: new Date(2026, 6, 8, 9, 15, 0),
          summary: "s",
        },
      ],
      timeMode: "floating",
      stamp,
    });
    expect(ics).toContain("DTSTART:20260708T090000");
    expect(ics).not.toContain("DTSTART:20260708T090000Z");
  });

  it("passes the UID through verbatim, so a re-import is idempotent", () => {
    const ics = buildIcsCalendar({ events: [one], stamp });
    expect(ics).toContain("UID:step-abc@dlectroflow");
  });

  it("emits one VEVENT per event, in the order given", () => {
    const ics = buildIcsCalendar({
      events: [one, { ...one, uid: "step-def@dlectroflow", summary: "Second" }],
      stamp,
    });
    expect((ics.match(/BEGIN:VEVENT/g) ?? []).length).toBe(2);
    expect(ics.indexOf("Write the thing")).toBeLessThan(ics.indexOf("Second"));
  });

  it("escapes backslash, semicolon, comma and newline in text values (§3.3.11)", () => {
    const ics = buildIcsCalendar({
      events: [{ ...one, summary: "a\\b;c,d\ne", description: "x;y" }],
      stamp,
    });
    // Doubled again for the JS literal: the file really contains
    // `SUMMARY:a\\b\;c\,d\ne`.
    expect(unfoldIcs(ics)).toContain("SUMMARY:a\\\\b\\;c\\,d\\ne");
    expect(ics).toContain("DESCRIPTION:x\\;y");
  });

  it("omits DESCRIPTION for an absent, empty or whitespace-only note", () => {
    for (const description of [undefined, null, "", "   "]) {
      const ics = buildIcsCalendar({
        events: [{ ...one, description }],
        stamp,
      });
      expect(ics, JSON.stringify(description)).not.toContain("DESCRIPTION:");
    }
  });

  it("marks events busy only when asked", () => {
    expect(
      buildIcsCalendar({ events: [{ ...one, busy: true }], stamp }),
    ).toContain("TRANSP:OPAQUE");
    expect(buildIcsCalendar({ events: [one], stamp })).not.toContain(
      "TRANSP:OPAQUE",
    );
  });

  it("names the calendar when asked, and escapes the name", () => {
    // X-WR-CALNAME is what Google and Apple label an imported calendar with; an
    // import of seven months of tasks called "Untitled" is technically fine and
    // practically useless.
    expect(
      buildIcsCalendar({
        events: [one],
        calendarName: "dlectroflow, all",
        stamp,
      }),
    ).toContain("X-WR-CALNAME:dlectroflow\\, all");
    expect(buildIcsCalendar({ events: [one], stamp })).not.toContain(
      "X-WR-CALNAME",
    );
  });

  it("emits an event-less VCALENDAR rather than throwing", () => {
    // The empty state: an account with nothing scheduled still gets the file, so
    // the archive's contents do not depend on how much data you happen to have.
    const ics = buildIcsCalendar({ events: [], stamp });
    expect(ics).toContain("BEGIN:VCALENDAR");
    expect(ics).not.toContain("BEGIN:VEVENT");
  });
});

describe("RFC 5545 §3.1 line folding (#129)", () => {
  const stamp = new Date(Date.UTC(2026, 7, 3, 9, 30, 0));

  it("keeps every physical line inside 75 octets", () => {
    // Real data: an export's SUMMARY is "<task title>: <step text>", which
    // passes 75 characters routinely. Unfolded, a strict parser is entitled to
    // reject the file — and this serialiser has been emitting over-long
    // DESCRIPTION lines for the focus deep-link since #39.
    const ics = buildIcsCalendar({
      events: [
        {
          uid: "u",
          start: new Date(Date.UTC(2026, 7, 3, 10, 0)),
          end: new Date(Date.UTC(2026, 7, 3, 11, 0)),
          summary: "Ship the enormous thing ".repeat(12),
          description: "https://app.example/focus/".repeat(8),
        },
      ],
      stamp,
    });
    for (const length of octetLengths(ics))
      expect(length).toBeLessThanOrEqual(75);
  });

  it("continues folded lines with a single leading space, and unfolds losslessly", () => {
    const summary = "x".repeat(400);
    const ics = buildIcsCalendar({
      events: [
        {
          uid: "u",
          start: new Date(Date.UTC(2026, 7, 3, 10, 0)),
          end: new Date(Date.UTC(2026, 7, 3, 11, 0)),
          summary,
        },
      ],
      stamp,
    });
    expect(ics).toMatch(/\r\n x/);
    expect(unfoldIcs(ics)).toContain(`SUMMARY:${summary}`);
  });

  it("never splits a multi-byte character across the fold", () => {
    // The reason folding counts octets and not characters. A fold landing inside
    // a UTF-8 sequence produces two invalid lines, and an emoji title is not an
    // edge case in this app — every task can carry a parentEmoji.
    const summary = "🚀".repeat(60);
    const ics = buildIcsCalendar({
      events: [
        {
          uid: "u",
          start: new Date(Date.UTC(2026, 7, 3, 10, 0)),
          end: new Date(Date.UTC(2026, 7, 3, 11, 0)),
          summary,
        },
      ],
      stamp,
    });
    for (const length of octetLengths(ics))
      expect(length).toBeLessThanOrEqual(75);
    expect(ics).not.toContain("�");
    expect(unfoldIcs(ics)).toContain(`SUMMARY:${summary}`);
  });

  it("leaves a line that already fits exactly alone", () => {
    const ics = buildIcsCalendar({
      events: [
        {
          uid: "u",
          start: new Date(Date.UTC(2026, 7, 3, 10, 0)),
          end: new Date(Date.UTC(2026, 7, 3, 11, 0)),
          // "SUMMARY:" is 8 octets, so 67 more makes exactly 75.
          summary: "y".repeat(67),
        },
      ],
      stamp,
    });
    expect(ics).toContain(`\r\nSUMMARY:${"y".repeat(67)}\r\n`);
  });
});

/**
 * #154 — the step/due-date mapping, lifted out of `src/lib/export/calendar.ts`
 * so the subscription feed is a second caller rather than a second copy.
 *
 * These tests exercise it directly on hand-built rows. The export's own
 * behaviour is still asserted end-to-end in `src/lib/export/calendar.test.ts`;
 * this block is what makes the RULES testable without an `ExportSnapshot`.
 */
describe("scheduledStepEvents (#154)", () => {
  const at = (h: number, m = 0) => new Date(Date.UTC(2026, 7, 3, h, m));

  function task(over: Partial<ScheduledTask> = {}): ScheduledTask {
    return {
      id: "t1",
      title: "Renew the passport",
      parentEmoji: null,
      scheduleDueAt: null,
      steps: [],
      ...over,
    };
  }

  function step(over: Partial<ScheduledTask["steps"][number]> = {}) {
    return {
      id: "s1",
      text: "Find the old one",
      estMinutes: 15,
      subtaskEmoji: null,
      scheduledAt: at(9),
      ...over,
    };
  }

  it("emits one event per scheduled step, at the instant it was scheduled for", () => {
    const [event] = scheduledStepEvents([task({ steps: [step()] })]);
    expect(event).toMatchObject({
      uid: "step-s1@dlectroflow",
      start: at(9),
      end: at(9, 15),
      summary: "Renew the passport: Find the old one",
    });
  });

  it("emits nothing for a step with no scheduled time", () => {
    expect(
      scheduledStepEvents([task({ steps: [step({ scheduledAt: null })] })]),
    ).toEqual([]);
  });

  it("emits a due-date marker for a task that has one", () => {
    const [event] = scheduledStepEvents([task({ scheduleDueAt: at(12) })]);
    expect(event.summary).toBe("Renew the passport (due)");
    expect(event.uid).toBe("task-t1@dlectroflow");
  });

  it("emits nothing at all for Task.scheduledAt — it is not a time to do it", () => {
    // The rule the export's README states: `scheduledAt` records WHEN IT WAS
    // SCHEDULED, so an event there is an appointment at the moment somebody
    // pressed a button.
    expect(scheduledStepEvents([task()])).toEqual([]);
  });

  it("collapses whitespace in a summary — a calendar title is one line", () => {
    const [event] = scheduledStepEvents([
      task({ steps: [step({ text: "Write it\nacross   two lines" })] }),
    ]);
    expect(event.summary).toBe("Renew the passport: Write it across two lines");
  });

  it("prefixes the task and step emoji when present", () => {
    const [event] = scheduledStepEvents([
      task({
        parentEmoji: "🛂",
        steps: [step({ subtaskEmoji: "🔍" })],
      }),
    ]);
    expect(event.summary).toBe("🛂 Renew the passport: 🔍 Find the old one");
  });

  it("clamps a zero-or-negative estimate so DTEND never precedes DTSTART", () => {
    const [event] = scheduledStepEvents([
      task({ steps: [step({ estMinutes: 0 })] }),
    ]);
    expect(event.end.getTime()).toBeGreaterThan(event.start.getTime());
  });

  it("returns events in chronological order across tasks", () => {
    const events = scheduledStepEvents([
      task({
        id: "late",
        steps: [step({ id: "s-late", scheduledAt: at(16) })],
      }),
      task({
        id: "early",
        steps: [step({ id: "s-early", scheduledAt: at(8) })],
      }),
    ]);
    expect(events.map((e) => e.uid)).toEqual([
      "step-s-early@dlectroflow",
      "step-s-late@dlectroflow",
    ]);
  });

  it("marks nothing busy — neither the archive nor the feed may block a calendar", () => {
    const [event] = scheduledStepEvents([task({ steps: [step()] })]);
    expect(event.busy).toBeUndefined();
  });

  /**
   * The one thing the feed needs and the export must not have. A subscription is
   * "what is coming up", so it drops events that finished before the window
   * opens; an archive is everything, so it passes no window at all.
   */
  describe("the optional `since` window (#154)", () => {
    it("drops an event that ENDED before the window opens", () => {
      const events = scheduledStepEvents(
        [task({ steps: [step({ scheduledAt: at(8) })] })],
        { since: at(9) },
      );
      expect(events).toEqual([]);
    });

    it("keeps an event still running when the window opens", () => {
      // Starts 08:50, ends 09:05 — it straddles the boundary, and dropping it
      // would put a hole in today.
      const events = scheduledStepEvents(
        [task({ steps: [step({ scheduledAt: at(8, 50) })] })],
        { since: at(9) },
      );
      expect(events).toHaveLength(1);
    });

    it("keeps everything when no window is given", () => {
      const events = scheduledStepEvents([
        task({ steps: [step({ scheduledAt: new Date(0) })] }),
      ]);
      expect(events).toHaveLength(1);
    });
  });
});
