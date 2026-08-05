import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { findTextWelds, renderJsxText } from "@/lib/jsx-text-weld";

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
// Empty today: every boundary in the tree either has its space or was fixed.
const REVIEWED_WELDS: Record<string, string> = {};

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

  // ── Precision: the shapes that must NOT fire ────────────────────────────

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
   * The sensitivity number, measured rather than asserted.
   *
   * The assertion below this one is expected to pass with zero findings, and a
   * passing zero is worth exactly as much as the evidence that the same scanner
   * can return non-zero. So: take every real source that has a space before an
   * inline tag, delete that one space and push the tag onto its own line — the
   * precise edit Prettier's reflow makes — and require the detector to notice.
   *
   * 50 of 55 injected welds are caught at the time of writing. All five misses
   * are the module's two documented limitations, and all five were inspected:
   *
   *  * three are `<strong>{EXPR}</strong>` / `<code>{EXPR}</code>`, where the
   *    element's leading character is dynamic (privacy 897, terms 130,
   *    account-panel 197) — limitation 2, literal text only;
   *  * one is `<kbd>/</kbd>`, whose content is punctuation, so `or` and `/`
   *    touching is not a word-on-word weld;
   *  * one is inside a JSX **comment** in `celebration.tsx`, which the AST
   *    correctly refuses to read as markup. A regex would have flagged it, and
   *    this repo has twice shipped a tool that read a comment as code.
   *
   * The floor is 0.85 rather than the measured 0.909 so that ordinary copy
   * edits, which change the mix of literal and dynamic elements, do not fail
   * the suite. A drop past it means the parser regressed.
   */
  const INJECTABLE =
    /([\p{L}\p{N}]) (<(?:strong|em|kbd|code|span|a|b|i|small|abbr)\b)/gu;

  it("catches the welds it claims to catch, on real sources", () => {
    let injected = 0;
    let caught = 0;
    for (const file of scannedFiles()) {
      const source = readFileSync(file, "utf8");
      const before = findTextWelds(source, file).length;
      for (const match of source.matchAll(INJECTABLE)) {
        const cut = match.index + match[0].length - match[2].length;
        const mutant = `${source.slice(0, match.index)}${match[1]}\n${source.slice(cut)}`;
        injected++;
        if (findTextWelds(mutant, file).length > before) caught++;
      }
    }
    // Both halves matter: a high ratio over two mutants would mean nothing.
    expect(injected).toBeGreaterThan(30);
    expect(caught / injected).toBeGreaterThanOrEqual(0.85);
  });

  it("has no unreviewed welds", () => {
    const unreviewed = findings.filter(
      (finding) => !(`${finding.file}:${finding.rendered}` in REVIEWED_WELDS),
    );
    expect(
      unreviewed.map(
        (finding) =>
          `${finding.file}:${finding.line} renders "${finding.rendered}" as one word — insert {" "}`,
      ),
    ).toEqual([]);
  });

  it("has no stale allowlist entries", () => {
    const live = new Set(
      findings.map((finding) => `${finding.file}:${finding.rendered}`),
    );
    expect(Object.keys(REVIEWED_WELDS).filter((key) => !live.has(key))).toEqual(
      [],
    );
  });
});
