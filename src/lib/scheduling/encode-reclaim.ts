/**
 * Reclaim's Google Tasks title syntax (#104).
 *
 * Reclaim parses parenthetical parameters out of a synced task's title, acts on
 * them, then STRIPS them — so whatever is left outside the parentheses is what
 * the owner reads in their calendar slot. That makes the title two things at
 * once, and the layout is chosen for the ~30 characters a slot actually shows:
 * counter badge first (position at a glance), then the step text (the part that
 * tells you what to do), then the honest estimate when the 30-minute floor
 * changed it. The parent task title lives in the description, because it is
 * identical across every event of a task and was eating the visible width.
 *
 * This is the ONLY module that knows Reclaim's vocabulary.
 */
import { buildScheduleNote } from "./note";
import { schedulingTimeZone } from "./hours";
import { SchedulePriority, ScheduleHours } from "./types";
import type { ScheduleIntent, ScheduleUnit } from "./types";
import type { ScheduleWindow } from "./windows";
import type { Voice } from "@/lib/strings";

const PRIORITY_PARAM: Record<SchedulePriority, string> = {
  [SchedulePriority.Critical]: "P1",
  [SchedulePriority.High]: "P2",
  [SchedulePriority.Normal]: "P3",
  [SchedulePriority.Low]: "P4",
};

const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

/**
 * `Jul 31 2026 5:00pm` — a month NAME, deliberately. Reclaim accepts numeric
 * dates, but `31/07/2026` is ambiguous between the owner's en-GB locale and a
 * US-format parser, and a silently misread deadline is the worst failure this
 * feature can have.
 */
export function formatReclaimDate(
  d: Date,
  timeZone = schedulingTimeZone(),
): string {
  const parts: Record<string, string> = {};
  for (const p of new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(d)) {
    if (p.type !== "literal") parts[p.type] = p.value;
  }
  const h24 = Number(parts.hour);
  const suffix = h24 < 12 ? "am" : "pm";
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
  const month = MONTHS[Number(parts.month) - 1];
  return `${month} ${parts.day} ${parts.year} ${h12}:${parts.minute}${suffix}`;
}

/** Every `(…)` group Reclaim would consume. Used only to prove the contract in tests. */
export function stripReclaimParams(title: string): string {
  const known =
    /\s*\((?:duration:[^)]*|nosplit|upnext|priority:[^)]*|type\s+[^)]*|due\s+[^)]*|not before\s+[^)]*)\)/gi;
  return title.replace(known, "").trim();
}

export type EncodeArgs = {
  unit: ScheduleUnit;
  window: ScheduleWindow;
  intent: ScheduleIntent;
  taskTitle: string;
  parentEmoji?: string | null;
  origin: string;
  voice: Voice;
  /**
   * The freeform notes (#44), threaded into the Google Task `notes` so the
   * scheduled item carries its own context: the TASK's, and this unit's own if
   * the unit is a step that has one. `buildScheduleNote` composes both and
   * explains why it is both rather than the more specific one.
   *
   * NOTES, never the title. Reclaim parses `(...)` groups out of a title and
   * acts on them, so a note containing parentheses reaching the title would be
   * read as scheduling parameters — a note that silently changes when the work
   * gets scheduled for. The notes field is not parsed.
   */
  taskNote?: string | null;
  stepNote?: string | null;
};

export function encodeReclaim(a: EncodeArgs): { title: string; notes: string } {
  const { unit, window: w, intent } = a;
  const multi = unit.total > 1;

  const visible = [
    multi ? `[${unit.order}/${unit.total}]` : null,
    unit.emoji || null,
    unit.text.trim(),
    // The floor changed the number, so keep the honest estimate readable.
    w.floored ? `~${Math.round(unit.estMinutes)}m` : null,
  ]
    .filter(Boolean)
    .join(" ");

  const params = [
    `(duration:${w.durationMin}m)`,
    // A step is one sitting; without this a floored 30-minute block can split
    // into two 15s, which is exactly the sliver the floor exists to avoid.
    multi ? "(nosplit)" : null,
    w.notBefore ? `(not before ${formatReclaimDate(w.notBefore)})` : null,
    `(due ${formatReclaimDate(w.due)})`,
    `(priority:${PRIORITY_PARAM[intent.priority]})`,
    `(type ${intent.hours === ScheduleHours.Personal ? "personal" : "work"})`,
  ].filter(Boolean);

  const parentEmoji = a.parentEmoji ? `${a.parentEmoji} ` : "";
  const context = multi
    ? `${parentEmoji}${a.taskTitle} — step ${unit.order} of ${unit.total} · est. ${Math.round(unit.estMinutes)}m`
    : `${parentEmoji}${a.taskTitle} · est. ${Math.round(unit.estMinutes)}m`;

  return {
    title: `${visible} ${params.join(" ")}`,
    // Per-unit deep link: the defect this replaces reused the FIRST step's id
    // for every event, so step 6's calendar entry opened the timer on step 1.
    // The context line stays FIRST (#44) — it says which step this is, and
    // orientation has to precede anything freeform; `buildScheduleNote` then
    // puts the user's note above the prompt and the link.
    notes: `${context}\n${buildScheduleNote({ origin: a.origin, voice: a.voice, stepId: unit.id, taskNote: a.taskNote, stepNote: a.stepNote })}`,
  };
}

export { PRIORITY_PARAM };
