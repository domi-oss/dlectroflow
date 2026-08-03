import { buildIcsCalendar, scheduledStepEvents } from "@/lib/ics";
import type { ExportSnapshot } from "./types";

/**
 * #129 — `scheduled.ics`, the calendar tier. It answers *"can my calendar see
 * it?"*.
 *
 * ## The mapping moved, the rules did not (#154)
 *
 * Which rows become events — and the three-part rule about `Task.scheduledAt`
 * that a reader will question — now live with the shared serialiser, in
 * `scheduledStepEvents` (`src/lib/ics.ts`). #154's per-user subscription feed is
 * a second consumer of exactly those rules, and two copies of them is how the
 * archive and the feed would come to disagree about what somebody's calendar
 * contains. `README.md` still states the rules to the person reading the
 * archive, and the end-to-end assertions still live in `calendar.test.ts`.
 *
 * What stays here is what is specific to an ARCHIVE:
 *
 *  - **No `since` window.** The feed passes one, because a subscription answers
 *    "what is coming up". An export that quietly dropped old rows would be the
 *    failure this whole feature exists to fix.
 *  - **UTC instants, not floating.** These are records of when something really
 *    was scheduled, so they must not drift with the reader's timezone.
 *  - **`stamp: snapshot.exportedAt`,** so two exports of unchanged data are
 *    byte-identical and the archive is diffable.
 */
export function scheduledIcs(snapshot: ExportSnapshot): string {
  return buildIcsCalendar({
    events: scheduledStepEvents(snapshot.tasks),
    timeMode: "utc",
    calendarName: "dlectroflow — scheduled work",
    stamp: snapshot.exportedAt,
  });
}
