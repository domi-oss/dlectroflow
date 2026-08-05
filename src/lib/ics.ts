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
/**
 * RFC 5545 §3.3.11 TEXT escaping.
 *
 * The order is load-bearing: backslash first, or the backslashes this function
 * introduces get escaped a second time.
 *
 * **Every line terminator, not just LF (#154 review).** CR was missed until a
 * review found it, and it is the one that matters most: §3.3.11 admits no
 * control character but HTAB, and a literal CR inside a value ends the content
 * line early under a lenient parser, turning one property into two. `oneLine`
 * in `src/lib/calendar-feed.ts` collapses whitespace on titles and step text,
 * but `parentEmoji` and `subtaskEmoji` bypass it and are persisted straight
 * from a model proposal, so the terminator has a real route in. The gate
 * belongs here rather than at those two call sites, because this is the shared
 * serialiser behind the feed, `/api/ics/[taskId]` and the #129 export — fixing
 * the callers would leave the primitive still wrong for the next one.
 *
 * CRLF collapses to a single `\n`, not two: it is one line ending, and emitting
 * two would open a blank line in somebody's calendar entry. The remaining C0
 * controls are dropped outright — no legitimate title contains one, and there
 * is no escape sequence for them to survive as.
 */
function esc(s: string): string {
  return (
    s
      .replace(/\\/g, "\\\\")
      .replace(/;/g, "\\;")
      .replace(/,/g, "\\,")
      .replace(/\r\n|\r|\n/g, "\\n")
      // Spelled as code points because §3.3.11 is: HTAB (\x09) is the single
      // control character it permits, and CR/LF are handled by the line above.
      .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "")
  );
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
      // Escaped like any other value, though every UID today is machine-derived
      // (`step-`/`task-` plus a cuid, or a timestamp) and has nothing to escape.
      // A gate rather than a comment saying it is safe: the next person to
      // derive a UID from user text inherits the protection instead of having
      // to notice its absence (#154 review).
      `UID:${esc(event.uid)}`,
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

/**
 * A task as the scheduled-work mapping below needs to see it — structural, so
 * both a Prisma row (`Task & { steps: Step[] }`) and a hand-built fixture
 * satisfy it with no adapter.
 */
export type ScheduledTask = {
  id: string;
  title: string;
  parentEmoji: string | null;
  scheduleDueAt: Date | null;
  steps: readonly {
    id: string;
    text: string;
    estMinutes: number;
    subtaskEmoji: string | null;
    scheduledAt: Date | null;
  }[];
};

/** How long a due-date marker lasts. Matches the ICS download's default slot
 *  (`DEFAULT_ICS_DURATION_MIN` in `src/app/actions/ics-schedule.ts`), so the
 *  surfaces do not disagree about what "a task-shaped amount of time" is. */
const DUE_EVENT_MINUTES = 25;

/** Collapse whitespace: a calendar entry's title is a one-line thing, and an
 *  escaped `\n` in a SUMMARY renders as a literal backslash-n in some clients.
 *  The untouched text is in `export.json`. */
function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function taskLabel(task: ScheduledTask): string {
  return `${task.parentEmoji ? `${task.parentEmoji} ` : ""}${oneLine(task.title)}`;
}

/**
 * Scheduled work → VEVENTs. The mapping shared by the data export (#129) and
 * the per-user subscription feed (#154).
 *
 * It lives here rather than in `src/lib/export/calendar.ts`, where #129 wrote
 * it, because the feed is a second consumer and a second copy of these rules is
 * how the two surfaces would come to disagree about what a person's calendar
 * contains. `export/calendar.ts` is now a caller and keeps its own end-to-end
 * tests.
 *
 * ## VEVENT, not VTODO
 *
 * `VTODO` is the semantically correct iCalendar component for a task: it has
 * `DUE`, `PERCENT-COMPLETE` and `STATUS:COMPLETED`, which is exactly this data.
 * **Google Calendar ignores `VTODO` entirely** — an import succeeds and shows
 * nothing. So the correct choice is the useless one.
 *
 * ## Which rows become events, and which deliberately do not
 *
 * This turns on what `Task.scheduledAt` actually means:
 *
 *  1. **Every `Step` with a `scheduledAt`** becomes an event at that instant,
 *     `estMinutes` long. This is the real calendar content — the slot the person
 *     put aside to do one thing.
 *  2. **Every `Task` with a `scheduleDueAt`** becomes a short marker event at the
 *     deadline. A due date is a point in somebody's calendar, so it belongs in
 *     one; without `VTODO` there is no other way to say "due".
 *  3. **`Task.scheduledAt` produces NOTHING.** It records *when the task was
 *     scheduled*, by whichever method got there first (see the schema comment),
 *     not *when to do it*. An event at that instant would be an appointment at
 *     the moment somebody pressed a button — worse than useless, because it looks
 *     like data.
 *
 * ## No `TRANSP:OPAQUE`
 *
 * The per-task download marks its events busy, because that is a live request to
 * defend a slot (#104). Neither caller here is: an archive of past and future
 * work must not silently block out somebody's calendar, and neither must a feed
 * somebody subscribed to in order to *see* their plan.
 *
 * ## `since` — the one thing the two callers disagree about
 *
 * The export passes nothing and gets everything, because an archive that
 * silently dropped rows would be the failure that feature exists to fix. The
 * feed passes a window, because a subscription answers "what is coming up" and
 * would otherwise grow without bound in somebody's calendar provider. The
 * comparison is against an event's END, so a slot still running when the window
 * opens is kept rather than leaving a hole in today.
 */
export function scheduledStepEvents(
  tasks: readonly ScheduledTask[],
  opts?: { since?: Date },
): IcsEvent[] {
  const since = opts?.since?.getTime();
  const events: IcsEvent[] = [];

  for (const task of tasks) {
    for (const step of task.steps) {
      if (!step.scheduledAt) continue;
      // Clamped to at least a minute. The database CHECK already enforces >= 1
      // (#78), so this defends against a future writer rather than today's data —
      // and an event whose DTEND precedes its DTSTART is rejected by some clients
      // and silently dropped by others.
      const minutes = Math.max(1, Math.round(step.estMinutes || 1));
      const emoji = step.subtaskEmoji ? `${step.subtaskEmoji} ` : "";
      events.push({
        // Derived from the row's own id (already a cuid), so re-reading the same
        // feed updates the same events instead of duplicating them.
        uid: `step-${step.id}@dlectroflow`,
        start: step.scheduledAt,
        end: new Date(step.scheduledAt.getTime() + minutes * 60_000),
        summary: `${taskLabel(task)}: ${emoji}${oneLine(step.text)}`,
      });
    }

    if (task.scheduleDueAt) {
      events.push({
        uid: `task-${task.id}@dlectroflow`,
        start: task.scheduleDueAt,
        end: new Date(
          task.scheduleDueAt.getTime() + DUE_EVENT_MINUTES * 60_000,
        ),
        // "(due)" in the SUMMARY is doing the work `VTODO`'s `DUE` property would
        // have done. Without it, a deadline is indistinguishable from a work slot.
        summary: `${taskLabel(task)} (due)`,
      });
    }
  }

  // Chronological, so the file reads in the order the days happened. `getTime`
  // rather than subtracting Dates: the arithmetic is identical and the intent is
  // legible.
  events.sort((a, b) => a.start.getTime() - b.start.getTime());

  return since == null
    ? events
    : events.filter((e) => e.end.getTime() >= since);
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
