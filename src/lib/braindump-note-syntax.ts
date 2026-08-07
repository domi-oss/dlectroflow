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
 * There is a **second** condition, and it exists for the rename path rather than
 * for the syntax: the split must leave behind text that would not split again.
 * `fix {foo} {bar}` therefore stays literal. `splitInlineNote`'s own doc comment
 * argues it, because the reason is idempotence and not readability.
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
 * Apply the end-anchored rule once: the trailing group of `s`, or `null` when
 * the rule does not fire.
 *
 * Split out from `splitInlineNote` so the stability check below can ask the
 * question a SECOND time without recursing. Recursion would have been the
 * obvious spelling and is the wrong one — a capture is free-text of any length,
 * so `a {1} {2} … {N}` would recurse once per group and a long enough paste
 * would overflow the stack inside a server action. Two flat calls are O(n) and
 * cannot.
 *
 * `s` is assumed already trimmed.
 */
function trailingGroup(s: string): { text: string; note: string } | null {
  if (!s.endsWith("}")) return null;

  const open = matchingOpenBrace(s, s.length - 1);
  // Unbalanced: a `}` whose `{` never arrives. No group, so the caller keeps the
  // braces as literal text.
  if (open === -1) return null;

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
 * ## Idempotence is enforced, not hoped for
 *
 * `renameItem` re-parses on every edit, and the edit affordance pre-fills its
 * input with the STORED text — so "the user typed this fresh" and "this is what
 * we saved last time" reach the parser as the same string, with nothing in it to
 * tell them apart. A function that split a second group off its own output would
 * therefore erode an item's text one group per save, and OVERWRITE the note it
 * already had, for anyone who opened the edit field and saved unchanged.
 *
 * So a split is performed only when its own output is stable: if the text that
 * would be left behind is itself splittable, the whole string stays literal.
 * `fix {foo} {bar}` is the case — it has a group at the very end, but leaving
 * `fix {foo}` behind would set that erosion going, so nothing is split and the
 * person sees exactly what they typed.
 *
 * That refusal costs a note in a shape nobody captures often (a mid-string
 * placeholder AND a trailing note), and it is the direction #179 argues for
 * everywhere else: a visible refusal beats a silent edit. It does not touch the
 * common mid-string case, because `deploy the {{VERSION}} chart` does not end in
 * a group — only a group sitting at the very end of the residual triggers it.
 *
 * The resulting invariant is the one the callers need: **`text` never
 * re-splits**, in either branch. `braindump-note-syntax.test.ts` asserts it over
 * every shape in the file rather than over one example, because the single-group
 * example cannot reach the failure.
 */
export function splitInlineNote(raw: string): InlineNoteSplit {
  const trimmed = raw.trim();

  const group = trailingGroup(trimmed);
  if (group === null) return { text: trimmed, note: null };

  // The stability check. `trailingGroup` rather than a `endsWith("}")` test,
  // because a residual can end in `}` and still be stable: `a} b {note}` leaves
  // `a} b`, whose brace has no opener and so would never split again. Testing
  // the character would deny that note for no reason.
  if (trailingGroup(group.text) !== null) return { text: trimmed, note: null };

  return group;
}
