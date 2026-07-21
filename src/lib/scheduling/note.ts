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
 * The note text: a voice-aware prompt line followed by the absolute focus URL.
 * The newline renders in both calendar clients (ICS escapes it) and Google Task
 * notes (real newline).
 */
export function buildScheduleNote(input: {
  origin: string;
  voice: Voice;
  stepId?: string | null;
}): string {
  return `${t("schedule.focusNote", input.voice)}\n${focusUrl(input.origin, input.stepId)}`;
}
