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
 * Split a captured string into its item text and its inline note.
 *
 * Returns the input trimmed and `note: null` whenever the syntax does not
 * apply, which is the overwhelmingly common case — every caller can therefore
 * run this unconditionally instead of sniffing for a `{` first.
 *
 * **Idempotent by construction**, and that is load-bearing rather than
 * incidental: `renameItem` re-parses on every edit, so a function that split a
 * second group off its own output would erode an item's text one brace group
 * per rename. The output's `text` never ends in `}` when a split happened, so
 * re-running it is a no-op.
 */
export function splitInlineNote(raw: string): InlineNoteSplit {
  const trimmed = raw.trim();
  if (!trimmed.endsWith("}")) return { text: trimmed, note: null };

  const open = matchingOpenBrace(trimmed, trimmed.length - 1);
  // Unbalanced: a `}` whose `{` never arrives. Literal, whole string.
  if (open === -1) return { text: trimmed, note: null };

  const text = trimmed.slice(0, open).trim();
  // Nothing would be left to name the item. A row whose only content is hidden
  // behind a note disclosure is not a captured thought, so the braces stay
  // literal and the person can see exactly what they typed.
  if (text === "") return { text: trimmed, note: null };

  const note = trimmed.slice(open + 1, trimmed.length - 1).trim();
  // `{}` — and `{   }`, which is the same intent typed more slowly. There is no
  // note to make, and eating the characters would be a silent edit with nothing
  // to show for it, so the group stays literal too.
  if (note === "") return { text: trimmed, note: null };

  return { text, note };
}
