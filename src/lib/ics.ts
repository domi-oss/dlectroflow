type IcsStep = {
  text: string;
  estMinutes: number;
  subtaskEmoji?: string | null;
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

/** Build a downloadable .ics: one back-to-back VEVENT per step (floating local time). */
export function buildTaskIcs(input: {
  title: string;
  parentEmoji?: string | null;
  steps: IcsStep[];
  start?: Date;
  fallbackDurationMin?: number;
}): string {
  const start = input.start ?? nextTopOfHour();
  let cursor = new Date(start);
  const lines: string[] = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//dlectroflow//phase2//EN",
    "CALSCALE:GREGORIAN",
  ];
  input.steps.forEach((s, i) => {
    const dur = Math.max(1, Math.round(s.estMinutes || 25));
    const end = new Date(cursor.getTime() + dur * 60_000);
    const emoji = s.subtaskEmoji ? `${s.subtaskEmoji} ` : "";
    const summary = `${input.parentEmoji ? input.parentEmoji + " " : ""}${input.title}: ${emoji}${s.text}`;
    lines.push(
      "BEGIN:VEVENT",
      `UID:${floating(cursor)}-${i}@dlectroflow`,
      `DTSTAMP:${new Date().toISOString().replace(/[-:]/g, "").slice(0, 15)}Z`,
      `DTSTART:${floating(cursor)}`,
      `DTEND:${floating(end)}`,
      `SUMMARY:${esc(summary)}`,
      "END:VEVENT",
    );
    cursor = end;
  });
  if (input.steps.length === 0 && input.fallbackDurationMin != null) {
    const dur = Math.max(1, Math.round(input.fallbackDurationMin));
    const end = new Date(start.getTime() + dur * 60_000);
    const summary = `${input.parentEmoji ? input.parentEmoji + " " : ""}${input.title}`;
    lines.push(
      "BEGIN:VEVENT",
      `UID:${floating(start)}-0@dlectroflow`,
      `DTSTAMP:${new Date().toISOString().replace(/[-:]/g, "").slice(0, 15)}Z`,
      `DTSTART:${floating(start)}`,
      `DTEND:${floating(end)}`,
      `SUMMARY:${esc(summary)}`,
      "END:VEVENT",
    );
  }
  lines.push("END:VCALENDAR");
  return lines.join("\r\n");
}

/** Download filename for a task's .ics — shared by the ICS route and the
 *  scheduleViaIcs action so the name is defined in exactly one place. */
export function icsFilename(title: string): string {
  const safe = title.replace(/[^a-z0-9]+/gi, "-").slice(0, 40) || "task";
  return `dlectroflow-${safe}.ics`;
}
