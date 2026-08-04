/**
 * #150 — the step every regex-based source scanner in this repo has to take
 * before it looks at anything: source with the comments removed.
 *
 * Prose that *describes* a construct is indistinguishable from code that *uses*
 * it once the reader is a regex, and this repo writes long explanatory comments
 * on purpose — so the modules most likely to trip a scanner are the ones whose
 * subject matter IS the thing being scanned for. It has now happened twice:
 * `manifest-hygiene` (#76) read a package name out of the `npm install` header
 * Prisma generates, and `env-drift` (#30) read `PATH` and an example binding
 * called `A` out of a doc comment on !227 (#146), failing CI on two variables
 * that do not exist.
 *
 * ── Why this is its own module ───────────────────────────────────────────────
 * The helper started life inside `manifest-hygiene`, and the obvious fix for
 * #150 was to import it from there. That works and is wrong: it would make
 * env-documentation hygiene depend on package-declaration hygiene, two
 * invariants with nothing to do with each other, and the next person editing
 * `stripComments` for one scanner's needs would silently change the other's
 * verdict with no signal that a second caller exists. A neutral text helper is
 * a dependency a reader accepts at a glance; one scanner reaching into another
 * is one they have to go and check.
 *
 * ── Who does NOT need it ─────────────────────────────────────────────────────
 * The AST-based scanners (`fetch-host-hygiene`, `git-env-hygiene`) get comment
 * removal for free, because a parser never sees comments as code. The regex
 * ones stay regex-based deliberately — dependency-free, and short enough that
 * the whole rule fits on screen — so this is the price they pay instead.
 */

/**
 * `source` with comments removed, so a construct quoted inside a comment (the
 * `// npm install --save-dev prisma dotenv` header Prisma generates, say, or a
 * doc comment naming an env variable as an example) is never mistaken for the
 * real thing.
 *
 * The line-comment pass refuses to fire when `//` is preceded by `:`, which
 * keeps a `https://…` inside a string from truncating the rest of the line.
 *
 * Text-level, not a parser: a `//` or `/*` sequence inside a string literal can
 * still be read as the start of a comment. That errs towards seeing LESS, so
 * the failure mode is a scanner missing a real occurrence rather than inventing
 * one — and every caller reports what it finds as a hard CI failure, where a
 * phantom finding costs a pipeline and a debugging session while a miss costs
 * nothing until the construct appears again in plain code. Callers that cannot
 * accept that trade should parse, as the AST-based scanners do.
 */
export function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

/**
 * The same step for shell source (#157). `scripts/*.sh` in this repo carry
 * header comments longer than the code under them, and the value most likely to
 * be quoted in one is the value a scanner is looking for — so `check-log-
 * retention.sh` documenting its old retention window in prose must not read as
 * its current one.
 *
 * A character scan rather than a regex, because shell's `#` is only a comment
 * when it is unquoted AND begins a word: `${sub#=}` and `severity#x` are not
 * comments, and a line-anchored regex cannot see quote state that opened on an
 * earlier line. Quoting is tracked across the whole input for that reason.
 *
 * Deliberately does NOT model backslash escapes or here-documents. Both would
 * make it a parser; the failure they cause is over-stripping, which loses a
 * binding and makes the caller's answer `null` — a loud miss, not a confident
 * wrong one.
 */

/**
 * Characters after which an unquoted `#` begins a word, and therefore a
 * comment. Whitespace is the obvious half; the operators are the half that is
 * easy to miss, and missing them fails in the direction that matters — a
 * commented-out binding read as live code.
 *
 * Each one measured against bash rather than reasoned about, because the naive
 * reading of "start of a word" is wrong for several of them:
 *
 *     printf X |#c        the `#c` is a comment; the pipe still runs
 *     (#c \n printf Y)    the `#c` is a comment; the subshell still runs
 *     printf Z >#f        the `#f` is a comment, so `>` has no target and bash
 *                         reports a syntax error rather than writing to `#f`
 *
 * `$`, `{`, `}`, `=`, `-` and word characters are all in the tested set and all
 * correctly excluded: `${sub#=}` and `severity#x` must survive.
 */
const WORD_START_BEFORE_HASH = "\n \t;&|()<>";

export function stripShellComments(source: string): string {
  let out = "";
  let quote: '"' | "'" | null = null;
  let i = 0;
  while (i < source.length) {
    const ch = source[i];
    if (quote !== null) {
      out += ch;
      if (ch === quote) quote = null;
      i += 1;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      out += ch;
      i += 1;
      continue;
    }
    // Unquoted `#` starts a comment only at the start of a word — otherwise it
    // is parameter expansion (`${v#p}`) or part of a bare token.
    const prev = i === 0 ? "\n" : source[i - 1];
    if (ch === "#" && WORD_START_BEFORE_HASH.includes(prev)) {
      while (i < source.length && source[i] !== "\n") i += 1;
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}
