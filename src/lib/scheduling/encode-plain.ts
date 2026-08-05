/**
 * Plain Google Tasks encoder (#104, epic #29 generalisation).
 *
 * A self-hoster with a Google account and no Reclaim gains nothing from
 * parenthetical parameters — they are noise nobody strips. So this encoder
 * writes a clean title, uses Google Tasks' OWN due-date field (which
 * `createGoogleTask` has always accepted and never been given), and puts the
 * duration and earliest-start in the notes where a human reads them.
 */
import { buildScheduleNote } from "./note";
import { formatReclaimDate } from "./encode-reclaim";
import type { EncodeArgs } from "./encode-reclaim";

export type EncodedTask = { title: string; notes: string; due?: string };

export function encodePlain(a: EncodeArgs): EncodedTask {
  const { unit, window: w } = a;
  const multi = unit.total > 1;

  const title = [
    multi ? `[${unit.order}/${unit.total}]` : null,
    unit.emoji || null,
    unit.text.trim(),
  ]
    .filter(Boolean)
    .join(" ");

  const parentEmoji = a.parentEmoji ? `${a.parentEmoji} ` : "";
  const lines = [
    multi
      ? `${parentEmoji}${a.taskTitle} — step ${unit.order} of ${unit.total}`
      : `${parentEmoji}${a.taskTitle}`,
    `Block ${w.durationMin}m · est. ${Math.round(unit.estMinutes)}m`,
    w.notBefore ? `Not before ${formatReclaimDate(w.notBefore)}` : null,
    // #44 — the task's note and this step's own are composed in by
    // `buildScheduleNote`, above the prompt and the link, so the plain path a
    // self-hoster gets carries the same context the Reclaim path does.
    buildScheduleNote({
      origin: a.origin,
      voice: a.voice,
      stepId: unit.id,
      taskNote: a.taskNote,
      stepNote: a.stepNote,
    }),
  ].filter(Boolean);

  return { title, notes: lines.join("\n"), due: w.due.toISOString() };
}
