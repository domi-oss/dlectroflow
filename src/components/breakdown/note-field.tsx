"use client";

import { useEffect, useId, useRef, useState } from "react";
import {
  useSaveStatus,
  SaveIndicator,
} from "@/components/settings/use-save-status";
import { TASK_NOTE_MAX_LENGTH } from "@/lib/task-notes";
import { t, type Voice } from "@/lib/strings";
import { cn } from "@/lib/utils";

/** What the caller's save did. Structurally satisfied by both
 *  `UpdateTaskNotesResult` and `UpdateStepNotesResult`, so neither server action
 *  needs an adapter and this component imports neither. */
export type NoteSaveResult =
  { ok: true; notes: string | null } | { ok: false; reason: string };

/**
 * Show the remaining character budget only once it is nearly spent.
 *
 * A counter that is always on is noise on a field almost nobody fills, and for
 * a screen-reader user it is a live region announcing a number that has not
 * become relevant yet. 200 is roughly a long sentence's worth of warning —
 * enough to finish a thought and stop, rather than discovering the bound by
 * having a keystroke silently dropped.
 */
const COUNTER_VISIBLE_BELOW = 200;

/**
 * A saved note, rendered as read-only text.
 *
 * Shared rather than inlined because there are two places a note is READ without
 * being editable: inside the disclosure below while it is collapsed, and on a
 * DONE step row, which offers no note control at all (annotating finished work
 * has no purpose — but hiding text the user wrote would).
 *
 * `whitespace-pre-wrap` and nothing else: the note is plain text by decision
 * (#44 puts rich text out of scope), so line breaks survive and no markup is
 * interpreted.
 */
export function NoteText({ children }: { children: string }) {
  return (
    <p
      data-testid="note-text"
      className="text-muted-foreground border-muted-foreground/30 border-l-2 pl-3 whitespace-pre-wrap"
    >
      {children}
    </p>
  );
}

/**
 * The task/step note (#44), as a DISCLOSURE.
 *
 * Collapsed until asked for, because the note is optional and the surfaces it
 * appears on are already dense — a step row most of all. A permanently open
 * empty box on every step would push the actual work off the screen.
 *
 * ## The disclosure dialect
 *
 * Lifted from `CollapsibleSection` rather than invented, so the app keeps ONE
 * dialect:
 *
 *  • `hidden` the ATTRIBUTE, not a `display:none` class, so the collapsed
 *    editor is out of the accessibility tree AND the tab order without
 *    depending on a stylesheet having loaded.
 *  • The body stays MOUNTED, so `aria-controls` always resolves and the
 *    in-flight save indicator survives a close and reopen.
 *  • Expansion is state on ONE trigger whose `aria-expanded` flips — never two
 *    buttons swapped for each other, which reads to assistive tech as the
 *    control disappearing rather than changing state.
 *
 * ## Two things this control has to get right that no automated gate can see
 *
 *  1. **The accessible name says WHICH task or step.** `a11y-class-hygiene`
 *     sees contrast and focus indicators; axe sees a missing label. Neither can
 *     see twelve buttons all called "Add note" down a list of steps, which is
 *     the difference between a usable list and an unusable one. The visible
 *     label stays short and the subject is appended to an explicit
 *     `aria-label` — read the comment on the trigger for why an `sr-only` span
 *     was tried and rejected. Either way the visible text stays a PREFIX of the
 *     accessible name, satisfying WCAG 2.5.3 Label in Name for voice control.
 *  2. **A saved note is readable without expanding anything.** The point of the
 *     note is that it is there when you come back to the task, so while
 *     collapsed the note itself is rendered as text and only EDITING costs a
 *     tap.
 */
export function NoteField({
  subject,
  initialNote,
  onSave,
  voice,
  autoSaveDelayMs = 600,
  dense = false,
}: {
  /** What this note belongs to, in words: a task title, or `step 2: Plan`.
   *  Goes into the trigger's and the field's accessible names. */
  subject: string;
  initialNote: string | null;
  /** Resolves with what was STORED — normalisation may have trimmed or clamped
   *  it, and the field adopts the stored value rather than the typed one. */
  onSave: (next: string | null) => Promise<NoteSaveResult>;
  voice: Voice;
  /** Debounce for the auto-save. Overridable so tests stay fast + deterministic
   *  (the settings sections take the same prop, for the same reason). */
  autoSaveDelayMs?: number;
  /** Step rows are tighter than the task header card. Type scale only — the hit
   *  target stays 44px either way (WCAG 2.5.8). */
  dense?: boolean;
}) {
  const bodyId = useId();
  const fieldId = useId();
  const hintId = useId();
  const counterId = useId();

  const [expanded, setExpanded] = useState(false);
  const [note, setNote] = useState(initialNote ?? "");
  const { status, markSaving, markSaved, markError } = useSaveStatus();

  const triggerRef = useRef<HTMLButtonElement>(null);
  const fieldRef = useRef<HTMLTextAreaElement>(null);
  // Read by the debounced flush when it eventually fires, so it sends the
  // latest value rather than the one captured when the timer was set. Written
  // in an effect rather than during render — the same shape aging-section uses.
  const latest = useRef(note);
  useEffect(() => {
    latest.current = note;
  });
  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (debounce.current) clearTimeout(debounce.current);
    },
    [],
  );

  const flush = async () => {
    markSaving();
    // "" is not a note. Sending null is what puts the column back to NULL, which
    // is the state that keeps a blank line out of somebody's calendar entry.
    const next = latest.current.trim() === "" ? null : latest.current;
    try {
      const res = await onSave(next);
      if (!res.ok) {
        markError();
        return;
      }
      markSaved();
      // Adopt what was actually stored. The action trims, strips control
      // characters and clamps; a field still showing the pre-normalisation text
      // is telling the user something untrue about what is saved. Skipped while
      // they are still typing, so an in-flight response cannot yank the cursor.
      if (res.notes !== latest.current && debounce.current == null) {
        setNote(res.notes ?? "");
      }
    } catch {
      // A rejected action (a network drop, not a handled failure) must land on
      // the same visible affordance rather than an unhandled rejection.
      markError();
    }
  };

  const scheduleSave = () => {
    if (debounce.current) clearTimeout(debounce.current);
    debounce.current = setTimeout(() => {
      debounce.current = null;
      void flush();
    }, autoSaveDelayMs);
  };

  const open = () => {
    setExpanded(true);
    // Focus MANAGEMENT, not merely reveal: a keyboard user who just asked for
    // the field would otherwise have to tab forward blindly to reach it. The
    // body is already mounted, so the node exists — this runs after the state
    // flush so `hidden` is off by the time focus lands.
    queueMicrotask(() => fieldRef.current?.focus());
  };

  const close = () => {
    setExpanded(false);
    // Back to where they came from. Leaving focus on a node that has just gone
    // `hidden` drops it to `document.body`, which is where a keyboard user's
    // position disappears and they have to tab from the top of the page.
    triggerRef.current?.focus();
  };

  const hasNote = note.trim() !== "";
  const remaining = TASK_NOTE_MAX_LENGTH - [...note].length;
  const showCounter = remaining <= COUNTER_VISIBLE_BELOW;

  const triggerLabel = t(hasNote ? "note.edit" : "note.add", voice);
  const fieldLabel = t("note.label", voice);

  return (
    <div className={cn("space-y-1", dense ? "text-xs" : "text-sm")}>
      <div className="flex flex-wrap items-center gap-2">
        <button
          ref={triggerRef}
          type="button"
          aria-expanded={expanded}
          aria-controls={bodyId}
          // ── Why `aria-label` and not a visually-hidden span ────────────────
          // The obvious markup is `Add note<span class="sr-only"> for X</span>`,
          // deriving the name from content. It was tried and it is WRONG here:
          // the accname algorithm trims each child's contribution before
          // concatenating, and the separator between a text node and an inline
          // element is not specified. Measured with `dom-accessibility-api`, the
          // same engine testing-library and several audit tools use, the name
          // came out as **"Add notefor Ship the thing"** — one word, read aloud
          // as one word. An explicit label is deterministic across every
          // consumer instead of depending on an implementation's whitespace
          // handling.
          //
          // WCAG 2.5.3 Label in Name still holds, and is asserted rather than
          // assumed: the visible text is a PREFIX of this name, so a voice
          // control user saying "add note" activates it.
          aria-label={`${triggerLabel} for ${subject}`}
          onClick={() => (expanded ? close() : open())}
          // min-h-11 is 44px — WCAG 2.5.8 Target Size, and the reason the dense
          // variant changes only the type scale. `focus-visible:ring-2` rather
          // than a colour swap, because WCAG 2.4.11 Focus Appearance is not
          // satisfied by a change of hue alone.
          className="focus-visible:ring-ring focus-visible:ring-offset-background hover:bg-accent inline-flex min-h-11 items-center rounded-md px-2 text-left outline-none focus-visible:ring-2 focus-visible:ring-offset-2"
        >
          {triggerLabel}
        </button>
        <SaveIndicator status={status} voice={voice} />
      </div>

      {/* Readable without expanding — the note exists so that it is THERE when
          you come back. Hidden while the editor is open, where the textarea is
          showing the same text. */}
      {hasNote && !expanded && <NoteText>{note}</NoteText>}

      {/* `hidden` the ATTRIBUTE, and still mounted, so `aria-controls` resolves
          while collapsed (the CollapsibleSection dialect). */}
      <div id={bodyId} hidden={!expanded} className="space-y-1">
        {/* A REAL label element, not a placeholder standing in for one: it is
            visible, it survives typing, and clicking it focuses the field. The
            `aria-label` below it overrides the NAME (same disambiguation as the
            trigger — one field per step row, all otherwise called "Note"),
            while this stays the visible label WCAG 2.5.3 measures against. */}
        <label htmlFor={fieldId} className="block">
          {fieldLabel}
        </label>
        <textarea
          ref={fieldRef}
          id={fieldId}
          value={note}
          rows={dense ? 2 : 3}
          maxLength={TASK_NOTE_MAX_LENGTH}
          aria-label={`${fieldLabel} for ${subject}`}
          aria-describedby={showCounter ? `${hintId} ${counterId}` : hintId}
          onChange={(e) => {
            setNote(e.target.value);
            scheduleSave();
          }}
          onKeyDown={(e) => {
            // Escape closes the disclosure and returns focus. Enter must NOT —
            // this is a multi-line field and a newline is a legitimate thing to
            // type in a note.
            if (e.key === "Escape") {
              e.stopPropagation();
              close();
            }
          }}
          className="border-input focus-visible:ring-ring focus-visible:ring-offset-background w-full rounded-md border px-2 py-1 outline-none focus-visible:ring-2 focus-visible:ring-offset-2"
        />
        <p id={hintId} className="text-muted-foreground text-xs">
          {t("note.hint", voice)}
        </p>
        {showCounter && (
          <p
            id={counterId}
            role="status"
            aria-live="polite"
            aria-label="characters remaining"
            className="text-muted-foreground text-xs"
          >
            {remaining} characters left
          </p>
        )}
      </div>
    </div>
  );
}
