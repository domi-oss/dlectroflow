type IcsStep = { text: string; estMinutes: number; subtaskEmoji?: string | null };

function pad(n: number): string {
  return String(n).padStart(2, "0");
}
/** Floating local time stamp: YYYYMMDDTHHMMSS (no trailing Z).
 *  Uses UTC accessors so the value is timezone-independent — callers pass a
 *  "wall-clock" Date (e.g. new Date("2026-07-08T09:00:00Z")) and the stamp
 *  reflects that wall time regardless of the server's local timezone.
 */
function floating(d: Date): string {
  return (
    `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}` +
    `T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}`
  );
}
function esc(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\n/g, "\\n");
}
function nextTopOfHour(from = new Date()): Date {
  const d = new Date(from);
  d.setUTCMinutes(0, 0, 0);
  d.setUTCHours(d.getUTCHours() + 1);
  return d;
}

/** Build a downloadable .ics: one back-to-back VEVENT per step (floating local time). */
export function buildTaskIcs(input: {
  title: string;
  parentEmoji?: string | null;
  steps: IcsStep[];
  start?: Date;
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
      `DTSTAMP:${floating(new Date())}`,
      `DTSTART:${floating(cursor)}`,
      `DTEND:${floating(end)}`,
      `SUMMARY:${esc(summary)}`,
      "END:VEVENT",
    );
    cursor = end;
  });
  lines.push("END:VCALENDAR");
  return lines.join("\r\n");
}
