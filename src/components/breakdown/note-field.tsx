"use client";

import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import {
  useSaveStatus,
  SaveIndicator,
} from "@/components/settings/use-save-status";
import { TASK_NOTE_MAX_LENGTH } from "@/lib/task-notes";
import { t, type Voice } from "@/lib/strings";
import { cn, touchTarget } from "@/lib/utils";

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
 * Clamp typed input to the budget, IN CODE POINTS (!270).
 *
 * The unit is the whole point. `TASK_NOTE_MAX_LENGTH` is 2000 CODE POINTS —
 * that is what `char_length()` counts in `Task_notes_check` and what `[...s]`
 * counts in `normalizeTaskNote`. A `maxLength` attribute counts UTF-16 CODE
 * UNITS instead, so on a note of emoji (🧠 is one code point, two units) the
 * browser stopped accepting input at half the real budget while the counter,
 * correctly measuring code points, still reported a thousand left.
 *
 * Fixed by moving the binding guard here rather than by moving the counter to
 * code units: the counter was the half that already agreed with the column.
 *
 * No trimming — that belongs to `normalizeTaskNote` on the way to the
 * database. Trimming mid-keystroke would eat the space the user just typed.
 *
 * No line-ending fold either, and that is a measured decision rather than an
 * omission (!270). The worry is that a CRLF would cost two code points here
 * and one in the column, so the counter would under-report near the bound. It
 * cannot arise: the HTML Standard defines a textarea's API VALUE — what the
 * `value` IDL attribute, and therefore `e.target.value`, returns — as
 * newline-normalised to LF, and reserves CRLF for the FORM SUBMISSION value.
 * This field submits no form; it hands a JS string to a server action.
 * Measured, not assumed: typing Enter and assigning `"a\r\nb\rc"` both read
 * back CR-free in Chromium, WebKit and jsdom. The only deviation found was
 * WebKit's `execCommand("insertText")`, which this repo never calls. `note`
 * has exactly three sources — this function, `initialNote` and `res.notes` —
 * and the latter two come from the column, which `normalizeTaskNote` folds.
 */
function clampToBudget(value: string): string {
  const points = [...value];
  if (points.length <= TASK_NOTE_MAX_LENGTH) return value;
  return points.slice(0, TASK_NOTE_MAX_LENGTH).join("");
}

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
 *     see twelve buttons all called "Note" down a list of steps, which is
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
  children,
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
   *  target stays 44px either way — 2.5.5 AAA, a house convention rather than
   *  the AA 2.5.8 minimum of 24x24, which is met regardless. */
  dense?: boolean;
  /**
   * PLACEMENT (owner request, #44). Omit and the two halves render stacked,
   * which is what the task detail page wants. Supply it and you place them
   * yourself — list rows put the `trigger` inside the row's action group,
   * beside Complete, and the `body` below the action line.
   *
   * A render prop rather than a hook because the list surfaces build their rows
   * inside `items.map(...)`, which is a callback and not a component: a
   * `useNoteField()` there would be a hook in a loop. A render prop is a
   * component, so the state lives exactly where it already did.
   */
  children?: (parts: { trigger: ReactNode; body: ReactNode }) => ReactNode;
}) {
  const bodyId = useId();
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
  // `onSave` gets the same treatment, and it is not defensive (!270).
  //
  // `scheduleSave` puts `flush` in a `setTimeout` closure. `flush` is rebuilt
  // every render, so a re-render between scheduling and firing leaves the
  // timer holding the PREVIOUS render's `flush` — and with it that render's
  // props. Every other value `flush` touches is already immune: `latest`,
  // `saveSeq` and `debounce` are refs, `setNote` is stable, and the three
  // `mark*` callbacks are `useCallback`s. `onSave` was the one live capture,
  // and it is the one prop every call site rebuilds on every render
  // (`onSave={(next) => updateTaskNotes(taskId, next)}` in `TaskNote`, and the
  // `updateStepNotes` twin in `StepNote`).
  //
  // A ref rather than `useCallback(flush, [onSave])`, which cannot work: a new
  // `onSave` identity every render means the dependency changes every render,
  // so the memo rebuilds every render and the timer still holds whichever
  // `flush` existed when it was set.
  const latestOnSave = useRef(onSave);
  useEffect(() => {
    latest.current = note;
    latestOnSave.current = onSave;
  });
  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (debounce.current) clearTimeout(debounce.current);
    },
    [],
  );

  // Which save is the current one.
  //
  // The debounce guarantees at most one save is ever SCHEDULED — it does NOT
  // guarantee one is in flight. Typing again while a save is awaiting starts a
  // second, and if the first then resolves LAST, adopting its `notes` would
  // overwrite the user's newer text with an older stored value. That is silent
  // loss of the only copy that exists, so the response is matched to its
  // request and a superseded one is dropped on the floor.
  const saveSeq = useRef(0);

  const flush = async () => {
    const seq = ++saveSeq.current;
    markSaving();
    // "" is not a note. Sending null is what puts the column back to NULL, which
    // is the state that keeps a blank line out of somebody's calendar entry.
    const next = latest.current.trim() === "" ? null : latest.current;
    try {
      const res = await latestOnSave.current(next);
      // A newer save started while this one was in flight: its result is the
      // truth, and this one's status has already been superseded too.
      if (seq !== saveSeq.current) return;
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
      if (seq !== saveSeq.current) return;
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

  /**
   * Write a pending edit NOW rather than waiting out the debounce.
   *
   * The debounce window is the one interval in which the only copy of what the
   * user typed lives in component state. Clicking away, tabbing on, or
   * navigating within it would lose the edit — the unmount cleanup CLEARS the
   * timer rather than firing it, because an async write cannot be awaited from
   * a cleanup. Blur is the moment that reliably precedes all three.
   *
   * Guarded on there BEING something pending, so merely opening the field and
   * tabbing past it does not write the column.
   */
  const flushPending = () => {
    if (!debounce.current) return;
    clearTimeout(debounce.current);
    debounce.current = null;
    void flush();
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

  const triggerLabel = t("note.trigger", voice);
  const fieldLabel = t("note.label", voice);

  const trigger = (
    // The button and its save indicator travel TOGETHER. The indicator reports
    // on the note, and left behind in the row it would read as the row's own
    // status — "Saved ✓" sitting next to Complete says something else entirely.
    //
    // `key` because every list-row caller drops this straight into `RowActions`'s
    // `inline` ARRAY, so React wants one and warned for it (#186). Set here rather
    // than at four call sites: the element is created here, and a key added by the
    // consumer is one every future consumer has to remember.
    <span key="note" className="inline-flex items-center gap-1">
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
        // The shared `touchTarget` — 44x44, BOTH axes. It previously carried a
        // bare `min-h-11` and no width floor, which is the #184 defect in
        // miniature: a control can pass a height check and still be a 30px-wide
        // sliver on a phone.
        //
        // The citation this comment used to carry was wrong and is corrected
        // here rather than repeated. 44x44 is **2.5.5 Target Size (Enhanced),
        // AAA**. **2.5.8 (Minimum) is the AA one and asks for 24x24** — which
        // this button already met. So the app is choosing to exceed its own AA
        // bar on row controls, deliberately, and that is a house convention
        // (see `touchTarget` in `@/lib/utils`) rather than a conformance
        // requirement. Saying "2.5.8" made a voluntary 44px look mandatory and
        // would have made a future reader think dropping it was a regression
        // against AA.
        //
        // `focus-visible:ring-2` rather than a colour swap, because WCAG 2.4.11
        // Focus Appearance is not satisfied by a change of hue alone.
        //
        // `justify-start text-left` AFTER `touchTarget`, not before: `cn` is
        // `twMerge`, so the later `justify-start` is what displaces the
        // `justify-center` that `touchTarget` carries. Raised by review on !278.
        // This button is the one place a label sits beside its 44px floor rather
        // than being an icon centred in it, so centring it would shift a short
        // label off the text edge every other row control aligns to.
        className={cn(
          touchTarget,
          "focus-visible:ring-ring focus-visible:ring-offset-background hover:bg-accent justify-start rounded-md px-2 text-left font-medium outline-none focus-visible:ring-2 focus-visible:ring-offset-2",
        )}
      >
        {triggerLabel}
      </button>
      <SaveIndicator status={status} voice={voice} />
    </span>
  );

  const body = (
    <div className={cn("space-y-1", dense ? "text-xs" : "text-sm")}>
      {/* Readable without expanding — the note exists so that it is THERE when
          you come back. Hidden while the editor is open, where the textarea is
          showing the same text. */}
      {hasNote && !expanded && <NoteText>{note}</NoteText>}

      {/* `hidden` the ATTRIBUTE, and still mounted, so `aria-controls` resolves
          while collapsed (the CollapsibleSection dialect). Unchanged by the
          move: the trigger can sit in a different container and still point at
          this, because `aria-controls` is an id reference and not a DOM
          relationship. */}
      <div id={bodyId} hidden={!expanded} className="space-y-1">
        {/* NO visible <label>. The trigger immediately above already reads
            "Note", and stacking a second identical word for one field is noise
            (owner). What that removal had to preserve, and does:
              • the accessible NAME — `aria-label` below is unchanged and still
                carries the subject, so a screen reader still hears which task
                or step this field belongs to. Verified with
                `dom-accessibility-api`, not by eye;
              • click-to-focus — given up knowingly, and only because the
                trigger ALREADY moves focus into this textarea on expand
                (`open()` below), so the affordance it provided is not lost;
              • the explanation — the hint line stays. It is information, not a
                label, and it is the only place the behaviour is described.
            Deliberately NOT `aria-labelledby` pointing at the trigger: a
            `button` as a field's label is not handled predictably by assistive
            tech, and it would drag the button's own name onto the field. */}
        <textarea
          ref={fieldRef}
          value={note}
          rows={dense ? 2 : 3}
          // DOUBLE the budget, and not the budget itself. The attribute counts
          // UTF-16 code units while the column counts code points, so set to
          // 2000 it truncated a note of emoji at half its allowance (!270).
          // A code point is at most two units, so 2x is the largest a
          // within-budget value can be — the ceiling is real (it still stops a
          // runaway paste if the clamp below never runs) but it can no longer
          // bind before `clampToBudget` does.
          maxLength={TASK_NOTE_MAX_LENGTH * 2}
          placeholder={t("note.placeholder", voice)}
          // The accessible NAME, and load-bearing now that the visible label is
          // gone: the placeholder is not a name (unreliable across assistive
          // tech, and gone on the first keystroke), and `subject` is what stops
          // fifteen identical "Note" fields down a step list.
          aria-label={`${fieldLabel} for ${subject}`}
          aria-describedby={showCounter ? `${hintId} ${counterId}` : hintId}
          onChange={(e) => {
            setNote(clampToBudget(e.target.value));
            scheduleSave();
          }}
          onBlur={flushPending}
          onKeyDown={(e) => {
            // Escape closes the disclosure and returns focus. Enter must NOT —
            // this is a multi-line field and a newline is a legitimate thing to
            // type in a note.
            if (e.key === "Escape") {
              e.stopPropagation();
              close();
            }
          }}
          // `placeholder:text-muted-foreground` is NOT decoration. Tailwind's
          // default placeholder is `currentColor` at 50%, which MEASURES 3.22:1
          // on the light --background and 4.29:1 on the dark one — both below
          // the 4.5:1 AA floor. --muted-foreground is 5.27:1 and 9.13:1. No
          // `dark:` partner is needed because the token already flips with the
          // theme, which is the whole reason to use it over a numbered shade.
          className="border-input focus-visible:ring-ring focus-visible:ring-offset-background placeholder:text-muted-foreground w-full rounded-md border px-2 py-1 outline-none focus-visible:ring-2 focus-visible:ring-offset-2"
        />
        <p id={hintId} className="text-muted-foreground text-xs">
          {t("note.hint", voice)}
        </p>
        {showCounter && (
          <p
            id={counterId}
            data-testid="note-counter"
            // `role="status"` already implies a polite live region; `aria-live`
            // is stated as well because some assistive tech honours only one of
            // the two. NO `aria-label` — on a live region the NAME and the
            // announced CONTENT are different things, and a name paraphrasing
            // the content is how it gets said twice.
            role="status"
            aria-live="polite"
            className="text-muted-foreground text-xs"
          >
            {remaining} characters left
          </p>
        )}
      </div>
    </div>
  );

  // Placed by the caller (list rows), or stacked (the task detail page).
  if (children) return <>{children({ trigger, body })}</>;
  return (
    <div className={cn("space-y-1", dense ? "text-xs" : "text-sm")}>
      {trigger}
      {body}
    </div>
  );
}
