/**
 * #182 — two words rendering as one, because of a JSX whitespace rule.
 *
 * JSX does not render the whitespace you wrote. Every JSXText child is split on
 * newlines, each line is trimmed, blank lines are dropped, and what is left is
 * joined with a single space. So a newline **between two words** survives as a
 * space, and a newline **adjacent to a tag** vanishes:
 *
 *     Press              renders "PressN"
 *     <kbd>N</kbd>
 *
 *     Press <kbd>N</kbd> renders "Press N"
 *
 * Nobody writes the first form on purpose. Prettier does, when the line grows
 * past `printWidth: 80` and the reflow moves the tag onto its own line — which
 * means the defect appears during an unrelated edit, in a diff that looks like
 * pure formatting. Nothing else in the toolchain can see it: it is valid JSX,
 * valid TypeScript, correctly formatted, and axe has no rule for "these two
 * words are one word".
 *
 * ── Why an AST and not a regex ─────────────────────────────────────────────
 * The obvious `/\w\n\s*</` scan is wrong in both directions, and both were
 * observed on the real tree before this module existed:
 *
 *  * **False negatives.** It cannot tell whether the space it found survives
 *    cleaning. A source-level regex over `help/page.tsx` returned zero while the
 *    page had a real defect, because the shapes it looked for are not the shapes
 *    that weld.
 *  * **False positives.** `<a>Privacy</a>\n<a>Terms</a>` looks identical to a
 *    weld and is not one: no JSXText separates them, the DOM text really is
 *    `PrivacyTerms`, and the links are spaced by CSS `gap`. Extracting the text
 *    of `/help` and grepping for run-together words reported exactly that, and
 *    it was the only hit. See {@link findTextWelds} — element-to-element
 *    boundaries are out of scope by construction, not by allowlist.
 *
 * Kept free of `fs` so the parsing is unit-testable on synthetic sources — the
 * shape `a11y-class-hygiene`, `fetch-host-hygiene` and `ci-docs-only` all share.
 * `jsx-text-weld.test.ts` holds the allowlist and the scan over the real tree.
 *
 * ── What this does NOT cover, stated rather than left to be discovered ─────
 *  1. **Accessible names.** Name computation collapses whitespace by a
 *     different rule again: a leading space inside an `sr-only` span is dropped,
 *     which is how the legal footer computed as `Privacy(opens in a new tab)`
 *     while rendering correctly on screen. Nothing here reads that; the fix for
 *     that class is an explicit `aria-label`, and only a review can require one.
 *  2. **Dynamic text.** `step{count}of` is invisible to this module, because a
 *     `{expr}` neighbour renders whatever it likes and `12{unit}` is routinely
 *     deliberate. Only literal-to-literal boundaries are judged.
 *  3. **CSS.** An inline element that a class makes `block` cannot weld, and one
 *     this module calls a separator might be `display:inline` by class. Tag
 *     names are the approximation; see {@link INLINE_TAGS}.
 *  4. **Missing spacing that is not a weld** — a `<kbd>` with no styling reads
 *     as jammed against its neighbours even with a space between them. That is
 *     a design gate, not a parsing one.
 */

import ts from "typescript";

/**
 * HTML's inline text semantics elements, the ones that flow inside a paragraph
 * and therefore *can* weld to the text beside them.
 *
 * `br` and `wbr` are deliberately absent: both are breaks rather than text, so
 * a word on either side cannot run into anything. Block elements are absent for
 * the obvious reason — a `div` or `li` opens its own line box.
 *
 * A capitalised tag is a component and is never in this set. Its rendered text
 * is not knowable from this file, and guessing costs precision the guard cannot
 * afford. `Link` is the tempting exception (it is always an `<a>`) and is still
 * excluded: it usually wraps a whole block, and the two `Link`s in the tree that
 * do sit inside prose already carry their spacing. Adding it would trade a real
 * false-positive risk for no finding.
 */
const INLINE_TAGS = new Set([
  "a",
  "abbr",
  "b",
  "bdi",
  "bdo",
  "cite",
  "code",
  "data",
  "dfn",
  "em",
  "i",
  "kbd",
  "mark",
  "q",
  "s",
  "samp",
  "small",
  "span",
  "strong",
  "sub",
  "sup",
  "time",
  "u",
  "var",
]);

/**
 * The two ends of a boundary are judged by **different** character sets,
 * because English punctuation is not symmetric.
 *
 * The left end asks "does a space belong after this character?" — true of any
 * word character, and equally true of sentence punctuation. Nothing in English
 * writes `step;Escape` or `first,second`. The right end asks "does a space
 * belong before this character?" — true of word characters only, because
 * closing punctuation is *supposed* to touch what it follows.
 *
 * The asymmetry is what lets all three of these through untouched while still
 * catching the reflow:
 *
 *     a value (<code>x</code>)   `(` opens, so nothing belongs after it
 *     <em>terms</em>.            `.` closes, so nothing belongs before it
 *     finished step;<kbd>Esc</kbd>   ← a finding, and a symmetric rule missed it
 *
 * That third one is not hypothetical: it is what an injected Prettier reflow
 * produced on `help/page.tsx`, and the first version of this module read it as
 * clean because `;` was punctuation on one side. Opening punctuation (`(`, `[`,
 * `“`, `/`, `—`) is deliberately absent from the left set for the same reason
 * it belongs in neither: a space after it would be the bug.
 *
 * Closing brackets are in the left set on the same argument as `;`. It is the
 * other half of the pair already there — `(` opens and takes nothing after it,
 * `)` closes and takes a space — and it is what turns
 * `<strong>Download my data (.zip)</strong>builds` into a finding. Both were
 * added after measuring: neither produces a single new result on the real tree,
 * so the recall is free.
 *
 * Unicode-aware because the UI copy is not ASCII — `£`, `—` and `’` all appear
 * next to inline elements in the legal pages, and a `[A-Za-z0-9]` test would
 * read `’` as a word boundary.
 */
const NEEDS_SPACE_AFTER = /[\p{L}\p{N}.,;:!?)\]]/u;
const NEEDS_SPACE_BEFORE = /[\p{L}\p{N}]/u;

/** One weld. `rendered` is the two words as the browser paints them. */
export interface WeldFinding {
  /** 1-based line carrying the boundary's last visible character — the line
   *  `{" "}` gets appended to. */
  line: number;
  /** The welded pair, e.g. `"PressN"`. Doubles as the allowlist key's second
   *  half, so it carries no line number. */
  rendered: string;
  /** What to do about it, in the message the failing test prints. */
  reason: string;
}

/**
 * JSX's whitespace cleaning for one text child, as the compilers implement it.
 *
 * Split on newlines; drop leading spaces on every line but the first and
 * trailing spaces on every line but the last; drop the lines that are then
 * empty; join the rest with a single space. Tabs count as spaces.
 *
 * The two edges are the whole point. `"\n  Press\n  "` cleans to `"Press"` with
 * no trailing space, because the last line is whitespace-only and disappears
 * entirely — that is the weld. `"\n  Press "` cleans to `"Press "`, because the
 * space is on the *last* line and last-line trailing space is kept.
 *
 * Exported so the rule can be pinned directly by test rather than only through
 * its consequences.
 */
export function renderJsxText(raw: string): string {
  const lines = raw.split(/\r\n|\n|\r/);
  let lastNonEmpty = 0;
  for (let i = 0; i < lines.length; i++) {
    if (/[^ \t]/.test(lines[i])) lastNonEmpty = i;
  }
  let out = "";
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i].replace(/\t/g, " ");
    if (i !== 0) line = line.replace(/^ +/, "");
    if (i !== lines.length - 1) line = line.replace(/ +$/, "");
    if (!line) continue;
    // Every surviving line but the last gets the joining space. The last one
    // must not, or `"\n  Press\n  "` would clean to `"Press "` and the entire
    // defect class would be invisible.
    out += i === lastNonEmpty ? line : `${line} `;
  }
  return out;
}

/**
 * What a JSX child contributes at a boundary.
 *
 * `unknown` is the safe verdict and the common one — a component, a `{expr}`, a
 * block element. It stops the boundary being judged rather than being judged
 * permissively, because a guard that guesses is a guard that gets relaxed.
 */
type Contribution =
  | { kind: "text"; leading: string; trailing: string }
  | { kind: "inline"; leading: string; trailing: string }
  | { kind: "unknown" }
  /** Renders nothing at all: whitespace-only text, a comment, `{/* … *\/}`. */
  | { kind: "empty" };

/**
 * A contribution that actually reaches a boundary.
 *
 * Everything that renders nothing is dropped before any boundary is judged, so
 * the `empty` arm is unreachable from there. Naming that as a type is what lets
 * the reads of `.trailing` and `.leading` stay unguarded.
 */
type Edge = Exclude<Contribution, { kind: "empty" }>;

function tagNameOf(
  node: ts.JsxElement | ts.JsxSelfClosingElement,
): string | null {
  const tag = ts.isJsxElement(node)
    ? node.openingElement.tagName
    : node.tagName;
  return ts.isIdentifier(tag) ? tag.text : null;
}

/** The literal string an expression container renders, or null if it is
 *  dynamic. `{" "}` is the repo's spacing idiom, so reading it is mandatory. */
function literalOfExpression(node: ts.JsxExpression): string | null {
  const expression = node.expression;
  if (!expression) return null; // `{}` and `{/* comment */}`
  if (ts.isStringLiteral(expression)) return expression.text;
  if (ts.isNoSubstitutionTemplateLiteral(expression)) return expression.text;
  return null;
}

function contributionOf(child: ts.JsxChild): Contribution {
  if (ts.isJsxText(child)) {
    const rendered = renderJsxText(child.text);
    return rendered
      ? { kind: "text", leading: rendered[0], trailing: rendered.at(-1)! }
      : { kind: "empty" };
  }

  if (ts.isJsxExpression(child)) {
    const literal = literalOfExpression(child);
    if (literal === null) return { kind: "unknown" };
    return literal
      ? { kind: "text", leading: literal[0], trailing: literal.at(-1)! }
      : { kind: "empty" };
  }

  if (ts.isJsxSelfClosingElement(child)) {
    // `<br />` breaks the line, `<Icon />` is a component, `<span />` renders
    // nothing. None of them can weld, and none is worth distinguishing.
    return { kind: "unknown" };
  }

  if (ts.isJsxFragment(child)) {
    // A fragment is transparent, so its edges are its children's edges — and it
    // is genuinely used to group inline runs.
    return innerEdges(child.children, "inline");
  }

  if (ts.isJsxElement(child)) {
    const tag = tagNameOf(child);
    if (tag === null || !INLINE_TAGS.has(tag)) return { kind: "unknown" };
    return innerEdges(child.children, "inline");
  }

  return { kind: "unknown" };
}

/**
 * The first and last rendered characters inside a run of children.
 *
 * Recursive, because the character at the edge is routinely a level or two
 * down: `<span><strong>N</strong></span>` welds on the `N`. An `unknown` child
 * at either edge makes that edge unknown — the element might render anything
 * there — which is why this returns a whole {@link Contribution} rather than a
 * pair of strings.
 */
function innerEdges(
  children: readonly ts.JsxChild[],
  kind: "inline",
): Contribution {
  const contributions = children.map(contributionOf);
  const visible = contributions.filter((c) => c.kind !== "empty");
  if (visible.length === 0) return { kind: "unknown" };
  const first = visible[0];
  const last = visible.at(-1)!;
  if (first.kind === "unknown" || last.kind === "unknown") {
    return { kind: "unknown" };
  }
  return { kind, leading: first.leading, trailing: last.trailing };
}

/** 1-based line of the last non-whitespace character at or before `end`. */
function lineOfLastVisible(
  sourceFile: ts.SourceFile,
  source: string,
  end: number,
): number {
  const visible = source.slice(0, end).replace(/\s+$/, "");
  const position = Math.max(0, visible.length - 1);
  return sourceFile.getLineAndCharacterOfPosition(position).line + 1;
}

/**
 * Every boundary in `source` where literal text runs straight into the literal
 * text of an inline element, with no space between them.
 *
 * Only **text-to-inline-element** boundaries are judged, in either direction.
 * The three other shapes are out of scope on purpose:
 *
 *  * **element-to-element** — `<a>Privacy</a><a>Terms</a>` has no whitespace to
 *    lose and is routinely spaced by CSS `gap`. This is the false positive that
 *    a rendered-text scan of `/help` produced, and the only one it produced.
 *  * **text-to-`{expr}`** — `12{unit}` is deliberate as often as not.
 *  * **anything touching a component** — its rendered text is not in this file.
 *
 * `fileName` only selects TypeScript's syntax dialect (`.ts` has no JSX, and
 * `<T,>(x) => x` there is a type parameter list), so pass the real path.
 */
export function findTextWelds(
  source: string,
  fileName = "input.tsx",
): WeldFinding[] {
  const sourceFile = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
    fileName.endsWith(".ts") || fileName.endsWith(".mts")
      ? ts.ScriptKind.TS
      : ts.ScriptKind.TSX,
  );

  const findings: WeldFinding[] = [];

  const inspect = (children: readonly ts.JsxChild[]): void => {
    // Children that render nothing are dropped first, so that the two things
    // either side of a whitespace-only line really are neighbours. Keeping the
    // node alongside its contribution is what lets the finding point at a line.
    //
    // The predicate is a type guard rather than a plain comparison: `.filter()`
    // does not narrow a union on its own, and without it every later read of
    // `.trailing` has to be told the `empty` arm is gone. Saying it once here is
    // both shorter and the only place the claim is actually true.
    const significant = children
      .map((child) => ({ child, contribution: contributionOf(child) }))
      .filter(
        (entry): entry is { child: ts.JsxChild; contribution: Edge } =>
          entry.contribution.kind !== "empty",
      );

    for (let i = 0; i + 1 < significant.length; i++) {
      const left = significant[i];
      const right = significant[i + 1];
      const a = left.contribution;
      const b = right.contribution;
      if (a.kind === "unknown" || b.kind === "unknown") continue;
      // Exactly one side must be the inline element; text-to-text cannot weld
      // (adjacent JSXText children do not occur) and element-to-element is out
      // of scope, per the note above.
      if ((a.kind === "inline") === (b.kind === "inline")) continue;
      if (!NEEDS_SPACE_AFTER.test(a.trailing)) continue;
      if (!NEEDS_SPACE_BEFORE.test(b.leading)) continue;

      const rendered = `${lastWord(a.trailing, left.child)}${firstWord(
        b.leading,
        right.child,
      )}`;
      findings.push({
        line: lineOfLastVisible(sourceFile, source, left.child.getEnd()),
        rendered,
        reason: `renders as the single word \`${rendered}\`; JSX drops the newline next to a tag, so add an explicit {" "} at the boundary`,
      });
    }
  };

  const visit = (node: ts.Node): void => {
    if (ts.isJsxElement(node)) inspect(node.children);
    else if (ts.isJsxFragment(node)) inspect(node.children);
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(sourceFile, visit);

  return findings;
}

/**
 * The whole word each side contributes, for a message a reader can search for.
 *
 * `"PressN"` is findable in the source; `"sN"` — which the boundary characters
 * alone would give — is not, and the allowlist keys off this string.
 */
function lastWord(trailing: string, node: ts.JsxChild): string {
  const text = flattenLiteralText(node);
  // The trailing sentence punctuation is part of what a reader searches for:
  // the defect reads `step;Escape`, and `stepEscape` is not in the file.
  const match = /[\p{L}\p{N}][\p{L}\p{N}\p{Pd}'’]*[.,;:!?)\]]*$/u.exec(text);
  return match ? match[0] : trailing;
}

function firstWord(leading: string, node: ts.JsxChild): string {
  const text = flattenLiteralText(node);
  const match = /^[\p{L}\p{N}][\p{L}\p{N}\p{Pd}'’]*/u.exec(text);
  return match ? match[0] : leading;
}

/** The rendered text of a child, as far as it is literal. */
function flattenLiteralText(node: ts.JsxChild): string {
  if (ts.isJsxText(node)) return renderJsxText(node.text);
  if (ts.isJsxExpression(node)) return literalOfExpression(node) ?? "";
  if (ts.isJsxElement(node) || ts.isJsxFragment(node)) {
    return node.children.map(flattenLiteralText).join("");
  }
  return "";
}
