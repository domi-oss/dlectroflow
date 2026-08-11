/**
 * Parsing `.gitlab-ci.yml`'s scheduled-pipeline flag guards (#191).
 *
 * `.gitlab-ci.yml` states the rule itself: "Each flag variable gets a
 * `when: never` guard on every OTHER scheduled job… Add a flag, add its guards."
 * Getting that wrong is not a style problem. `ops_digest`'s last rule is a bare
 * `schedule` catch-all, so a new flag without its guard means the weekly digest
 * starts riding the new flag's schedule — and #191's is HOURLY, so the miss would
 * have been 24 weekly digests a day.
 *
 * ── Why this module exists rather than a regex in one test ───────────────────
 * The first version of #191's parity assertion did it with line arithmetic:
 * "every `SECURITY_ASSESSMENT` guard must have a `PROD_STATE_CHECK` guard exactly
 * two lines below it", plus `expect(count).toBeGreaterThan(4)`. Duo review flagged
 * both. It was right about the line arithmetic, which asserts **incidental
 * formatting** rather than intent: reordering conditions inside a rule block, or
 * inserting one comment between two guards, fails a test whose subject is
 * untouched.
 *
 * **The 4 is still shipped, on purpose**, at `security-assessment.test.ts` — so
 * "right on both counts" would be the wrong thing to write here. What was wrong
 * was the number's JOB, not its value. It used to *be* the coverage claim,
 * standing in for "every guard is present" by counting an unrelated job's rules,
 * and that is a fact about today's layout which rots on the next edit. Now
 * `guardParityGaps` makes the coverage claim structurally and the 4 is only a
 * floor beneath it: no gaps is equally true of a file with no guards at all and
 * of a parser that matched nothing, so something has to show the derivation came
 * back non-empty. "More than nothing was found" and "this is how many there are"
 * are different assertions, and only the second one goes stale.
 *
 * So the parsing lives here, as a pure module with no `fs`, which is the shape
 * `CLAUDE.md` prescribes for every file-parsing guard in this repo: the parser is
 * unit-testable on synthetic input, so it can be *shown* to fail, and the
 * colocated test reads the real file. A guard whose parser can only be exercised
 * against the repo cannot be trusted to fail when it should.
 */

/** A top-level YAML block — a job, or an anchor/template like `.deploy_base`. */
export interface CiBlock {
  /** The key, without its colon: `ops_digest`, `.deploy_base`. */
  name: string;
  /** The block's full text, including its own first line. */
  text: string;
}

/**
 * Split a CI file into its top-level blocks.
 *
 * Deliberately naive about YAML in general and exact about the one thing that
 * matters: a top-level key starts at column 0. Comments at column 0 belong to
 * whichever block follows them rather than opening one, because a comment is not
 * a key — treating it as one would silently split a job's rules away from its
 * name and make every parity check pass against an empty block.
 */
export function topLevelBlocks(yml: string): CiBlock[] {
  const blocks: CiBlock[] = [];
  let name: string | null = null;
  let buffer: string[] = [];
  let pending: string[] = [];

  const flush = () => {
    if (name !== null) blocks.push({ name, text: buffer.join("\n") });
  };

  for (const line of yml.split("\n")) {
    const isTopLevelKey = /^[^\s#][^\s]*:/.test(line);
    if (isTopLevelKey) {
      flush();
      name = line.slice(0, line.indexOf(":"));
      buffer = [...pending, line];
      pending = [];
      continue;
    }
    if (name === null) {
      // Header comments before the first key. Held rather than dropped so a
      // block's own preamble travels with it.
      pending.push(line);
      continue;
    }
    if (/^#/.test(line)) {
      // A column-0 comment usually introduces the NEXT block. Hold it; if no
      // block follows, it is discarded, which is correct — it belongs to nothing.
      pending.push(line);
      continue;
    }
    if (pending.length > 0) {
      buffer.push(...pending);
      pending = [];
    }
    buffer.push(line);
  }
  flush();
  return blocks;
}

/**
 * `line` with a YAML inline comment removed, quote state respected (#191).
 *
 * Needed because the one file this parser exists to read is the file where an
 * inline comment is idiomatic: `.gitlab-ci.yml` is listed in `.prettierignore`,
 * and the reason recorded there is that it "relies on hand-aligned inline
 * comments". It carries dozens; the exact count is re-measurable and was wrong the first time it was written down. So no formatter will ever normalise one away, and
 * annotating a guard is an edit no reviewer would question.
 *
 * Stripping happens before any matching, which closes both directions at once —
 * and both were silent:
 *
 *     when: never # why           a real guard read as NO guard. Worse than it
 *                                 sounds: `guardParityGaps` skips blocks that
 *                                 guard nothing, so the block leaves the check
 *                                 altogether and passes while asserting nothing.
 *     if: '…'  # was $FLAG_A …    a flag read out of prose, which then enters
 *                                 `allGuardedFlags` and reports every properly
 *                                 guarded block as missing a flag that does not
 *                                 exist.
 *
 * YAML's comment rule is narrower than shell's: an unquoted `#` opens a comment
 * only at the start of a line or after whitespace. `a#b` is the scalar `a#b`,
 * and a `/ #191/` regex inside a quoted `if:` is data, not a comment — hence
 * tracking quotes rather than cutting at the first `#`.
 *
 * Local rather than in `src/lib/source-text.ts` on purpose: that module's own
 * doc records what earns a move there — a SECOND caller — and explains that
 * relocating early buys coupling with no reason for it. This has one caller.
 */
function stripYamlComment(line: string): string {
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quote !== null) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === "#" && (i === 0 || /\s/.test(line[i - 1]))) {
      return line.slice(0, i);
    }
  }
  return line;
}

/**
 * The schedule flags that a block suppresses itself on — that is, the flags
 * appearing in an `if:` whose rule entry carries `when: never`.
 *
 * A flag's OWN job is not included, because that rule has no `when: never`: it is
 * the rule that RUNS the job. That asymmetry is the whole reason the naive
 * "count the occurrences" approach needed a magic number to correct for.
 *
 * The `when: never` is looked for on the next **meaningful** line — blank lines
 * and comments are skipped — so a comment between an `if:` and its `when:` does
 * not silently turn a guard into a non-guard. Anything else terminates the
 * search, because in YAML the `when:` belongs to the `if:` it follows.
 *
 * A comment appended to a line is handled by the same principle rather than as
 * a separate case, since handling one position and not the other was an accident
 * of implementation: `stripYamlComment` runs over every line first, so prose can
 * neither hide a guard nor invent one wherever it sits.
 */
export function guardedFlags(blockText: string): Set<string> {
  const lines = blockText.split("\n").map(stripYamlComment);
  const flags = new Set<string>();

  lines.forEach((line, index) => {
    // `$FLAG == "true"` inside a rules `if:`. Anchored on the `if:` so a mention
    // in prose or a `variables:` default is not mistaken for a rule.
    if (!/\bif:/.test(line)) return;
    // `matchAll`, not `match` (!293 review). A non-global `match` returns the
    // first flag only, so an `if:` carrying `$FLAG_A == "true" && $FLAG_B ==
    // "true"` silently dropped `FLAG_B` from the parity check. No rule in the
    // file has that shape today, so this is latent — but it is latent in the one
    // module whose entire value is that it can be trusted to notice.
    const found = [...line.matchAll(/\$([A-Z][A-Z0-9_]*)\s*==\s*"true"/g)];
    if (found.length === 0) return;
    for (let j = index + 1; j < lines.length; j++) {
      const next = lines[j].trim();
      // A comment-only line has already been stripped to nothing, so it arrives
      // here as "" — the same tolerance the explicit `#` check used to give.
      if (next === "") continue;
      // Tolerant of the spacing because this file is the one Prettier is told
      // to skip; `when:never` is not a mapping, so the space is still required.
      // Every flag on the line, not just the first: a `when: never` reached
      // through `&&` suppresses the block for each of them.
      if (/^when:\s+never$/.test(next)) found.forEach((m) => flags.add(m[1]));
      break;
    }
  });

  return flags;
}

/** Every top-level block that suppresses itself on `flag`. */
export function blocksGuarding(yml: string, flag: string): string[] {
  return topLevelBlocks(yml)
    .filter((block) => guardedFlags(block.text).has(flag))
    .map((block) => block.name);
}

/**
 * Every flag that is guarded anywhere in the file — the set the parity rule
 * applies to. Derived from the file rather than hard-coded, so adding a flag
 * brings it under the rule automatically instead of requiring somebody to
 * remember to add it to a list in a test.
 */
export function allGuardedFlags(yml: string): string[] {
  const flags = new Set<string>();
  for (const block of topLevelBlocks(yml)) {
    for (const flag of guardedFlags(block.text)) flags.add(flag);
  }
  return [...flags].sort();
}

/**
 * The parity violations: a block that guards at least one flag but not all of
 * them. Returns one entry per missing (block, flag) pair so a failure message can
 * name exactly what to add and where.
 */
export function guardParityGaps(
  yml: string,
): Array<{ block: string; missing: string }> {
  const flags = allGuardedFlags(yml);
  const gaps: Array<{ block: string; missing: string }> = [];
  for (const block of topLevelBlocks(yml)) {
    const guarded = guardedFlags(block.text);
    if (guarded.size === 0) continue;
    for (const flag of flags) {
      if (!guarded.has(flag)) gaps.push({ block: block.name, missing: flag });
    }
  }
  return gaps;
}
