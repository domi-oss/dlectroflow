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
 * The note text: the user's own notes (#44) when there are any, then a blank
 * line, then a voice-aware prompt line followed by the absolute focus URL.
 * The newline renders in both calendar clients (ICS escapes it) and Google Task
 * notes (real newline).
 *
 * **The user's notes go FIRST**, and that is a product decision rather than a
 * formatting one: a calendar slot and a Google Tasks row both show only the
 * first line or two, and the note is the part carrying the context ("bring the
 * Figma link"). The deep-link is what you tap once you have read it.
 *
 * ## Both notes, not the more specific one — the #44 decision
 *
 * When a step carries its own note AND its task carries one, the artifact gets
 * **both**, task first. The alternative was considered and declined: letting
 * the step's note WIN would mean that annotating a step silently strips the
 * task's context from that step's calendar entry, so the more carefully you use
 * the feature, the less each entry tells you. That is a rule that punishes use.
 *
 * The objection to carrying both is that the task note is then repeated across
 * every one of a task's entries. That repetition is real but it is not
 * experienced as repetition: **each entry is opened alone**, days later, away
 * from the app and from its siblings. The focus prompt and the parent-task
 * context line are already repeated on every event for exactly this reason.
 * Identical notes collapse to one, which covers the case where somebody has
 * pasted the same text at both grains.
 *
 * The length budget was chosen for this: 2000 characters at each grain, against
 * Google's 8192-character cap on a Task's `notes`, leaves the two notes plus the
 * envelope roughly a 2x margin even when both are full.
 *
 * ## Nothing is escaped here
 *
 * Deliberately. The same string is serialised two incompatible ways — into an
 * ICS `DESCRIPTION` under RFC 5545 §3.3.11 (`esc()` in src/lib/ics.ts) and into
 * a Google Task `notes` field as JSON — so escaping at this layer would be
 * wrong for one caller and double-applied for the other. The rule this module
 * keeps is that it stays a plain string and every caller hands it to a
 * serialiser that knows its own format.
 *
 * Both note inputs are optional, and absent/blank ones produce byte-identical
 * output to the pre-#44 shape — which is what lets every caller pass them
 * through unconditionally.
 */
export function buildScheduleNote(input: {
  origin: string;
  voice: Voice;
  stepId?: string | null;
  /** `Task.notes`. Already normalised on write (`normalizeTaskNote`), trimmed
   *  again here because a caller may pass a hand-built value and a stray blank
   *  line is visible in a calendar entry. */
  taskNote?: string | null;
  /** `Step.notes` for the step this artifact is for. Ignored by the stepless
   *  fallback event, which has no step to have a note. */
  stepNote?: string | null;
}): string {
  const link = `${t("schedule.focusNote", input.voice)}\n${focusUrl(input.origin, input.stepId)}`;

  const parts: string[] = [];
  for (const raw of [input.taskNote, input.stepNote]) {
    const note = raw?.trim();
    // Whole-value equality (`includes` is SameValueZero over the array, i.e.
    // `===` for strings), never a substring test. The dedupe exists for the
    // paste case — the same sentence typed at both grains — and both values
    // have been trimmed independently by then, so an exact match is what
    // "the same note twice" means. A substring rule would be a bug: "call Sam"
    // is a narrower instruction than "call Sam first, then the bank", and
    // suppressing it would lose the more specific of the two (!270).
    if (note && !parts.includes(note)) parts.push(note);
  }

  return parts.length > 0 ? `${parts.join("\n\n")}\n\n${link}` : link;
}
