type IcsStep = {
  text: string;
  estMinutes: number;
  subtaskEmoji?: string | null;
  /** Per-step DESCRIPTION (#104). Falls back to the builder's shared `description`. */
  description?: string | null;
};

function pad(n: number): string {
  return String(n).padStart(2, "0");
}
/** Floating local time stamp: YYYYMMDDTHHMMSS (no trailing Z).
 *  Emits the LOCAL wall-clock time of the given Date as a floating (no-Z) stamp,
 *  per RFC 5545 §3.3.5 — the calendar client interprets it in the viewer's local tz.
 */
function floating(d: Date): string {
  return (
    `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}` +
    `T${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
  );
}
/** UTC form: YYYYMMDDTHHMMSSZ (RFC 5545 §3.3.5 form 2) — an absolute instant.
 *  What the data export needs: its events are real scheduled times, so they must
 *  not drift with whatever timezone the reader's calendar happens to be in. */
function utc(d: Date): string {
  return d.toISOString().replace(/[-:]/g, "").slice(0, 15) + "Z";
}
function esc(s: string): string {
  return s
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\n/g, "\\n");
}
function nextTopOfHour(from = new Date()): Date {
  const d = new Date(from);
  d.setMinutes(0, 0, 0);
  d.setHours(d.getHours() + 1);
  return d;
}

/**
 * RFC 5545 §3.1 line folding: no content line may exceed 75 OCTETS, and a
 * continuation is CRLF followed by a single space.
 *
 * Added with #129 and applied to every caller, not just the new one. This
 * serialiser has emitted over-long lines since #39 put a focus deep-link in
 * every DESCRIPTION, and the export makes it unavoidable — its SUMMARY is
 * `<task title>: <step text>`, which passes 75 characters as a matter of course.
 * Google and Apple happen to tolerate unfolded lines; "the two clients I tested
 * cope" is not the bar for a file whose entire purpose is to still work
 * somewhere else, years from now.
 *
 * The limit is in OCTETS, which is the whole reason this is not a `slice`. Every
 * task can carry a `parentEmoji`, and a fold landing inside a UTF-8 sequence
 * produces two invalid lines out of one valid one — so the split point walks
 * back off any continuation byte (`10xxxxxx`) before cutting.
 *
 * Continuation lines get 74 octets of content, because the leading space they
 * are prefixed with counts towards the 75.
 */
function foldLine(line: string): string {
  const bytes = Buffer.from(line, "utf8");
  if (bytes.length <= 75) return line;
  const parts: string[] = [];
  let start = 0;
  while (start < bytes.length) {
    const limit = parts.length === 0 ? 75 : 74;
    let end = Math.min(bytes.length, start + limit);
    while (end > start && end < bytes.length && (bytes[end] & 0xc0) === 0x80) {
      end--;
    }
    // Guarantee forward progress. Backing off past `start` happens only for
    // invalid UTF-8 — a lead byte followed by 75+ continuation bytes — which
    // cannot arise here, because the only inputs are JS strings and
    // Buffer.from(s, "utf8") never emits an ill-formed sequence. But if it ever
    // did, `end === start` would push "" and leave `start` unmoved, and the
    // outer loop would spin forever. Splitting mid-sequence is a mangled
    // character; hanging is a wedged request. Raised by review on !253.
    if (end === start) end = Math.min(bytes.length, start + limit);
    parts.push(bytes.subarray(start, end).toString("utf8"));
    start = end;
  }
  return parts.join("\r\n ");
}

/**
 * One VEVENT, described by its actual start and end rather than by a duration
 * the emitter has to place.
 *
 * `uid` is the caller's: RFC 5545 §3.8.4.7 wants it globally unique, and making
 * it derivable from the row it came from (`step-<id>@dlectroflow`) is what makes
 * re-importing the same file update the same events instead of duplicating them.
 */
export type IcsEvent = {
  uid: string;
  start: Date;
  end: Date;
  summary: string;
  description?: string | null;
  /** `TRANSP:OPAQUE` — the event marks the time busy in the viewer's calendar. */
  busy?: boolean;
};

/**
 * The shared calendar emitter (#129).
 *
 * `buildTaskIcs` was the whole ICS surface until now: one task, steps laid
 * back-to-back from an implied start, floating local times. The data export
 * needs the other shape — many tasks, at the instants they were really scheduled
 * for — and #154's per-user subscription feed will need the same again. Rather
 * than a second serialiser with its own escaping bugs, the structure, escaping,
 * DTSTAMP and folding live here and `buildTaskIcs` is now a caller.
 *
 * `timeMode` is the one thing the two callers genuinely disagree about. The
 * per-task download is a *proposal* — "put these steps in the next free hour" —
 * so its times are floating and land at 9am whatever timezone you open them in
 * (§3.3.5 form 1). The export is a *record* of instants, so it writes UTC
 * (form 2) and cannot drift. Defaulting to UTC because a record is the safer
 * thing to be wrong about; the download passes "floating" explicitly.
 *
 * `stamp` is injectable, and is one DTSTAMP for the whole file rather than one
 * per event: they are generated in the same instant, and per-event stamps invite
 * a reader to look for meaning in the microseconds between them.
 */
export function buildIcsCalendar(input: {
  events: readonly IcsEvent[];
  timeMode?: "utc" | "floating";
  /** `X-WR-CALNAME` — what Google and Apple label an imported calendar with. */
  calendarName?: string | null;
  stamp?: Date;
}): string {
  const time = input.timeMode === "floating" ? floating : utc;
  const dtstamp = utc(input.stamp ?? new Date());
  const name = input.calendarName?.trim();
  const lines: string[] = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//dlectroflow//phase2//EN",
    "CALSCALE:GREGORIAN",
    ...(name ? [`X-WR-CALNAME:${esc(name)}`] : []),
  ];
  for (const event of input.events) {
    const description = event.description?.trim();
    lines.push(
      "BEGIN:VEVENT",
      `UID:${event.uid}`,
      `DTSTAMP:${dtstamp}`,
      `DTSTART:${time(event.start)}`,
      `DTEND:${time(event.end)}`,
      `SUMMARY:${esc(event.summary)}`,
      ...(description ? [`DESCRIPTION:${esc(description)}`] : []),
      ...(event.busy ? ["TRANSP:OPAQUE"] : []),
      "END:VEVENT",
    );
  }
  lines.push("END:VCALENDAR");
  // Trailing CRLF: §3.1 terminates every content line, the last one included.
  return lines.map(foldLine).join("\r\n") + "\r\n";
}

/** Build a downloadable .ics: one back-to-back VEVENT per step (floating local time). */
export function buildTaskIcs(input: {
  title: string;
  parentEmoji?: string | null;
  steps: IcsStep[];
  start?: Date;
  fallbackDurationMin?: number;
  /** Optional note (e.g. focus deep-link, #39) added as each VEVENT's DESCRIPTION.
   *  Used when a step carries no `description` of its own — which is still the
   *  only source for the stepless (fallback) event. */
  description?: string;
  /**
   * Defend the time (#104): `TRANSP:OPAQUE` marks the events busy in the
   * viewer's calendar. The ICS path is the one place the intent's `busy` flag
   * can be honoured literally — Reclaim decides free vs busy itself.
   */
  busy?: boolean;
}): string {
  const description = input.description?.trim() || null;
  const start = input.start ?? nextTopOfHour();
  let cursor = new Date(start);
  const events: IcsEvent[] = [];
  input.steps.forEach((s, i) => {
    const dur = Math.max(1, Math.round(s.estMinutes || 25));
    const end = new Date(cursor.getTime() + dur * 60_000);
    const emoji = s.subtaskEmoji ? `${s.subtaskEmoji} ` : "";
    const summary = `${input.parentEmoji ? input.parentEmoji + " " : ""}${input.title}: ${emoji}${s.text}`;
    events.push({
      // Time-derived UID, unchanged: this file is a proposal for a slot rather
      // than a record of a row, and two downloads of the same task deliberately
      // produce two sets of events rather than silently replacing each other.
      uid: `${floating(cursor)}-${i}@dlectroflow`,
      start: new Date(cursor),
      end,
      summary,
      // Per-step note (#104): the defect this replaces built ONE description from
      // steps[0] and reused it, so every event opened the timer on step 1.
      description: s.description?.trim() || description,
      busy: input.busy,
    });
    cursor = end;
  });
  if (input.steps.length === 0 && input.fallbackDurationMin != null) {
    const dur = Math.max(1, Math.round(input.fallbackDurationMin));
    events.push({
      uid: `${floating(start)}-0@dlectroflow`,
      start,
      end: new Date(start.getTime() + dur * 60_000),
      summary: `${input.parentEmoji ? input.parentEmoji + " " : ""}${input.title}`,
      description,
      busy: input.busy,
    });
  }
  return buildIcsCalendar({ events, timeMode: "floating" });
}

/** Download filename for a task's .ics — shared by the ICS route and the
 *  scheduleViaIcs action so the name is defined in exactly one place. */
export function icsFilename(title: string): string {
  const safe = title.replace(/[^a-z0-9]+/gi, "-").slice(0, 40) || "task";
  return `dlectroflow-${safe}.ics`;
}
