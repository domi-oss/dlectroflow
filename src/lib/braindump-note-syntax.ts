/**
 * The inline note syntax on a brain dump (#179).
 *
 *     water the office plants {can under sink needs a wash}
 *      └────────── text ─────┘ └──────────── note ────────┘
 *
 * Pure module (no `fs`, no Prisma, no React), because three places need the
 * same answer and must not drift: `createBrainDumpItem` (capture), `renameItem`
 * (edit), and this file's own tests. It is deliberately syntax-only — the
 * caller hands the note to `normalizeTaskNote` (src/lib/task-notes.ts) for the
 * control-character sweep and the 2000-code-point clamp, so this module has no
 * opinion about what a note may CONTAIN, only about where one begins.
 *
 * ## Why the rule is "only at the very END", and why that is the whole design
 *
 * A syntax that fires mid-string needs an escape character, and an escape
 * character is a second syntax nobody will remember at the speed this feature
 * exists to support. The alternative is strictness: **the group has to be the
 * last thing in the string**, which is a position JSON, code fragments, `{TBD}`
 * and template placeholders essentially never occupy in a captured thought.
 *
 * So `water the plants {can under sink}` splits, and `fix the {foo} handler`
 * does not — nor does `rename {old} to {new}.`, because the `.` means the group
 * is not final. That refusal is the feature, not a limitation of it.
 *
 * That is the **whole** rule, with no second clause. `fix {foo} {bar}` therefore
 * splits into text `fix {foo}` plus note `bar`: the last group is the note and
 * the earlier one stays where it was typed. An earlier version of this module
 * added a second clause — refuse any split whose own output would split again —
 * to protect the rename path, and #179 decided against paying for that in the
 * syntax. A rule with one clause is the rule people were told; a parser with two
 * makes an exception nobody can predict from the sentence they read.
 *
 * The erosion that second clause prevented is real, and it is closed one layer
 * up instead, by {@link inlineNoteSource} and {@link resolveInlineNoteEdit} at
 * the foot of this file. Read those two together before changing either.
 *
 * ## The residual case, stated rather than left to be discovered
 *
 * `store this: {"a": 1}` DOES split, into `store this:` plus a note reading
 * `"a": 1`. A trailing JSON object is the one literal construct the end-anchored
 * rule cannot tell from a note, and #179 accepted it knowingly: the fix costs
 * either an escape character or a content heuristic, and a heuristic that
 * sometimes decides your note is JSON is worse than a rule that is always the
 * same. It is also visible and reversible — the split shows in the inbox row
 * immediately, and editing the text back re-runs this parser.
 *
 * ## What "unbalanced braces are literal" means here
 *
 * The trailing group is found by scanning BACKWARDS from a final `}` with a
 * depth counter, so it must close. Three ways that fails, all yielding the
 * input unchanged:
 *
 *  • the string does not end in `}` at all (`water the plants {can under sink`);
 *  • it ends in `}` with no opener (`count the closing brace}`);
 *  • the scan runs off the start of the string without depth returning to zero.
 *
 * A backward scan rather than "find the first `{`" so that an EARLIER group
 * survives: `deploy the {{VERSION}} chart {check values.yaml}` must keep the
 * placeholder in the text, and a forward search would have started the note at
 * `{{VERSION}}` and eaten most of the capture.
 */

/** What a capture (or a rename) resolves to. */
export type InlineNoteSplit = {
  /** The item text, trimmed. Never contains the extracted group. */
  text: string;
  /** The note, trimmed — or `null` when the string carried none. */
  note: string | null;
};

/**
 * Index of the `{` that opens the group closed by the `}` at `closeAt`, or
 * `-1` when nothing does.
 *
 * A depth counter rather than a search for the nearest `{`, so a nested pair
 * inside the note (`{check {staging} first}`) does not terminate the group
 * early — the note is allowed to contain braces, it just cannot end early.
 */
function matchingOpenBrace(s: string, closeAt: number): number {
  let depth = 0;
  for (let i = closeAt; i >= 0; i--) {
    const ch = s[i];
    if (ch === "}") depth++;
    else if (ch === "{") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/**
 * Where the trailing brace pair of `s` is, or `null` when `s` has none.
 *
 * Purely about BRACES — it says nothing about whether they enclose a note. That
 * separation is what {@link inlineNoteInsertion} needs: `buy milk {}` holds no
 * note (the group is empty, so `trailingGroup` refuses it) while very much
 * holding a trailing group, and the "add note" button must put the caret inside
 * that one rather than appending a second pair beside it.
 *
 * `s` must have no trailing whitespace, since the pair has to be the last thing
 * in the string for the rule to fire at all.
 */
function trailingGroupRange(s: string): { open: number; close: number } | null {
  if (!s.endsWith("}")) return null;

  const open = matchingOpenBrace(s, s.length - 1);
  // Unbalanced: a `}` whose `{` never arrives. No group, so the caller keeps the
  // braces as literal text.
  if (open === -1) return null;

  return { open, close: s.length - 1 };
}

/**
 * Apply the end-anchored rule once: the trailing group of `s`, or `null` when
 * the rule does not fire.
 *
 * A named function rather than the body of `splitInlineNote` so that the public
 * entry point reads as the rule ("trim, take the trailing group, otherwise it is
 * all text") and every brace-matching decision lives in exactly one place. It is
 * also flat and non-recursive on purpose: a capture is free-text of any length,
 * so a self-calling version would recurse once per group and a long enough paste
 * would overflow the stack inside a server action.
 *
 * `s` is assumed already trimmed.
 */
function trailingGroup(s: string): { text: string; note: string } | null {
  const range = trailingGroupRange(s);
  if (range === null) return null;

  const { open } = range;
  const text = s.slice(0, open).trim();
  // Nothing would be left to name the item. A row whose only content is hidden
  // behind a note disclosure is not a captured thought, so this is not a group
  // and the person sees exactly what they typed.
  if (text === "") return null;

  const note = s.slice(open + 1, s.length - 1).trim();
  // `{}` — and `{   }`, which is the same intent typed more slowly. There is no
  // note to make, and eating the characters would be a silent edit with nothing
  // to show for it, so this is not a group either.
  if (note === "") return null;

  return { text, note };
}

/**
 * Split a captured string into its item text and its inline note.
 *
 * Returns the input trimmed and `note: null` whenever the syntax does not
 * apply, which is the overwhelmingly common case — every caller can therefore
 * run this unconditionally instead of sniffing for a `{` first.
 *
 * **Not idempotent, and that is by decision.** `fix {foo} {bar}` yields text
 * `fix {foo}`, which this function would split again if it were ever handed its
 * own output. Nothing may do that: a CAPTURE sees each string once, and the
 * RENAME path goes through {@link resolveInlineNoteEdit}, which is built so the
 * parser never sees a string it produced. Restoring a self-stability check here
 * would cost a note in a shape people type (a placeholder plus a trailing note)
 * to prevent something that is already impossible upstream — see this module's
 * header for the argument, and the colocated test for the pinned example.
 */
export function splitInlineNote(raw: string): InlineNoteSplit {
  const trimmed = raw.trim();
  return trailingGroup(trimmed) ?? { text: trimmed, note: null };
}

/** Where an input's value and caret should go when the note braces are inserted. */
export type InlineNoteInsertion = {
  /** The input's new value. */
  value: string;
  /**
   * Where the caret goes: the index of the group's closing `}`, so the next
   * character typed lands INSIDE the braces. Always a collapsed caret and never
   * a selection — selecting an existing note's text would mean the first
   * keystroke wiped it.
   */
  caret: number;
};

/**
 * Put the note braces into a capture/edit input's value and say where the caret
 * belongs (#186).
 *
 * The affordance this backs exists for two reasons. On a phone `{` and `}` are
 * two or three taps deep in the symbol keyboard, which is friction on the one
 * control that has to be faster than the thought it captures; and nothing on
 * screen otherwise tells anybody the syntax exists at all.
 *
 * Kept here, next to the parser, rather than in the component: the caret's
 * position and the note's position are the same fact, and a component that
 * worked it out for itself would be a second implementation of "where does a
 * note start" that agrees until one of them is edited.
 *
 * ## Two branches, and why the second one is the whole point
 *
 * With no trailing group, ` {}` is appended. With one already there — including
 * an EMPTY one, which is not a note but is certainly a group — the caret goes
 * inside it and the value is left alone. Appending regardless would turn
 * `fix {foo}` into `fix {foo} {}`, and under Decision 1 the note is the LAST
 * group: the note the person was about to write would become `{bar}` while
 * `{foo}` was silently demoted to text. Reusing the group also makes the button
 * idempotent, so a double tap cannot produce `{} {}`.
 *
 * `trimEnd` rather than `trim`, because indices are measured from position 0 and
 * must stay valid in the returned string — dropping LEADING whitespace would
 * shift every one of them.
 */
export function inlineNoteInsertion(raw: string): InlineNoteInsertion {
  const value = raw.trimEnd();

  const range = trailingGroupRange(value);
  if (range !== null) return { value, caret: range.close };

  // No separator to add when there is nothing in front of the braces. The button
  // is disabled on an empty field — a note is a note ABOUT something — so this
  // is a total function rather than a reachable case.
  const composed = value === "" ? "{}" : `${value} {}`;
  return { value: composed, caret: composed.length - 1 };
}

/** What a keystroke should do to the field, or `null` for "leave it alone". */
export type InlineNoteTyping = InlineNoteInsertion;

/** Every key {@link inlineNoteTyping} has an opinion about. */
type BraceKey = "{" | "}" | "Backspace";

/**
 * Auto-close the note braces as they are typed (#201).
 *
 * The keyboard half of {@link inlineNoteInsertion}'s button, in the same module
 * for the same reason: the two affordances have to agree about a field that may
 * already contain a trailing group, and building them apart would mean two
 * answers to the question this file exists to answer once. On a phone `{` and
 * `}` are two or three taps deep in the symbol layer, which is real friction on
 * the one control that has to be faster than the thought it captures — and it is
 * paid on every note, by the people who use the feature most.
 *
 * Pure: it is handed the field's value, the selection and the key, and returns
 * the value and caret the field should end up with. The DOM work (reading the
 * selection, calling `preventDefault`, placing the caret after React commits)
 * belongs to the caller, which is what makes every branch below testable without
 * a browser.
 *
 * ## The three rules
 *
 * **`{` inserts `{}` and puts the caret between them** — or, with a selection,
 * wraps it. Wrapping rather than replacing is not a nicety: replacing would
 * destroy text the user had deliberately selected, which is the one outcome an
 * auto-close must never produce.
 *
 * **`}` types over a `}` already under the caret** rather than producing `}}`.
 * That is the standard editor behaviour, and its absence is the single thing
 * that makes an auto-close feel broken. Deliberately keyed on "the next
 * character is a `}`" rather than on "we inserted this one": tracking provenance
 * needs a marker that every external value change invalidates — a rename
 * pre-fill, an undo, an autocorrect rewrite — and the observable behaviour of
 * the simple rule is the one every editor ships.
 *
 * **Backspace between `{` and `}` removes both**, so the pair the auto-close
 * created is undone by the keystroke that would have undone the `{` alone.
 *
 * ## …and the refusal, which is the important one
 *
 * **No auto-close when the trimmed value already ends in a brace group.** Under
 * #179 Decision 1 only the LAST group is the note, so silently creating a second
 * one reassigns which text becomes the note — `fix {foo}` typed into
 * `fix {foo} {}` demotes `foo` to text without saying so. `inlineNoteInsertion`
 * refuses the same case by reusing the existing group; here there is no group to
 * reuse (the caret is wherever the user put it), so the `{` is simply left to be
 * typed literally, which the parser is happy with.
 *
 * ## Undo, stated rather than left to be discovered
 *
 * Cmd/Ctrl+Z does NOT treat the auto-inserted `}` as part of the same edit, and
 * cannot be made to from here. The only API that writes to the browser's undo
 * stack is `document.execCommand("insertText")`, which this repo deliberately
 * never calls — `note-field.tsx` documents WebKit's line-ending deviation in it
 * — and a controlled React input's value is already outside the native undo
 * stack for the same reason the "add note" button is. The Backspace rule above
 * is the targeted reversal for the one edit this feature introduces; general
 * undo behaviour is unchanged, not improved and not made worse.
 *
 * ## Why the caller may bind this to `keydown`
 *
 * The usual objection to `keydown` for text entry is that predictive text, swipe
 * input and autocorrect rewrite the field without producing one — which is true,
 * and does not reach this function: **no IME, swipe path or autocorrect emits a
 * bare `{`**. It arrives only from an explicit key press or a symbol-keyboard
 * tap, and both report `key: "{"`. The caller still has to skip a composition in
 * progress, because a `{` typed while an IME is composing belongs to the IME.
 */
export function inlineNoteTyping({
  value,
  key,
  start,
  end,
}: {
  value: string;
  key: string;
  /** `selectionStart`. */
  start: number;
  /** `selectionEnd`; equal to `start` for a collapsed caret. */
  end: number;
}): InlineNoteTyping | null {
  if (key !== "{" && key !== "}" && key !== "Backspace") return null;
  const braceKey: BraceKey = key;

  if (braceKey === "{") {
    // The refusal, checked before anything is composed. `trimEnd` because the
    // parser reads the trimmed string, so a trailing space must not smuggle a
    // second group past a rule that would otherwise have refused it.
    if (trailingGroupRange(value.trimEnd()) !== null) return null;
    const selected = value.slice(start, end);
    const composed = `${value.slice(0, start)}{${selected}}${value.slice(end)}`;
    // Just inside the closing brace, so the next keystroke extends the note
    // rather than escaping it. For a collapsed caret that is `start + 1`; for a
    // wrap it is the far end of what was selected.
    return { value: composed, caret: start + 1 + selected.length };
  }

  if (braceKey === "}") {
    // A selection means the `}` is a replacement, which is an ordinary edit.
    if (start !== end) return null;
    if (value[start] !== "}") return null;
    return { value, caret: start + 1 };
  }

  // Backspace. Only the exact `{|}` shape the auto-close creates; anything else
  // is an ordinary deletion and must behave like one.
  if (start !== end) return null;
  if (value[start - 1] !== "{" || value[start] !== "}") return null;
  return {
    value: `${value.slice(0, start - 1)}${value.slice(start + 1)}`,
    caret: start - 1,
  };
}

/**
 * The single string an edit input should hold for a stored item: its text with
 * its note put back between braces, exactly as a capture would have received it.
 *
 * ## Why the input must not simply show the stored text
 *
 * `renameItem` re-parses whatever the edit field hands back, and the parser has
 * no way to tell "the user typed this fresh" from "this is what we saved last
 * time". Pre-filled with the stored text `fix {foo}`, an unchanged save therefore
 * arrived as a capture of `fix {foo}` — text `fix`, note `foo` — eroding the text
 * one group per save and overwriting the note (`bar`) that was already there.
 * Silent, and repeatable until the text was gone.
 *
 * Reconstructing instead makes the round trip an identity **by construction**
 * rather than by comparison: `splitInlineNote(inlineNoteSource(stored))` is
 * `stored`, so a save that changed nothing writes back what was already there.
 * It also gives the field one honest representation of the source string, which
 * is what the "add note" affordance operates on — two representations would mean
 * two answers to "where does the note start?".
 *
 * ## Why the reconstruction is verified before it is offered
 *
 * The composition is only reversible when the note's braces are balanced. Notes
 * this parser produces always are — `matchingOpenBrace` returns the `{` at depth
 * zero, which makes the extracted region a balanced string — but the column can
 * also be written by an import, or by a note editor that has no reason to care.
 * A note of `a}b` composes to `fix {a}b}`, whose final `}` has no matching `{`:
 * the scan runs off the start, the whole string is literal, and an unchanged save
 * would replace the text with that junk and drop the note.
 *
 * So the round trip is checked, and a note that cannot survive it is left out of
 * the field rather than shown in a form that destroys it. The note is not lost —
 * {@link resolveInlineNoteEdit} keeps it — it just cannot be edited from the
 * title field until something rewrites it as balanced.
 */
export function inlineNoteSource({ text, note }: InlineNoteSplit): string {
  if (note === null) return text;

  const composed = `${text} {${note}}`;
  const reparsed = splitInlineNote(composed);
  return reparsed.text === text && reparsed.note === note ? composed : text;
}

/**
 * What a rename should store, given what the user submitted and what was already
 * there. The other half of {@link inlineNoteSource}; the two close a loop.
 *
 * Two rules, in this order.
 *
 * **1. An unchanged submission is not an edit.** The submitted string is
 * compared against both strings an edit input could honestly have been holding —
 * the reconstruction, and the bare stored text — and either one means the person
 * opened the field and saved. Nothing is parsed, so nothing can drift. The bare
 * text is included as well as the reconstruction on purpose: the erosion bug's
 * whole shape was one call site pre-filling something the save layer did not
 * expect, and a fix that only works for the current pre-fill has to be
 * re-remembered by every future one.
 *
 * **2. A note is only ever written by note syntax.** When the submission IS an
 * edit, its trailing group becomes the note — and when it has no trailing group,
 * the stored note is kept rather than cleared. So text out of the text field can
 * never end up in the note column, which is precisely what erosion did.
 *
 * ## What rule 2 costs, stated rather than left to be discovered
 *
 * Clearing the group does not delete the note. `buy milk {}` and `buy milk` both
 * arrive as "no trailing group", so the note survives and reappears in the field
 * the next time the editor opens; deleting a note needs a note affordance, not
 * the title field.
 *
 * The alternative — treat a vanished group as a deletion — was rejected because
 * its failure mode is worse in the direction that matters. A user who mistypes
 * one brace (`… {can under sink`) would silently destroy the only copy of the
 * note, and there is nothing on screen afterwards to say so. This way the worst
 * case is a note that outstays its welcome, which is visible and reversible.
 */
export function resolveInlineNoteEdit(
  submitted: string,
  stored: InlineNoteSplit,
): InlineNoteSplit {
  const trimmed = submitted.trim();

  // Rule 1. A fresh object rather than `stored` itself, so a caller cannot
  // discover later that it is holding an alias of its own input.
  if (
    trimmed === "" ||
    trimmed === inlineNoteSource(stored) ||
    trimmed === stored.text.trim()
  ) {
    return { text: stored.text, note: stored.note };
  }

  // Rule 2.
  const split = splitInlineNote(trimmed);
  return { text: split.text, note: split.note ?? stored.note };
}
