/**
 * The user's freeform note on a task (#44).
 *
 * Pure module (no `fs`, no Prisma, no React), because three places need the
 * same answer and must not drift: the server action that writes the column, the
 * client field that bounds what can be typed, and the DB CHECK constraint whose
 * bound this file has to agree with.
 *
 * #44 ships TASK-level notes only. Step-level notes are a real ask in the same
 * issue and were deliberately deferred, so nothing here is named for `Task` —
 * a later `Step.notes` reuses the constant and the normaliser unchanged.
 */

/**
 * Maximum note length, in CHARACTERS (Postgres `char_length`, i.e. code
 * points — see `normalizeTaskNote`).
 *
 * 2000, and the binding constraint is Google, not us. A scheduled task's note
 * is threaded into the Google Task `notes` field, which the Tasks API caps at
 * **8192 characters** and rejects above; the value written there is the context
 * line + this note + the focus prompt + an absolute deep-link URL, so the note
 * cannot be allowed to fill the cap on its own or a long note turns into a
 * failed schedule rather than a truncated one. 2000 leaves the envelope roughly
 * a 4x margin.
 *
 * The ICS path has no equivalent cap — RFC 5545 bounds a *content line* at 75
 * octets and folds beyond that (`foldLine` in src/lib/ics.ts), not the value —
 * so it is not what sets this number.
 *
 * The other half of the reasoning is product: the issue's own examples are
 * "bring the Figma link" and "call before 5". This is a jotting field, and rich
 * text is explicitly out of scope, so a bound generous enough for a few
 * paragraphs is generous enough.
 */
export const TASK_NOTE_MAX_LENGTH = 2000;

/**
 * Every C0 control except HTAB and LF, plus DEL.
 *
 * CR is absent on purpose — it is folded into LF by the line-ending pass below
 * before this runs, so listing it here would be dead. The set mirrors the one
 * `esc()` in src/lib/ics.ts drops for RFC 5545 §3.3.11; this is the same gate
 * applied one layer earlier, because the Google Tasks path never reaches `esc`.
 */
const CONTROL_CHARS = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g;

/**
 * Canonicalise a note on its way into the database.
 *
 * Returns `null` for "there is no note", which is the column's own vocabulary:
 * the note is threaded into a scheduled artifact only when present, so an empty
 * string masquerading as a note would put a blank line in somebody's calendar
 * entry.
 *
 * Order is load-bearing:
 *  1. line endings first, so the control-character sweep never sees a CR;
 *  2. strip controls, so they cannot consume budget that real text needs;
 *  3. trim, then clamp, then trim again — clamping can expose trailing
 *     whitespace that was interior a moment ago.
 *
 * The clamp is over `[...s]` rather than `s.slice()` because `String.length`
 * counts UTF-16 code units and `char_length()` counts characters. Slicing at
 * 2000 units can both overshoot the constraint and cut an astral character in
 * half, storing a lone surrogate.
 */
export function normalizeTaskNote(
  raw: string | null | undefined,
): string | null {
  if (raw == null) return null;

  const cleaned = raw
    .replace(/\r\n|\r/g, "\n")
    .replace(CONTROL_CHARS, "")
    .trim();
  if (cleaned === "") return null;

  const points = [...cleaned];
  const clamped =
    points.length > TASK_NOTE_MAX_LENGTH
      ? points.slice(0, TASK_NOTE_MAX_LENGTH).join("").trim()
      : cleaned;

  return clamped === "" ? null : clamped;
}
