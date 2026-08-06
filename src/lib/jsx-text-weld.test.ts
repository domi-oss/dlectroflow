import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import {
  findTextWelds,
  renderJsxText,
  reviewWelds,
  type LocatedWeld,
  type ReviewedWeld,
} from "@/lib/jsx-text-weld";

/**
 * #182 — the JSX rule that welds two words into one.
 *
 * JSX does not preserve the whitespace you see in the source. A JSXText child is
 * split on newlines, every line is trimmed, empty lines are dropped and the rest
 * are joined with a single space. The consequence that keeps biting:
 *
 *     Press            →  "PressN"      the newline before <kbd> is GONE
 *     <kbd>N</kbd>
 *
 *     Press <kbd>N</kbd>  →  "Press N"   a space that survives, because it is
 *                                        not adjacent to the newline
 *
 * Prettier reflows JSX to `printWidth: 80`, so **the weld appears when a line
 * grows**, not when anybody writes one. Nothing in the toolchain sees it: it is
 * valid JSX, valid TypeScript, correctly formatted, and axe has no rule for
 * "these two words are one word". It reached `main` three times in a single day
 * (#182's description has the inventory) before anyone read the rendered text.
 *
 * Kept free of `fs` so the parser is unit-testable on synthetic sources — the
 * shape `a11y-class-hygiene`, `fetch-host-hygiene` and `ci-docs-only` all use;
 * this file reads the real tree.
 *
 * ── If this fails ──────────────────────────────────────────────────────────
 * Two words are rendering as one. Insert `{" "}` at the boundary the finding
 * names. Do not add an allowlist entry unless the weld is intentional (a unit
 * suffix, a currency symbol), and say which in the reason.
 */

// ── Reviewed welds ─────────────────────────────────────────────────────────
//
// Boundaries where text really should touch the inline element next to it —
// `12<abbr>kg</abbr>`, `<code>--flag</code>=value`. Keyed by `<file>:<text>` so
// the map does not rot when a component moves, the same contract
// `REVIEWED_TEXT_COLORS` carries in `a11y-class-hygiene.test.ts`.
//
// Each entry states **how many** boundaries in that file render that string,
// because the key carries no line number and therefore names a class of
// boundary rather than one of them. See {@link ReviewedWeld} for why presence
// alone is not enough.
//
// Empty today: every boundary in the tree either has its space or was fixed.
const REVIEWED_WELDS: Record<string, ReviewedWeld> = {};

// `src/` only, and not the test files. A test that asserts a weld is GONE has to
// be able to name it — `help-page.test.tsx` renders the very strings this module
// looks for. `e2e/` is excluded for the same reason.
const SCANNED_ROOT = "src";

function scannedFiles(): string[] {
  const entries = readdirSync(SCANNED_ROOT, {
    recursive: true,
    encoding: "utf8",
  });
  return entries
    .filter((entry) => /\.tsx$/.test(entry) && !/\.test\.tsx$/.test(entry))
    .map((entry) => path.join(SCANNED_ROOT, entry));
}

describe("renderJsxText", () => {
  // The cleaning rule, pinned directly. Every finding this module makes depends
  // on getting these five cases right, and they are the ones people get wrong.
  it("drops a newline that is adjacent to a tag", () => {
    expect(renderJsxText("\n            Press\n            ")).toBe("Press");
  });

  it("keeps a space that is not adjacent to a newline", () => {
    expect(renderJsxText("\n            Press ")).toBe("Press ");
  });

  it("joins two prose lines with exactly one space", () => {
    expect(renderJsxText("\n  one\n  two\n")).toBe("one two");
  });

  it("collapses a run of spaces at a line end into the joining space", () => {
    expect(renderJsxText("\n  one    \n  two\n")).toBe("one two");
  });

  it("preserves a single-line text verbatim, both edges", () => {
    expect(renderJsxText(" a b ")).toBe(" a b ");
  });
});

describe("findTextWelds", () => {
  // ── Prove the detector fires ────────────────────────────────────────────
  //
  // A scanner that has never been seen to fire is not evidence of a clean tree.
  // These fixtures are the shapes that actually shipped.

  it("flags prose ending a line immediately before an inline tag", () => {
    const source = `export const A = () => (
  <p>
    Press
    <kbd>N</kbd>
  </p>
);`;
    const findings = findTextWelds(source);
    expect(findings).toHaveLength(1);
    expect(findings[0].rendered).toBe("PressN");
    // Line 3, not 4: the line `{" "}` gets appended to is the one carrying the
    // boundary's last visible character, which is where the fix is typed.
    expect(findings[0].line).toBe(3);
  });

  it("flags a closing inline tag immediately before prose", () => {
    const source = `export const A = () => (
  <p>
    <kbd>N</kbd>
    starts a new task
  </p>
);`;
    const findings = findTextWelds(source);
    expect(findings).toHaveLength(1);
    expect(findings[0].rendered).toBe("Nstarts");
  });

  it("flags both edges of an inline element the reflow stranded", () => {
    const source = `export const A = () => (
  <p>
    hold
    <kbd>Shift</kbd>
    and drag
  </p>
);`;
    expect(findTextWelds(source).map((f) => f.rendered)).toEqual([
      "holdShift",
      "Shiftand",
    ]);
  });

  it('accepts an explicit {" "} on either side', () => {
    const source = `export const A = () => (
  <p>
    Press{" "}
    <kbd>N</kbd>{" "}
    now
  </p>
);`;
    expect(findTextWelds(source)).toEqual([]);
  });

  it("accepts a space that survives the line trim", () => {
    const source = `export const A = () => (
  <p>
    Press <kbd>N</kbd> now
  </p>
);`;
    expect(findTextWelds(source)).toEqual([]);
  });

  it("flags sentence punctuation running into an inline element", () => {
    // The shape a symmetric "both sides must be word characters" rule missed.
    // Found by injecting a real Prettier reflow into help/page.tsx and watching
    // the rendered-text test in help.test.tsx fail while this module said clean.
    // English never writes `step;Escape`.
    const source = `export const A = () => (
  <p>
    stay on the finished step;
    <kbd>Escape</kbd>
    stops it too
  </p>
);`;
    expect(findTextWelds(source).map((f) => f.rendered)).toEqual([
      "step;Escape",
      "Escapestops",
    ]);
  });

  // ── Things that render nothing must not hide the weld behind them ───────
  //
  // Every one of these sits *between* the two words and contributes no glyph,
  // so the words either side really are neighbours. Reading one as "I cannot
  // tell" suppresses the boundary on both sides of it — a false negative in the
  // shape most likely to occur, because a JSX comment is how a reflow gets
  // pinned in the first place. Duo review on !272 caught all three.

  it("does not let a JSX comment hide the weld beside it", () => {
    // `{/* … */}` is the idiom for stopping Prettier joining two lines, so it
    // lands in exactly the place the reflow weld appears.
    const source = `export const A = () => (
  <p>
    Press{/* keep the tag on its own line */}
    <kbd>N</kbd>
  </p>
);`;
    expect(findTextWelds(source).map((f) => f.rendered)).toEqual(["PressN"]);
  });

  it("does not let an empty expression container hide the weld beside it", () => {
    const source = `export const A = () => (
  <p>
    Press{}
    <kbd>N</kbd>
  </p>
);`;
    expect(findTextWelds(source).map((f) => f.rendered)).toEqual(["PressN"]);
  });

  it("sees through a bare inline element with nothing in it", () => {
    const source = `export const A = () => (
  <p>
    Press<span></span>
    <kbd>N</kbd>
  </p>
);`;
    expect(findTextWelds(source).map((f) => f.rendered)).toEqual(["PressN"]);
  });

  it("sees through a bare inline element holding only a comment", () => {
    const source = `export const A = () => (
  <p>
    Press<span>{/* nothing here */}</span>
    <kbd>N</kbd>
  </p>
);`;
    expect(findTextWelds(source).map((f) => f.rendered)).toEqual(["PressN"]);
  });

  it("sees through an empty fragment", () => {
    // A fragment has no box to style, so unlike an element there is no case in
    // which an empty one occupies space.
    const source = `export const A = () => (
  <p>
    Press<></>
    <kbd>N</kbd>
  </p>
);`;
    expect(findTextWelds(source).map((f) => f.rendered)).toEqual(["PressN"]);
  });

  // ── Precision: the shapes that must NOT fire ────────────────────────────

  it("does not see through a contentless element that carries attributes", () => {
    // The counter-example to the four above, and it is measured rather than
    // imagined: `<span className="flex-1" />` is this tree's spacer idiom (five
    // of them) and `<span aria-hidden className="h-1.5 w-1.5 rounded-full" />`
    // its current-page marker. Contentless, and both occupy real width. The
    // long-hand spelling renders identically, so an attribute is the line
    // between "renders nothing" and "renders no *text*" — only the bare form is
    // transparent. Reported as a plain false negative on !272; the fix is
    // narrower than the report, because the wide version welds the words either
    // side of a visible gap.
    const source = `export const A = () => (
  <p>
    Press<span className="flex-1"></span>
    <kbd>N</kbd>
  </p>
);`;
    expect(findTextWelds(source)).toEqual([]);
  });

  it("does not flag punctuation before an inline element", () => {
    // `(<code>x</code>)` is correct English, not a weld.
    const source = `export const A = () => (
  <p>
    a value (
    <code>x</code>
    ), and more prose
  </p>
);`;
    expect(findTextWelds(source)).toEqual([]);
  });

  it("does not flag punctuation after an inline element", () => {
    const source = `export const A = () => (
  <p>
    read the <em>terms</em>
    .
  </p>
);`;
    expect(findTextWelds(source)).toEqual([]);
  });

  it("does not flag a block-level neighbour", () => {
    // A <div> or <li> starts its own line box, so nothing can weld to it.
    const source = `export const A = () => (
  <div>
    heading
    <div>body</div>
  </div>
);`;
    expect(findTextWelds(source)).toEqual([]);
  });

  it("does not flag two adjacent inline elements", () => {
    // The legal footer's three links sit apart on CSS `gap` with no whitespace
    // between them in the DOM. Reading that as a weld is the false positive
    // that produced this module's first wrong answer, so it is pinned.
    const source = `export const A = () => (
  <nav className="flex gap-4">
    <a href="/privacy">Privacy</a>
    <a href="/terms">Terms</a>
  </nav>
);`;
    expect(findTextWelds(source)).toEqual([]);
  });

  it("does not flag a component or a dynamic expression", () => {
    // `{count}` next to a word is routinely deliberate, and a capitalised tag
    // renders whatever it likes. Neither is a claim this module can make.
    const source = `export const A = () => (
  <p>
    step
    {count}
    of
    <StepBadge />
  </p>
);`;
    expect(findTextWelds(source)).toEqual([]);
  });

  it("does not flag an inline element whose own text starts with a space", () => {
    const source = `export const A = () => (
  <p>
    Press
    <kbd> N</kbd>
  </p>
);`;
    expect(findTextWelds(source)).toEqual([]);
  });

  it("sees through a nested inline element to the character at the edge", () => {
    const source = `export const A = () => (
  <p>
    Press
    <span>
      <strong>N</strong>
    </span>
  </p>
);`;
    expect(findTextWelds(source).map((f) => f.rendered)).toEqual(["PressN"]);
  });

  it("reads the file's own name for the JSX dialect", () => {
    // A `.ts` file has no JSX, and `<T>(x)` there is a type assertion. Passing
    // the real path is what keeps the parser from reading one as the other.
    expect(findTextWelds("const f = <T,>(x: T) => x;\n", "a.ts")).toEqual([]);
  });
});

describe("the real tree", () => {
  const findings = scannedFiles().flatMap((file) =>
    findTextWelds(readFileSync(file, "utf8"), file).map((finding) => ({
      ...finding,
      file,
    })),
  );

  it("scans a tree big enough for the result to mean something", () => {
    // A zero from a scanner that read nothing is not a clean bill of health.
    // JSX only compiles in `.tsx`, so this is the whole population.
    expect(scannedFiles().length).toBeGreaterThan(50);
  });

  /**
   * The sensitivity number, measured in CI rather than asserted in a comment.
   *
   * The assertion below this one is expected to pass with **zero** findings, and
   * a passing zero is worth exactly as much as the evidence that the same
   * scanner can return non-zero. So: take every real source that has a space
   * between prose and an inline tag, delete that one space and push the tag onto
   * its own line — the precise edit Prettier's reflow makes — and require the
   * detector to notice.
   *
   * **181 of 190 injected welds are caught** at the time of writing (61/68
   * before an opening tag, 120/122 after a closing one). Every miss was
   * inspected, and none is a parser bug:
   *
   *  * **five** are `<strong>{EXPR}</strong>` / `<code>{EXPR}</code>`, where the
   *    element's edge character is dynamic — limitation 2, literal text only
   *    (privacy 897, terms 130, account-panel 197, breakdown-model-section 130,
   *    inbox-view 2315);
   *  * **two** are `<kbd>/</kbd>`, whose entire content is punctuation, so `or`
   *    and `/` touching is not a word-on-word weld;
   *  * **one** is inside a JSX **comment** in `celebration.tsx`, and one is a
   *    TypeScript **ternary colon** in `breakdown-chat.tsx` — neither is markup,
   *    so neither mutant is a weld at all. A regex reports both, and this repo
   *    has twice shipped a tool that read a comment as code. Two of the nine
   *    "misses" are therefore the AST being right.
   *
   * The floor is 0.85 rather than the measured 0.953 so that ordinary copy
   * edits, which change the mix of literal and dynamic elements, cannot fail the
   * suite on their own. A drop past it means the parser regressed.
   */
  const INJECTIONS = [
    // Prose, then an inline tag stranded on the next line.
    {
      pattern:
        /([\p{L}\p{N}.,;:!?)\]]) (<(?:strong|em|kbd|code|span|a|b|i|small|abbr)\b)/gu,
      keep: 1,
      drop: 2,
    },
    // A closing tag, then prose stranded on the next line.
    {
      pattern:
        /(<\/(?:strong|em|kbd|code|span|a|b|i|small|abbr)>) ([\p{L}\p{N}])/gu,
      keep: 1,
      drop: 2,
    },
  ];

  it("catches the welds it claims to catch, on real sources", () => {
    let injected = 0;
    let caught = 0;
    for (const file of scannedFiles()) {
      const source = readFileSync(file, "utf8");
      const before = findTextWelds(source, file).length;
      for (const { pattern, keep, drop } of INJECTIONS) {
        for (const match of source.matchAll(pattern)) {
          // Re-join without the single space, with a newline in its place.
          const cut = match.index + match[0].length - match[drop].length;
          const mutant = `${source.slice(0, match.index)}${match[keep]}\n${source.slice(cut)}`;
          injected++;
          if (findTextWelds(mutant, file).length > before) caught++;
        }
      }
    }
    // Both halves matter: a perfect ratio over two mutants would mean nothing.
    expect(injected).toBeGreaterThan(100);
    expect(caught / injected).toBeGreaterThanOrEqual(0.85);
  });

  const review = reviewWelds(findings, REVIEWED_WELDS);

  it("has no unreviewed welds", () => {
    expect(review.unreviewed).toEqual([]);
  });

  it("has no stale allowlist entries", () => {
    expect(review.stale).toEqual([]);
  });
});

describe("reviewWelds", () => {
  // The allowlist arithmetic, exercised on synthetic findings rather than only
  // through a real tree that has none. An allowlist nobody can see fail is the
  // hole this whole gate exists to close.
  const weld = (file: string, rendered: string, line: number): LocatedWeld => ({
    file,
    rendered,
    line,
    reason: "renders as one word",
  });

  it("reports a weld no entry covers", () => {
    expect(reviewWelds([weld("a.tsx", "PressN", 3)], {}).unreviewed).toEqual([
      'a.tsx:3 renders "PressN" as one word — insert {" "}',
    ]);
  });

  it("accepts a weld its entry covers", () => {
    const review = reviewWelds([weld("a.tsx", "12kg", 3)], {
      "a.tsx:12kg": { reason: "a unit suffix", count: 1 },
    });
    expect(review).toEqual({ unreviewed: [], stale: [] });
  });

  it("still reports the second of two welds one entry would have hidden", () => {
    // The finding this replaced the `in` test for. `<file>:<rendered>` names a
    // *class* of boundary, so reviewing one `PressN` in a file used to silently
    // absolve every other `PressN` in it — and the stale check could not see
    // that, because both are live. Duo review, !272.
    const review = reviewWelds(
      [weld("a.tsx", "PressN", 3), weld("a.tsx", "PressN", 40)],
      { "a.tsx:PressN": { reason: "reviewed the one on line 3", count: 1 } },
    );
    expect(review.unreviewed).toEqual([
      'a.tsx:40 renders "PressN" as one word — insert {" "}',
    ]);
    expect(review.stale).toEqual([]);
  });

  it("accepts both when the entry says there are two", () => {
    const review = reviewWelds(
      [weld("a.tsx", "12kg", 3), weld("a.tsx", "12kg", 40)],
      { "a.tsx:12kg": { reason: "both are unit suffixes", count: 2 } },
    );
    expect(review).toEqual({ unreviewed: [], stale: [] });
  });

  it("reports an entry claiming more boundaries than the tree has", () => {
    // The other half: a weld gets fixed, the count is not decremented, and the
    // entry quietly keeps a licence for a boundary that no longer exists.
    const review = reviewWelds([weld("a.tsx", "12kg", 3)], {
      "a.tsx:12kg": { reason: "a unit suffix", count: 2 },
    });
    expect(review.stale).toEqual([
      "a.tsx:12kg — the allowlist claims 2, the tree has 1",
    ]);
  });

  it("reports an entry whose weld is gone entirely", () => {
    expect(
      reviewWelds([], { "a.tsx:12kg": { reason: "a unit suffix", count: 1 } })
        .stale,
    ).toEqual(["a.tsx:12kg — the allowlist claims 1, the tree has 0"]);
  });

  it("reports an entry that licenses nothing", () => {
    // `count: 0` is not a way to keep a note in the map. It reads as reviewed
    // and permits nothing, so it can only ever mislead.
    expect(
      reviewWelds([], { "a.tsx:12kg": { reason: "a unit suffix", count: 0 } })
        .stale,
    ).toEqual(["a.tsx:12kg — the allowlist claims 0, the tree has 0"]);
  });

  it("keeps the two files' entries apart", () => {
    const review = reviewWelds(
      [weld("a.tsx", "12kg", 3), weld("b.tsx", "12kg", 3)],
      { "a.tsx:12kg": { reason: "a unit suffix", count: 1 } },
    );
    expect(review.unreviewed).toEqual([
      'b.tsx:3 renders "12kg" as one word — insert {" "}',
    ]);
    expect(review.stale).toEqual([]);
  });
});
