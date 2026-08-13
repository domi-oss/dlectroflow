"use client";

import type { RefObject } from "react";
import { inlineNoteInsertion } from "@/lib/braindump-note-syntax";
import { t, type Voice } from "@/lib/strings";
import { cn, touchTarget } from "@/lib/utils";

/**
 * The "add note" affordance on a brain-dump text field (#186).
 *
 * ## Why a button exists for two characters
 *
 * #179 gave a capture the inline note syntax — `water the plants {can under
 * sink}` — and shipped it with nothing on screen saying so. This control is both
 * halves of that gap:
 *
 *  * **Reach.** On a phone `{` and `}` are two or three taps deep in the symbol
 *    keyboard. That is real friction on the one control in the app that has to
 *    be faster than the thought it is capturing, which is the whole premise of a
 *    brain dump.
 *  * **Discoverability.** A syntax nobody is told about is a syntax nobody uses.
 *    The label is the only thing naming the feature, and the hint beside the
 *    field (`capture.noteHint`) is the only thing naming the RULE — the group has
 *    to be at the very end.
 *
 * Auto-closing a typed `{` is deliberately NOT here; it is its own issue, and it
 * is a different mechanism (an input handler that rewrites what you typed) with
 * its own failure modes.
 *
 * ## Where the note goes is not this component's decision
 *
 * `inlineNoteInsertion` (src/lib/braindump-note-syntax.ts) owns it, next to the
 * parser, because the caret's position and the note's position are the same fact.
 * The one behaviour worth reading twice is what it does when the field ALREADY
 * ends in a brace group: the caret goes inside that one. Appending a second pair
 * would make `fix {foo}` into `fix {foo} {}`, and under Decision 1 the note is
 * the LAST group — so the note being written would become `{bar}` while `{foo}`
 * was silently demoted to text.
 */
export function AddNoteButton({
  subject,
  value,
  inputRef,
  onChange,
  voice,
  className,
}: {
  /** What the field is for, in words — the capture bar's name, or the row's
   *  title. Goes into the accessible name so two mounted at once (the capture
   *  bar and an open row editor) are distinguishable. */
  subject: string;
  /** The field's current value. Controlled, so this is the source of truth for
   *  where the braces go. */
  value: string;
  /** The field itself. Needed because placing a caret is a DOM operation with no
   *  React equivalent — `value` says what the text is, nothing says where in it
   *  the user is. */
  inputRef: RefObject<HTMLInputElement | null>;
  onChange: (next: string) => void;
  voice: Voice;
  className?: string;
}) {
  const label = t("capture.addNote", voice);

  // A note is a note ABOUT something, and the syntax needs text in front of the
  // group or the parser refuses it outright (`{just a note}` stays literal). So
  // there is nothing for this button to do yet.
  //
  // `disabled` rather than `aria-disabled`: the state is decided by a DIFFERENT
  // element's content, so unlike the focus-timer's retry button there is no focus
  // here to protect — nobody can be standing on it when it flips. A disabled
  // control is also exempt from the 1.4.3 contrast floor, which is what makes the
  // dimming below legitimate rather than a regression.
  const disabled = value.trim() === "";

  const insert = () => {
    const { value: next, caret } = inlineNoteInsertion(value);
    onChange(next);
    // AFTER React has committed the new value. Setting the range now would aim
    // at the OLD string, and the browser clamps a range past the current length —
    // on an appended ` {}` that silently parks the caret two characters early,
    // outside the braces. `queueMicrotask` runs once the event's synchronous
    // React flush is done; it is the same dialect `note-field.tsx` uses to focus
    // its textarea on expand.
    queueMicrotask(() => {
      const el = inputRef.current;
      if (!el) return;
      // Focus as well as caret: a phone with the keyboard down and a caret in the
      // right place is still a field you cannot type in.
      el.focus();
      el.setSelectionRange(caret, caret);
    });
  };

  return (
    <button
      type="button"
      disabled={disabled}
      // WCAG 2.5.3 Label in Name: the visible label is a PREFIX of this, so a
      // voice-control user saying "add note" activates it. An explicit label
      // rather than an `sr-only` span for the reason `note-field.tsx` documents
      // at length — name computation welded "Add notefor Ship the thing" into one
      // word there, measured with `dom-accessibility-api`.
      aria-label={`${label} for ${subject}`}
      onClick={insert}
      className={cn(
        // `touchTarget` is the shared 44x44 floor (WCAG 2.5.8). Its
        // `justify-center` is harmless here and no `justify-start` is needed:
        // the content is a single text run wider than 44px, so the box is sized
        // by the label and there is no slack to distribute. That is the opposite
        // of the icon-plus-label case fixed on !278, where the box was wider than
        // its content and centring pushed the pair off the left edge.
        touchTarget,
        // `focus-visible:ring-2` and not a colour swap: a change of hue alone
        // leaves no indicator to see (2.4.7 Focus Visible, AA) and carries
        // neither the area nor the focused/unfocused contrast of 2.4.13 Focus
        // Appearance (AAA, the stronger bar this repo chooses). axe implements no
        // rule for either — see a11y-class-hygiene.ts, and #258 for why the
        // citation that used to be here named neither of them.
        "border-input text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:ring-ring focus-visible:ring-offset-background shrink-0 rounded-md border px-2 text-sm whitespace-nowrap outline-none focus-visible:ring-2 focus-visible:ring-offset-2 disabled:opacity-50",
        className,
      )}
    >
      {label}
    </button>
  );
}
