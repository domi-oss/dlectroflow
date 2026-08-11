/**
 * Where every `new RegExp(...)` in this repo gets its pattern from (#234).
 *
 * ── Why this module exists ───────────────────────────────────────────────────
 *
 * `eslint.detect-non-literal-regexp` is the largest single source of SAST
 * findings here: **58 records across the project's vulnerability history, 57 of
 * them already dismissed** (2026-08-11), spread across ten files that the rule
 * still reports on. Its sibling `nodejs_scan.javascript-dos-rule-regex_dos` sits
 * behind it, and between them the regex family is most of what the scanners have
 * ever said about this codebase.
 *
 * None has been a true positive, and that is structural rather than lucky: the
 * CWE needs an attacker to influence the pattern. Every construction here
 * interpolates a file-level literal constant, a value already through
 * `escapeForRegExp`, a Postgres identifier read out of this repo's own
 * migration SQL, or a test fixture. There is no path from a request to a
 * `new RegExp`.
 *
 * ── What the cost actually is, and what it is NOT ───────────────────────────
 *
 * **These findings do not block merges, and this module's first draft claimed
 * they did.** The scan-result policy gates on `severity_levels: [critical,
 * high]` with `vulnerability_states: [new_needs_triage]`; this rule is Medium,
 * and there are zero Critical or High findings anywhere on `main`. The MR that
 * was cited three times as "blocked by this" read `approvals_required: 0,
 * approved: true` throughout. The repo's own CHANGELOG already said so, in the
 * shipped #134 entry — and the new claim contradicted it 1600 lines away.
 * Corrected here because a wrong reason attached to a right change is how the
 * next person justifies the wrong change.
 *
 * The real cost is **triage toil, and it is large**. Semgrep fingerprints a
 * finding by file and line, so a dismissal attaches to a POSITION rather than
 * to code: any edit above one — a comment, an import, a reordered block —
 * resurfaces an already-triaged finding as untriaged, and somebody has to read
 * it and dismiss it with written evidence again. That is what 57 dismissals
 * across 58 records buys you. The three constructs in the scoping harness
 * account for 11 of them by themselves, and `!318`, which touched only a page
 * footer and its tests, produced three more.
 *
 * The count above is deliberately the **cumulative** one rather than a
 * per-pipeline snapshot, because a snapshot rots: this rule read 15 of 37
 * findings on `57a272a` and 18 of 40 three merges later. If you re-measure,
 * **paginate** — the project's SAST history runs to 141 records and a single page
 * of 100 undercounts this rule by three.
 *
 * ── Why a guard and not just a rewrite ───────────────────────────────────────
 *
 * #234 as filed proposed removing three `new RegExp` constructs from the
 * scoping harness. Those are 3 of the 28 constructions in the tree, and
 * `registry-prune.test.ts` carries the same three. Worse, the harness's patterns
 * are assembled from `Prisma.dmmf` **at runtime**, which is what makes a model
 * enrol in the scoping check automatically; replacing them with a fixed set
 * would trade a false positive for a real hole.
 *
 * So the fix follows #83's precedent, which is the one this repo already uses
 * for this shape: demote the rule in `.gitlab/sast-ruleset.toml` so it stops
 * generating triage work, and pair the demotion with a repo-owned guard that
 * asserts the property the rule cannot — that every pattern is built from
 * something an attacker cannot reach. That guard **fails the unit-test job**,
 * which is a hard gate and strictly stronger than what the demoted rule was
 * doing, and its keys carry no line number so it cannot re-fingerprint.
 *
 * ── Shape ────────────────────────────────────────────────────────────────────
 *
 * A pure module with no `fs`, per `CLAUDE.md`: the parsing is unit-testable on
 * synthetic input, so it can be *shown* to fail, and the colocated test reads
 * the real tree. A guard whose parser can only be exercised against the repo
 * cannot be trusted to fail when it should.
 */
export type RegExpVerdict =
  /** No interpolation at all — indistinguishable from a regex literal. */
  | "literal"
  /** Every interpolated value is a SCREAMING_CASE module constant. */
  | "constant"
  /** Every interpolated value passes through `escapeForRegExp`. */
  | "escaped"
  /**
   * Dynamic, but constructed inside a test file. There is no runtime path and
   * the inputs are the test's own fixtures, so no request can reach the
   * pattern. This is a categorical exemption and it is deliberately visible in
   * the report rather than filtered out — it is most of the tree.
   */
  | "test-only"
  /** Dynamic in production code. Must be argued for in the test's allowlist. */
  | "unreviewed";

export interface RegExpSite {
  /**
   * `<file>::<normalised first argument>`.
   *
   * **No line number, on purpose.** A key that moved with the line would rot
   * exactly the way the Semgrep fingerprints this module exists to escape do:
   * an unrelated edit above a site would drop its allowlist entry and the guard
   * would fail for no reason anybody could act on.
   */
  key: string;
  file: string;
  /** The first argument's source, with runs of whitespace collapsed. */
  argument: string;
  /** The raw `${…}` expressions, in source order. */
  interpolations: string[];
  verdict: RegExpVerdict;
}

/**
 * Colocated `*.test.ts(x)`, anything under a `__tests__` directory, and the
 * Playwright specs under `e2e/`.
 *
 * `e2e/` is in the list because the rule fires there too — two findings in
 * `e2e/smoke/settings-disclosure.spec.ts` — and a guard that silently did not
 * look at a directory the rule reports on would leave a hole in the very thing
 * it is compensating for.
 */
export function isTestFile(file: string): boolean {
  return (
    /\.(test|spec)\.tsx?$/.test(file) ||
    file.includes("__tests__/") ||
    file.startsWith("e2e/")
  );
}

export function regexpSiteKey(file: string, argument: string): string {
  return `${file}::${argument}`;
}

/**
 * A per-character map of what is executable code and what is not (#234).
 *
 * Built in ONE pass over the raw source, and it replaces both a `stripComments`
 * call and a hand-rolled quote tracker that this guard originally used. Those
 * were wrong, and wrong in the way that matters most for a compensating
 * control: **they failed silently and in the safe-looking direction.**
 *
 * `src/lib/version-hygiene.ts:74` contains the regex literal `/^(["'])(.*?)\1/`.
 * A quote tracker with no notion of a regex literal reads that `"` as opening a
 * string and never finds a close, so every `new RegExp` below it — including
 * the one on line 98 that the SAST rule reports — is treated as string content
 * and skipped. The guard reported that file clean while the rule kept firing on
 * it. Four of the files the rule names were being missed this way.
 *
 * So the states are tracked properly: line and block comments, single- and
 * double-quoted strings, template literals (whose `${…}` pushes back into
 * code, recursively, because a template can contain a template), and regex
 * literals. Escapes are handled by skipping the escaped character rather than
 * by looking backwards at `src[i - 1]`, which mis-reads `\\` as escaping
 * whatever follows it.
 *
 * ── One invariant carries the `.tsx` cases (!319 review) ─────────────────────
 *
 * **A construct that does not terminate on its own line was never that
 * construct.** Neither a regex literal nor a `'`/`"` string may contain a raw
 * newline, so an unterminated one is ordinary code — and treating it as open,
 * then skipping to the newline, blinded the scanner to the rest of that line.
 * Two ordinary JSX shapes did exactly that: `</span>`, whose `/` sits in a
 * position where a regex may legally open, and an apostrophe in prose text
 * (`<p>don't</p>`). A `new RegExp` later on either line went unseen. JSX text is
 * not JavaScript and no tokeniser here can know it is inside text, but it can
 * know a string never closed.
 */
function codeMask(src: string): Uint8Array {
  const mask = new Uint8Array(src.length);
  // Each frame is a template literal we are inside; `depth` counts the braces
  // open within its current `${…}`, so a nested object or template closes at
  // the right one.
  const templates: { depth: number }[] = [];
  let i = 0;

  const significantBefore = (at: number): string => {
    for (let j = at - 1; j >= 0; j--) {
      if (!/\s/.test(src[j])) return src[j];
    }
    return "";
  };
  // A `/` opens a regex literal rather than a division wherever a value cannot
  // already have been completed. The keyword arm matters for `return /x/` and
  // `case /x/`, which the punctuation test alone would read as division.
  const REGEX_PRECEDER = /[(,=:[!&|?{};+\-*%~^<>]/;
  const REGEX_KEYWORD =
    /\b(return|typeof|instanceof|in|of|new|delete|void|case|do|else|yield|await)$/;

  const startsRegex = (at: number): boolean => {
    const prev = significantBefore(at);
    if (prev === "") return true;
    if (REGEX_PRECEDER.test(prev)) return true;
    return REGEX_KEYWORD.test(src.slice(Math.max(0, at - 12), at).trimEnd());
  };

  /**
   * The index just past `close`, or **-1** when the construct never terminated.
   *
   * `-1` is what the quote arm needs: a `'` or `"` that does not close on its own
   * line was never a string opener, and returning the newline's index instead
   * swallowed the remainder of the line as string content.
   */
  const skipTo = (
    from: number,
    close: string,
    escapable: boolean,
    bailOnNewline: boolean,
  ): number => {
    for (let j = from; j < src.length; j++) {
      if (escapable && src[j] === "\\") {
        j++;
        continue;
      }
      if (src.startsWith(close, j)) return j + close.length;
      if (bailOnNewline && src[j] === "\n") return -1;
    }
    // A comment may legitimately run to end of file; a string may not.
    return bailOnNewline ? -1 : src.length;
  };

  while (i < src.length) {
    const ch = src[i];
    const frame = templates[templates.length - 1];

    if (frame !== undefined && frame.depth === 0) {
      // Inside a template's TEXT: only `${` and the closing backtick matter.
      if (ch === "\\") {
        i += 2;
        continue;
      }
      if (ch === "$" && src[i + 1] === "{") {
        frame.depth = 1;
        mask[i] = 1;
        mask[i + 1] = 1;
        i += 2;
        continue;
      }
      if (ch === "`") {
        templates.pop();
        i++;
        continue;
      }
      i++;
      continue;
    }

    // Real code — either top level, or inside a template interpolation.
    if (src.startsWith("//", i)) {
      i = skipTo(i + 2, "\n", false, false);
      continue;
    }
    if (src.startsWith("/*", i)) {
      i = skipTo(i + 2, "*/", false, false);
      continue;
    }
    if (ch === '"' || ch === "'") {
      const end = skipTo(i + 1, ch, true, true);
      if (end !== -1) {
        i = end;
        continue;
      }
      // Never closed on this line, so not a string — an apostrophe in JSX prose
      // is the ordinary case. Fall through and mask it as code.
    } else if (ch === "`") {
      templates.push({ depth: 0 });
      i++;
      continue;
    } else if (ch === "/" && startsRegex(i)) {
      // Skip the body. The flags that follow are ordinary identifier
      // characters and are left as code, which is harmless — `g`, `i` and `m`
      // cannot begin a `new RegExp(` match.
      let j = i + 1;
      let cls = false;
      let closed = false;
      for (; j < src.length; j++) {
        if (src[j] === "\\") {
          j++;
          continue;
        }
        if (src[j] === "[") cls = true;
        else if (src[j] === "]") cls = false;
        else if (src[j] === "/" && !cls) {
          closed = true;
          break;
        } else if (src[j] === "\n") break;
      }
      if (closed) {
        i = j + 1;
        continue;
      }
      // No closing `/` before the line ended, so this was not a regex literal —
      // `</span>` is the case that matters. Fall through and mask it as code.
    }
    if (frame !== undefined) {
      if (ch === "{") frame.depth++;
      else if (ch === "}") {
        frame.depth--;
        if (frame.depth === 0) {
          mask[i] = 1;
          i++;
          continue;
        }
      }
    }
    mask[i] = 1;
    i++;
  }
  return mask;
}

/**
 * The index of the matching `)` for the `(` at `open`, or -1. Counts only
 * brackets the mask calls code, so a `)` inside the pattern cannot close it.
 */
function matchingParen(src: string, mask: Uint8Array, open: number): number {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (!mask[i]) continue;
    if (src[i] === "(") depth++;
    else if (src[i] === ")") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** The first argument of a call whose parentheses span `open`..`close`. */
function firstArgument(
  src: string,
  mask: Uint8Array,
  open: number,
  close: number,
): string {
  let depth = 0;
  for (let i = open + 1; i < close; i++) {
    if (!mask[i]) continue;
    const ch = src[i];
    if (ch === "(" || ch === "[" || ch === "{") depth++;
    else if (ch === ")" || ch === "]" || ch === "}") depth--;
    else if (ch === "," && depth === 0) return src.slice(open + 1, i);
  }
  return src.slice(open + 1, close);
}

/** The `${…}` expressions inside a template literal, brace-nesting aware. */
function interpolationsOf(argument: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < argument.length - 1; i++) {
    if (argument[i] !== "$" || argument[i + 1] !== "{") continue;
    // Count the run, do not test one character (!319 review). `\\b` and `\\s+`
    // are everywhere in this repo's patterns, so an interpolation right after an
    // ESCAPED backslash is ordinary — and it was being skipped, which classified
    // `` `a\\\\${attacker}b` `` as a literal. An odd run escapes the `$`; an even
    // run is escaped backslashes and the `$` is live.
    let slashes = 0;
    while (argument[i - 1 - slashes] === "\\") slashes++;
    if (slashes % 2 === 1) continue;
    let depth = 1;
    let j = i + 2;
    for (; j < argument.length && depth > 0; j++) {
      if (argument[j] === "{") depth++;
      else if (argument[j] === "}") depth--;
    }
    out.push(argument.slice(i + 2, j - 1).trim());
    i = j - 1;
  }
  return out;
}

const MODULE_CONSTANT = /^[A-Z][A-Z0-9_]*$/;

/**
 * The whole expression must be one `escapeForRegExp(...)` call and nothing else.
 *
 * A prefix test was the first version, and it let everything after the call
 * ride: `${escapeForRegExp(a) + raw}` and `${escapeForRegExp(a) ? raw : other}`
 * both read as escaped while interpolating a raw value. Anchoring both ends is
 * the difference between "an escape happened somewhere in here" and "this value
 * IS the escape's result".
 */
function isEscapedCall(expr: string): boolean {
  const head = /^escapeForRegExp\s*\(/.exec(expr);
  if (head === null) return false;
  // Only the parens the mask calls code count. Duo raised this on !319 — "string
  // literals passed to escapeForRegExp could themselves contain parens" — and the
  // first fix closed the open half and left this one: `escapeForRegExp(")")` had
  // its call ended by the `)` inside its own string argument, so a genuine single
  // call was reported unreviewed. Fail-closed, but a guard that flags correct code
  // is how a guard gets relaxed later.
  const mask = codeMask(expr);
  let depth = 0;
  for (let i = head[0].length - 1; i < expr.length; i++) {
    if (!mask[i]) continue;
    if (expr[i] === "(") depth++;
    else if (expr[i] === ")") {
      depth--;
      // Nothing may follow the closing paren — no `+ raw`, no `.slice(…)`,
      // no `? raw : other`.
      if (depth === 0) return expr.slice(i + 1).trim() === "";
    }
  }
  return false;
}

/**
 * Is `name` bound by a file-level `const NAME = <literal>` in this source?
 *
 * The first version tested the identifier's SHAPE, which is not a property of
 * the value at all. A SCREAMING_CASE function parameter, a reassignable `let`,
 * `const BASE = process.env.BASE`, and `const { QUERY } = await req.json()` all
 * match `^[A-Z][A-Z0-9_]*$` — and the last two are attacker-reachable by
 * definition.
 *
 * Three things it must get right, all found by the second !319 round:
 *
 * 1. **Only declarations the mask calls code.** A raw line scan let a
 *    declaration written inside a template-literal FIXTURE vouch for a name it
 *    never bound, and this repo's hygiene tests are built out of source
 *    fixtures. That failed OPEN.
 * 2. **Column 0 only.** The scan trimmed each line, so an indented `const`
 *    inside some unrelated function body satisfied a check whose entire claim is
 *    "file-level".
 * 3. **`export const` counts.** It is a file-level const, and dozens of the
 *    repo's SCREAMING_CASE literals are exported. Rejecting them told the reader
 *    to build the pattern from a module constant, which is what they had done.
 *
 * **Known limit, stated rather than papered over:** this resolves a name by
 * declaration, not by scope. A file-level `const NAME = "x"` *shadowed* at the
 * construction site — by a same-named parameter, say — still reads as the
 * constant. Closing that needs a scope-resolving parser rather than a line scan,
 * which is a different module; the residual is narrow because the shadow has to
 * be SCREAMING_CASE to reach this function at all, and the allowlist is where a
 * reviewer disposes of anything this cannot decide.
 */
function isFileLevelConst(
  name: string,
  source: string,
  mask: Uint8Array,
): boolean {
  const decl = `const ${name}`;
  for (let at = 0; at < source.length;) {
    const nl = source.indexOf("\n", at);
    const end = nl === -1 ? source.length : nl;
    const line = source.slice(at, end);
    const offset = line.startsWith("export ") ? "export ".length : 0;
    // `mask[at + offset]` is the check that keeps fixture text out: inside a
    // template literal the declaration's own `c` is not code.
    if (mask[at + offset] === 1 && line.startsWith(decl, offset)) {
      const after = line.slice(offset + decl.length);
      // Guard against `const PREFIXES = …` matching a request for `PREFIX`.
      if (!/^[A-Za-z0-9_$]/.test(after)) {
        const eq = after.indexOf("=");
        if (eq === -1) return false;
        const init = after
          .slice(eq + 1)
          .trim()
          .replace(/;$/, "");
        // The INITIALISER has to be a literal too, not merely the binding.
        // `const BASE = process.env.BASE ?? ""` is a file-level const and is
        // external input; so is `const { QUERY } = await req.json()`. Being
        // unreassignable says nothing about where the value came from, and where
        // it came from is the only question this module asks.
        if (/^-?\d[\d_.]*$/.test(init)) return true;
        return isSingleLiteral(init) && !init.includes("${");
      }
    }
    if (nl === -1) break;
    at = nl + 1;
  }
  return false;
}

/**
 * Is the argument a single regex literal, as in `new RegExp(/^a$/, "gi")`?
 *
 * That idiom re-flags a written-out pattern, so it is exactly what the demoted
 * rule asks for and it was being reported `unreviewed` (!319 review). What must
 * not ride in on it is a literal used as a *value*: `new RegExp(/^a/.source +
 * raw)` also begins with a `/` and is a concatenation, so the closing `/` has to
 * be followed by nothing but flag letters.
 */
function isSingleRegexLiteral(argument: string): boolean {
  if (argument[0] !== "/") return false;
  let cls = false;
  for (let i = 1; i < argument.length; i++) {
    const ch = argument[i];
    if (ch === "\\") {
      i++;
      continue;
    }
    if (ch === "[") cls = true;
    else if (ch === "]") cls = false;
    else if (ch === "\n") return false;
    else if (ch === "/" && !cls) {
      return /^[dgimsuvy]*$/.test(argument.slice(i + 1).trim());
    }
  }
  return false;
}

/**
 * Is the argument a SINGLE string or template literal, with nothing appended?
 *
 * `"^" + userPrefix + "$"` begins with a quote and contains no `${`, so the
 * interpolation count was zero and it classified as `literal` — while being the
 * commonest way in JavaScript to build exactly the pattern CWE-185 is about.
 */
function isSingleLiteral(argument: string): boolean {
  const open = argument[0];
  if (open !== '"' && open !== "'" && open !== "`") return false;
  let templates = 0;
  for (let i = 0; i < argument.length; i++) {
    const ch = argument[i];
    if (ch === "\\") {
      i++;
      continue;
    }
    if (open === "`") {
      if (ch === "`") {
        templates += templates === 0 ? 1 : -1;
        if (templates === 0) return argument.slice(i + 1).trim() === "";
      }
      continue;
    }
    if (i > 0 && ch === open) return argument.slice(i + 1).trim() === "";
  }
  return false;
}

function classify(
  argument: string,
  interpolations: string[],
  source: string,
  mask: Uint8Array,
): RegExpVerdict {
  // A written-out `/pattern/` is as fixed as a string, and cannot interpolate.
  if (isSingleRegexLiteral(argument)) return "literal";
  // Not one literal token: a bare expression (`new RegExp(line)`) or a
  // concatenation (`"^" + x`). Either way nothing about the pattern is fixed.
  if (!isSingleLiteral(argument)) return "unreviewed";
  if (interpolations.length === 0) return "literal";

  let sawEscape = false;
  for (const expr of interpolations) {
    if (MODULE_CONSTANT.test(expr) && isFileLevelConst(expr, source, mask))
      continue;
    if (isEscapedCall(expr)) {
      sawEscape = true;
      continue;
    }
    return "unreviewed";
  }
  // Reported as `escaped` when any value needed escaping, because that is the
  // stronger claim of the two and the one a reader should see first.
  return sawEscape ? "escaped" : "constant";
}

/**
 * Every `new RegExp(...)` construction in one file.
 *
 * A match is kept only where {@link codeMask} says the position is executable
 * code — comments and string contents are excluded by the mask rather than by
 * stripping the source first. That is not defensive tidying: FOUR files in this
 * repo carry a comment explaining why they *avoid* `new RegExp`, and one test
 * asserts a source file does not contain the string. A scanner that read those
 * would report the code that got it right as the offender — the same "tools
 * read comments as code" fault that has already cost this repo two red
 * pipelines and one fabricated review finding.
 */
export function scanRegExpSites(file: string, source: string): RegExpSite[] {
  const mask = codeMask(source);
  const sites: RegExpSite[] = [];
  const call = /\bnew\s+RegExp\s*\(/g;

  let m: RegExpExecArray | null;
  while ((m = call.exec(source)) !== null) {
    // The mask is what rules out a match inside a comment or a string. FOUR
    // files here carry a comment explaining why they avoid `new RegExp`, and one
    // test asserts a source file does not contain the string — a scanner that
    // read those would report the code that got it right as the offender.
    if (!mask[m.index]) continue;
    const open = m.index + m[0].length - 1;
    const close = matchingParen(source, mask, open);
    if (close === -1) continue;
    const argument = firstArgument(source, mask, open, close)
      .trim()
      .replace(/\s+/g, " ");
    const interpolations = interpolationsOf(argument);
    let verdict = classify(argument, interpolations, source, mask);
    if (verdict === "unreviewed" && isTestFile(file)) verdict = "test-only";
    sites.push({
      key: regexpSiteKey(file, argument),
      file,
      argument,
      interpolations,
      verdict,
    });
    call.lastIndex = close;
  }
  return sites;
}
