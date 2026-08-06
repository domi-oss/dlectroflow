/**
 * #182 — inline code and keys get their treatment from one base rule, and only
 * from there.
 *
 * Before this, `code` and `kbd` had no styling at all. Tailwind's preflight
 * gives them the mono face at `font-size: 1em` and stops, so a code token
 * rendered as bare monospace glyphs at the same size as the proportional text
 * around it, with no padding and no edge. That is what the owner reported on
 * `/help` as "words too close together" — not a missing space, an element with
 * nothing on it.
 *
 * The interesting part is how it stayed invisible. Ten of the twenty sites
 * *were* styled, with a hand-written `className="text-xs"` copied from site to
 * site in `privacy/page.tsx`. That looked like a convention, so nobody read it
 * as a gap — but it only ever set the size, never the separation, and it was
 * absent from the other ten. A per-site utility cannot be audited by looking at
 * any one site; that is the whole reason the treatment moved into a base rule
 * and this module exists to keep it there.
 *
 * Two things are checked, because the rule can be defeated from either end:
 *
 *  1. **The base rule is still declared.** Deleting it is silent — every page
 *     keeps rendering, just badly, exactly as before.
 *  2. **No element re-sizes itself.** A `text-xs` on a `<code>` beats the base
 *     rule's `0.875em` and reintroduces an absolute size inside relative
 *     prose. That is the drift being removed here, and it grew to ten sites
 *     without anyone deciding to.
 *
 * Kept free of `fs` so both parsers run on synthetic input — the shape
 * `a11y-class-hygiene`, `fetch-host-hygiene` and `jsx-text-weld` all share.
 * `inline-code-style.test.ts` reads the real files.
 *
 * The AST rather than a regex, for the reason this repo has been bitten by
 * twice: `calendar-feed.tsx:41` says "not a `<code>` block" **in a doc
 * comment**, and `globals.css`'s own rule names `<kbd>` in prose. A regex
 * reports both.
 */

import ts from "typescript";

/**
 * The inline elements the base rule covers.
 *
 * `pre` is deliberately absent. A code *block* wants none of the chip
 * treatment, and there is no `<pre>` in the tree — so including it here would
 * assert something about markup that does not exist.
 */
export const INLINE_CODE_TAGS = ["code", "kbd", "samp"] as const;

const TAGS = new Set<string>(INLINE_CODE_TAGS);

/**
 * Utilities that set a font size, and therefore override the base rule.
 *
 * Only the size axis. `break-all` (which `privacy/page.tsx` still needs for a
 * long opaque identifier) and colour or weight utilities are all fine on top of
 * the chip — they compose with it rather than replacing part of it. Size is the
 * one that matters, because the base rule's whole point is that it is relative:
 * a chip has to stay proportional to the prose it sits in, and `text-xs` pins
 * it to 12px whether that prose is 14px or 20px.
 *
 * Matches the arbitrary form too (`text-[13px]`), which is the obvious way
 * round a check that only knew the named scale.
 */
const FONT_SIZE_UTILITY =
  /^text-(xs|sm|base|lg|xl|[2-9]xl|\[[^\]]*(?:px|rem|em|pt|ch|%)[^\]]*\])$/;

/** One element that re-sizes itself out from under the base rule. */
export interface SizeOverride {
  /** 1-based line of the opening tag. */
  line: number;
  /** `code`, `kbd` or `samp`. */
  tag: string;
  /** The offending utility, e.g. `text-xs`. */
  token: string;
}

/**
 * Every `code` / `kbd` / `samp` element in `source` that carries a font-size
 * utility.
 *
 * `fileName` selects TypeScript's syntax dialect, so pass the real path.
 */
export function findInlineCodeSizeOverrides(
  source: string,
  fileName = "input.tsx",
): SizeOverride[] {
  const sourceFile = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
    ts.ScriptKind.TSX,
  );

  const overrides: SizeOverride[] = [];

  const visit = (node: ts.Node): void => {
    const opening = ts.isJsxElement(node)
      ? node.openingElement
      : ts.isJsxSelfClosingElement(node)
        ? node
        : null;
    if (opening && ts.isIdentifier(opening.tagName)) {
      const tag = opening.tagName.text;
      if (TAGS.has(tag)) {
        for (const attribute of opening.attributes.properties) {
          if (!ts.isJsxAttribute(attribute)) continue;
          if (attribute.name.getText(sourceFile) !== "className") continue;
          // Every string literal anywhere in the attribute, so a `cn()` call or
          // a ternary arm is read as well as a plain string.
          //
          // String literals *only*. A `JsxText` can reach here — `className`
          // takes an element at the syntax level, so `className={<span>text-xs
          // </span>}` parses with zero diagnostics and walks one in — but that
          // text is what the element renders, not a class token; React would
          // set the class to `[object Object]`. Reading it is the same
          // comment-versus-code mistake this module exists to avoid, one level
          // along. Removed on !272.
          const collect = (inner: ts.Node): void => {
            if (
              ts.isStringLiteral(inner) ||
              ts.isNoSubstitutionTemplateLiteral(inner)
            ) {
              for (const token of inner.text.split(/\s+/)) {
                // Strip any variant chain: `sm:text-xs` re-sizes too.
                const base = token.slice(token.lastIndexOf(":") + 1);
                if (!FONT_SIZE_UTILITY.test(base)) continue;
                overrides.push({
                  line:
                    sourceFile.getLineAndCharacterOfPosition(
                      opening.getStart(sourceFile),
                    ).line + 1,
                  tag,
                  token,
                });
              }
            }
            ts.forEachChild(inner, collect);
          };
          if (attribute.initializer) collect(attribute.initializer);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(sourceFile, visit);

  return overrides;
}

/**
 * Everything declared by rules whose selector list is exactly `selectors`, or
 * null if there is no such rule.
 *
 * Declarations from **every** matching block are merged, later winning, because
 * that is what the cascade does and it is the question worth asking: not "what
 * is in this one block" but "what does this selector end up setting". A CSS file
 * splits a selector across blocks routinely — `globals.css` has three separate
 * `:root` rules, the palette, the completion tokens and the code-chip tokens —
 * and a first-match-only reader silently reports the palette's declarations as
 * the whole answer. It did exactly that here before this was fixed.
 *
 * Deliberately tiny, and deliberately not a CSS parser. Comments are stripped
 * first, because `globals.css`'s rule is preceded by forty lines of prose naming
 * both the selectors and the properties — the same comment-versus-code trap the
 * JSX side has.
 */
export function findCssRule(
  css: string,
  selectors: readonly string[],
): Record<string, string> | null {
  const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const wanted = selectors.join(",");
  const declarations: Record<string, string> = {};
  let matched = false;

  // Split on `}` boundaries rather than matching braces: none of the rules being
  // asked about nest, and a nested block would simply not match.
  for (const chunk of withoutComments.split("}")) {
    const brace = chunk.indexOf("{");
    if (brace === -1) continue;
    const selector = chunk
      .slice(0, brace)
      .split(",")
      .map((part) => part.trim())
      .filter(Boolean)
      .join(",");
    if (selector !== wanted) continue;
    matched = true;

    for (const statement of chunk.slice(brace + 1).split(";")) {
      const colon = statement.indexOf(":");
      if (colon === -1) continue;
      const property = statement.slice(0, colon).trim();
      if (!property) continue;
      declarations[property] = statement
        .slice(colon + 1)
        .trim()
        .replace(/\s+/g, " ");
    }
  }
  return matched ? declarations : null;
}
