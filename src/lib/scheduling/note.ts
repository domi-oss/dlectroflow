/**
 * Focus deep-link note for scheduled artifacts (S6, #39).
 *
 * When a task is scheduled (as an .ics download or a Reclaim-synced Google Task),
 * we embed a short voice-aware prompt + an ABSOLUTE deep-link back into the focus
 * timer, so tapping the calendar event / Google Task drops the user straight into
 * `/focus` for that work — closing the loop from "scheduled" → "actually doing it".
 *
 * Pure module (like `strings.ts`): callers resolve the origin (`publicOrigin()`),
 * the voice (from settings), and the target step, then pass them in.
 */
import { t, type Voice } from "@/lib/strings";

/**
 * Absolute URL into the focus timer: the exact step when one exists, else the
 * `/focus` launcher (which lands on the resume hero / lanes).
 */
export function focusUrl(origin: string, stepId?: string | null): string {
  const base = origin.replace(/\/+$/, "");
  return stepId ? `${base}/focus/${stepId}` : `${base}/focus`;
}

/**
 * The note text: the user's own note (#44) when there is one, then a blank
 * line, then a voice-aware prompt line followed by the absolute focus URL.
 * The newline renders in both calendar clients (ICS escapes it) and Google Task
 * notes (real newline).
 *
 * **The user note goes FIRST**, and that is a product decision rather than a
 * formatting one: a calendar slot and a Google Tasks row both show only the
 * first line or two, and the note is the part carrying the context ("bring the
 * Figma link"). The deep-link is what you tap once you have read it.
 *
 * **Nothing is escaped here**, deliberately. The same string is serialised two
 * incompatible ways — into an ICS `DESCRIPTION` under RFC 5545 §3.3.11 (`esc()`
 * in src/lib/ics.ts) and into a Google Task `notes` field as JSON — so escaping
 * at this layer would be wrong for one caller and double-applied for the other.
 * The rule this module keeps is that it stays a plain string and every caller
 * hands it to a serialiser that knows its own format.
 *
 * `userNote` is optional and an absent/blank one produces byte-identical output
 * to the pre-#44 shape, which is what lets both existing callers pass it
 * through unconditionally.
 */
export function buildScheduleNote(input: {
  origin: string;
  voice: Voice;
  stepId?: string | null;
  /** The task's `notes` column. Already normalised on write
   *  (`normalizeTaskNote`), trimmed again here because a caller may pass a
   *  hand-built value and a stray blank line is visible in a calendar entry. */
  userNote?: string | null;
}): string {
  const link = `${t("schedule.focusNote", input.voice)}\n${focusUrl(input.origin, input.stepId)}`;
  const note = input.userNote?.trim();
  return note ? `${note}\n\n${link}` : link;
}
