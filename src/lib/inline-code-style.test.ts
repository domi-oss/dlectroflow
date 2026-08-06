import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import {
  INLINE_CODE_TAGS,
  findCssRule,
  findInlineCodeSizeOverrides,
} from "@/lib/inline-code-style";

/**
 * #182 — the inline-code treatment lives in one base rule, and stays there.
 *
 * The owner reported "words too close together" on `/help`. The page has no
 * missing spaces; its three `<kbd>` elements carried no class, and nothing in
 * `globals.css` styled `code` or `kbd`, so Tailwind's preflight left them as
 * bare mono glyphs at the size of the prose around them.
 *
 * What made it survive so long is worth pinning, because it is the part that
 * repeats: ten of the twenty sites *were* styled, with a `className="text-xs"`
 * copied from site to site down `privacy/page.tsx`. That reads as a convention
 * when you are looking at one of them, so nobody saw a gap — but it only set
 * the size, never the separation, and the other ten did not have it. A per-site
 * utility cannot be audited from any single site.
 *
 * ── If this fails ──────────────────────────────────────────────────────────
 * Either the base rule was deleted (every page still renders, just badly, which
 * is why nothing else would notice) or an element re-sized itself out from
 * under it. Fix the drift; do not relax the test.
 */

const GLOBALS = "src/app/globals.css";

// `src/` only, non-test. A test may legitimately assert on the classes this
// module bans — the same exclusion `a11y-class-hygiene.test.ts` makes, and for
// the same reason.
const SCANNED_ROOT = "src";

function scannedFiles(): string[] {
  return readdirSync(SCANNED_ROOT, { recursive: true, encoding: "utf8" })
    .filter((entry) => /\.tsx$/.test(entry) && !/\.test\.tsx$/.test(entry))
    .map((entry) => path.join(SCANNED_ROOT, entry));
}

/**
 * Files that contain one of these elements at all — the denominator that makes
 * the "no size overrides" zero mean something.
 *
 * Hardcoded rather than interpolated from {@link INLINE_CODE_TAGS}, which is
 * the more obvious way to write it. Building a `RegExp` from a template literal
 * trips semgrep's `javascript-regex-non-literal` (ReDoS), and this repo's
 * settled answer to that rule is to hardcode rather than dismiss —
 * `a11y-class-hygiene.ts` made exactly this change for exactly this reason, and
 * records why: a dismissal has to be re-argued every time a repo-wide reformat
 * re-fingerprints the finding. This one was reported on pipeline iid 1843 and
 * fixed rather than triaged.
 *
 * The cost is that this can drift from the exported list, so the test below
 * asserts it does not.
 */
const INLINE_CODE_ELEMENT = /<(?:code|kbd|samp)[ >]/;

describe("findInlineCodeSizeOverrides", () => {
  // ── Prove the detector fires ────────────────────────────────────────────
  it("flags the ad-hoc text-xs this issue removed", () => {
    const source = `export const A = () => (
  <p>
    the scope is <code className="text-xs">read_user</code>
  </p>
);`;
    expect(findInlineCodeSizeOverrides(source)).toEqual([
      { line: 3, tag: "code", token: "text-xs" },
    ]);
  });

  it("flags a size hidden behind a variant or an arbitrary value", () => {
    const source = `export const A = () => (
  <>
    <kbd className="font-bold sm:text-lg">N</kbd>
    <samp className="text-[13px]">out</samp>
  </>
);`;
    expect(findInlineCodeSizeOverrides(source).map((o) => o.token)).toEqual([
      "sm:text-lg",
      "text-[13px]",
    ]);
  });

  it("flags a size reached through cn() or a ternary arm", () => {
    const source = `export const A = () => (
  <code className={cn("break-all", wide ? "text-sm" : "font-medium")}>x</code>
);`;
    expect(findInlineCodeSizeOverrides(source).map((o) => o.token)).toEqual([
      "text-sm",
    ]);
  });

  // ── Precision ───────────────────────────────────────────────────────────
  it("leaves non-size utilities alone", () => {
    // These compose with the chip rather than replacing part of it. `break-all`
    // is load-bearing on privacy/page.tsx's one long opaque identifier.
    const source = `export const A = () => (
  <code className="break-all font-medium text-muted-foreground">x</code>
);`;
    expect(findInlineCodeSizeOverrides(source)).toEqual([]);
  });

  it("does not read a comment as markup", () => {
    // calendar-feed.tsx:41 says "not a `<code>` block" in a doc comment, and
    // globals.css names <kbd> in prose. A regex reports both; this repo has
    // twice shipped a tool that read a comment as code.
    const source = `/** Not a <code className="text-xs"> block — a real input. */
export const A = () => <input readOnly />;`;
    expect(findInlineCodeSizeOverrides(source)).toEqual([]);
  });

  it("ignores tags outside the inline-code family", () => {
    const source = `export const A = () => <span className="text-xs">x</span>;`;
    expect(findInlineCodeSizeOverrides(source)).toEqual([]);
  });

  it("does not read an element's own text as a class token", () => {
    // The same comment-versus-code trap as the case above, one level along:
    // this is rendered text, not a utility. `className` accepts an element as
    // its value at the *syntax* level — `JsxAttributeValue` includes
    // `JsxElement` — so this parses with zero diagnostics and walks a `JsxText`
    // straight into the collector, which is why the collector must not treat
    // one as class tokens. React would set the class to `[object Object]`.
    //
    // Reported on !272 as dead code on the grounds that a `JsxText` can never
    // reach an attribute initializer. It can; the arm was wrong for the other
    // reason, and this pins the behaviour rather than the reachability.
    const source = `export const A = () => <code className={<span>text-xs</span>}>x</code>;`;
    expect(findInlineCodeSizeOverrides(source)).toEqual([]);
  });
});

describe("findCssRule", () => {
  it("reads a rule's declarations", () => {
    const css = `a, b { color: red; font-size: 0.875em }`;
    expect(findCssRule(css, ["a", "b"])).toEqual({
      color: "red",
      "font-size": "0.875em",
    });
  });

  it("does not match a rule described in a comment", () => {
    const css = `/* code, kbd, samp { font-size: 0.875em } */ p { color: red }`;
    expect(findCssRule(css, ["code", "kbd", "samp"])).toBeNull();
  });

  it("returns null when the selector list differs", () => {
    expect(findCssRule(`code, kbd { color: red }`, ["code"])).toBeNull();
  });

  it("merges every block with that selector, later winning", () => {
    // `globals.css` has three separate `:root` rules. Reading only the first
    // reports the palette's declarations as the whole answer, which is what
    // made the `--code-surface` assertion below read `undefined`.
    const css = `:root { --a: 1; --b: 2 } p { color: red } :root { --b: 3; --c: 4 }`;
    expect(findCssRule(css, [":root"])).toEqual({
      "--a": "1",
      "--b": "3",
      "--c": "4",
    });
  });
});

describe("the real tree", () => {
  it("declares the inline-code base rule", () => {
    const rule = findCssRule(
      readFileSync(GLOBALS, "utf8"),
      INLINE_CODE_TAGS as unknown as string[],
    );
    expect(rule).not.toBeNull();

    // The four properties that make it a chip rather than bare glyphs. Deleting
    // any one of them reproduces part of the reported defect: no size means it
    // matches the prose, no padding means it touches the words either side, no
    // background means there is nothing to see, and no colour means the chip's
    // own surface is never guaranteed to pair with its text.
    expect(rule!["font-size"]).toBe("0.875em");
    expect(rule!["padding-inline"]).toBeDefined();
    expect(rule!["background-color"]).toBe("var(--code-surface)");
    expect(rule!["color"]).toBe("var(--foreground)");

    // Relative, not absolute. The whole reason the per-site `text-xs` was wrong.
    expect(rule!["font-size"]).toMatch(/em$/);
  });

  /**
   * The chip's colours stay precomputed, and this is the assertion that keeps
   * them that way.
   *
   * They were originally `color-mix(in oklab, var(--foreground) 10%,
   * var(--muted))`, which reads far better and is the obvious way to express
   * "blend these two". It shipped a hazard. Lightning CSS cannot evaluate a mix
   * of two custom properties at build time, so it emits a fallback for engines
   * that would drop the declaration — and it picks the first colour, neat. The
   * CSS the review app actually served contained:
   *
   *     code,kbd,samp{…;background-color:var(--foreground);…}
   *     code,kbd,samp{background-color:color-mix(in oklab,…)}
   *
   * With `color: var(--foreground)` also set, the fallback is 1:1 — text that is
   * not low-contrast but invisible. It is below this app's browser floor and so
   * should never be reached; a fallback that fails *that* way is still not one
   * to keep, and nothing in the source hinted at it. It was found by reading the
   * built stylesheet, which is the only place it exists.
   *
   * So: no `color-mix` in the chip's own declarations. Anywhere else in the
   * file is fine — Tailwind compiles every opacity modifier to one.
   */
  it("keeps the chip's colours out of a build-time fallback", () => {
    const css = readFileSync(GLOBALS, "utf8");
    for (const selectors of [
      INLINE_CODE_TAGS as unknown as string[],
      ["kbd"],
    ]) {
      const rule = findCssRule(css, selectors);
      expect(rule).not.toBeNull();
      expect(Object.values(rule!).join(" ")).not.toContain("color-mix");
    }

    // And the tokens the rule points at are defined for BOTH themes. A missing
    // `.dark` value is the failure this replaced: the light chip is a dark tint
    // on a light surface, so inheriting it into dark mode is unreadable.
    for (const token of ["--code-surface", "--code-edge"]) {
      expect(findCssRule(css, [":root"])![token]).toMatch(/^oklch\(/);
      expect(findCssRule(css, [".dark"])![token]).toMatch(/^oklch\(/);
    }
  });

  it("does not let a code block wear the chip", () => {
    // Leaving `pre` out of the base rule's selector list is not by itself an
    // exclusion. `code` reaches the `<code>` inside a `<pre>` — the standard
    // block shape — so a code block added tomorrow would arrive wearing an
    // oversized inline chip: background, padding, radius and a shrunk size.
    // There is no `<pre>` in the tree, so the reset paints nothing today, which
    // is exactly why it needs a test: deleting it would be silent right up
    // until the first code block. Reported on !272.
    const rule = findCssRule(readFileSync(GLOBALS, "utf8"), [
      "pre code",
      "pre kbd",
      "pre samp",
    ]);
    expect(rule).not.toBeNull();
    expect(rule!["background-color"]).toBe("transparent");
    expect(rule!["font-size"]).toBe("inherit");
    expect(rule!["padding"]).toBe("0");
    expect(rule!["box-shadow"]).toBe("none");
  });

  it("gives kbd its keycap edge without changing the line box", () => {
    const rule = findCssRule(readFileSync(GLOBALS, "utf8"), ["kbd"]);
    expect(rule).not.toBeNull();
    // An inset shadow, not a border: a border adds 2px to an INLINE box and
    // nudges the line it sits on.
    expect(rule!["box-shadow"]).toContain("inset");
    expect(rule!["border-bottom"]).toBeUndefined();
    expect(rule!["border-bottom-width"]).toBeUndefined();
  });

  it("has no element re-sizing itself out from under the base rule", () => {
    const findings = scannedFiles().flatMap((file) =>
      findInlineCodeSizeOverrides(readFileSync(file, "utf8"), file).map(
        (override) =>
          `${file}:${override.line} <${override.tag}> ${override.token}`,
      ),
    );
    expect(findings).toEqual([]);
  });

  it("scans a tree big enough for that zero to mean something", () => {
    // A clean result from a scanner that read nothing is not a clean result.
    // The denominator: the files that actually contain one of these elements.
    const withInlineCode = scannedFiles().filter((file) =>
      INLINE_CODE_ELEMENT.test(readFileSync(file, "utf8")),
    );
    expect(withInlineCode.length).toBeGreaterThanOrEqual(7);
  });

  it("keeps that hardcoded pattern in step with the exported tags", () => {
    // The one thing hardcoding costs is that the two can drift apart, so the
    // drift is what gets asserted. Cheaper than the alternative — see the note
    // on INLINE_CODE_ELEMENT.
    for (const tag of INLINE_CODE_TAGS) {
      expect(INLINE_CODE_ELEMENT.test(`<${tag}>`)).toBe(true);
      expect(INLINE_CODE_ELEMENT.test(`<${tag} className="x">`)).toBe(true);
    }
    expect(INLINE_CODE_ELEMENT.test("<span>")).toBe(false);
    // Not a prefix match: <codex> is not <code>.
    expect(INLINE_CODE_ELEMENT.test("<codex>")).toBe(false);
  });
});
