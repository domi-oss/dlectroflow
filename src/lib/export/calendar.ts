import { buildIcsCalendar, type IcsEvent } from "@/lib/ics";
import type { ExportSnapshot, ExportTask } from "./types";

/**
 * #129 — `scheduled.ics`, the calendar tier. It answers *"can my calendar see
 * it?"*.
 *
 * ## VEVENT, not VTODO
 *
 * `VTODO` is the semantically correct iCalendar component for a task: it has
 * `DUE`, `PERCENT-COMPLETE` and `STATUS:COMPLETED`, which is exactly this data.
 * **Google Calendar ignores `VTODO` entirely** — an import succeeds and shows
 * nothing. So the correct choice is the useless one, and this file uses `VEVENT`
 * for anything carrying a time. `README.md` states the trade-off rather than
 * leaving the next reader to rediscover it.
 *
 * ## Which rows become events, and which deliberately do not
 *
 * This is the decision that needed making, and it turns on what
 * `Task.scheduledAt` actually means:
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
 *     like data. It is exported in `export.json` and `tasks.csv`, where it is
 *     labelled for what it is.
 *
 * Rule 3 is the one a reader will question, which is why `README.md` says out
 * loud which rows became events. An export that quietly drops something is the
 * failure this whole feature exists to fix, so the omission is stated rather than
 * merely made.
 *
 * ## No `TRANSP:OPAQUE`
 *
 * The per-task download marks its events busy, because that is a live request to
 * defend a slot (#104). This is an archive of past and future work: importing it
 * must not silently block out somebody's calendar.
 */

/** How long a due-date marker lasts. Matches the ICS download's default slot
 *  (`DEFAULT_ICS_DURATION_MIN`), so the two surfaces do not disagree about what
 *  "a task-shaped amount of time" is. */
const DUE_EVENT_MINUTES = 25;

/** Collapse whitespace: a calendar entry's title is a one-line thing, and an
 *  escaped `\n` in a SUMMARY renders as a literal backslash-n in some clients.
 *  The untouched text is in `export.json`. */
function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function taskLabel(task: ExportTask): string {
  return `${task.parentEmoji ? `${task.parentEmoji} ` : ""}${oneLine(task.title)}`;
}

export function scheduledIcs(snapshot: ExportSnapshot): string {
  const events: IcsEvent[] = [];

  for (const task of snapshot.tasks) {
    for (const step of task.steps) {
      if (!step.scheduledAt) continue;
      // Clamped to at least a minute. The database CHECK already enforces >= 1
      // (#78), so this defends against a future writer rather than today's data —
      // and an event whose DTEND precedes its DTSTART is rejected by some clients
      // and silently dropped by others.
      const minutes = Math.max(1, Math.round(step.estMinutes || 1));
      const emoji = step.subtaskEmoji ? `${step.subtaskEmoji} ` : "";
      events.push({
        // Derived from the row's own id (already a cuid), so importing the same
        // file twice updates the same events instead of duplicating them.
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

  return buildIcsCalendar({
    events,
    // UTC instants, not floating: these are records of when something really was
    // scheduled, so they must not drift with the reader's timezone.
    timeMode: "utc",
    calendarName: "dlectroflow — scheduled work",
    stamp: snapshot.exportedAt,
  });
}
