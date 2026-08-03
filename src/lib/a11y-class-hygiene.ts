/**
 * #109 / #117 — the two Tailwind class patterns the a11y gates cannot see.
 *
 * Both issues are the same structural blind spot wearing different clothes:
 * **the automated gates only measure what is on screen during the scan.**
 *
 *  * #109 — a bare `-600` used as text. Every instance was data- or
 *    state-dependent (a save in flight, a demo override set, an error redirect),
 *    so the failing colour was never painted while axe was looking. CI was green
 *    and the app failed AA. Eight sites reached `main` this way, plus #95 and
 *    #99 before them, and a ninth (`task-schedule.tsx`) that neither issue had
 *    found.
 *  * #117 — a focus indicator that is only a background swap. axe does not
 *    implement **WCAG 2.4.11 Focus Appearance** at all, so no amount of seeding
 *    would have caught it. The contrast gate, the guest-surface scans and the
 *    axe baseline are all structurally incapable of seeing it.
 *
 * Seeding fixtures per state is what !188 did for #95 and it works, but it costs
 * one fixture per state and catches the *instance*, not the class — which is why
 * !188's own sweep found eight more. This module catches the class instead, for
 * the price of a unit test, by reading the class strings out of the source.
 *
 * Kept free of `fs` so the parsing is unit-testable on synthetic sources — the
 * split `fetch-host-hygiene`, `manifest-hygiene`, `lockfile-hygiene` and
 * `dockerfile-hygiene` all use; the caller reads the files.
 * `a11y-class-hygiene.test.ts` holds the allowlists and the scan over the real
 * tree.
 *
 * ── Why the TypeScript AST and not a regex ──────────────────────────────────
 * Same reason `fetch-host-hygiene` gives, and it is not hypothetical here:
 * `status-pill.tsx:14` and `inbox-view.tsx:2085` both name `text-amber-600` **in
 * a comment**, documenting the bug they fixed. A regex reports two findings that
 * do not exist, and a guard that cries wolf gets relaxed. `typescript` is
 * already a declared devDependency.
 *
 * The AST also gives the thing a regex fundamentally cannot: **scope**. Rule B
 * has to know whether a `dark:` partner exists on the *same element*, and that
 * partner is routinely in a different string literal — a `cn()` argument, the
 * other arm of a ternary, a sibling object property. See {@link scanClassScopes}.
 *
 * ── What this does NOT cover, stated rather than left to be discovered ──────
 *  1. **Measured contrast.** These are shade-discipline rules, not a photometer.
 *     `text-green-700 dark:text-green-400` on a `bg-green-600/10` tint measures
 *     4.16:1 in light — the tint lifts the background toward the text — and this
 *     module passes it, because the token pair is correct and only the
 *     composition fails. That composition is `e2e/a11y-contrast.spec.ts`'s job,
 *     and it needs the state seeded to see it. Rule B's opaque-background
 *     carve-out is deliberately narrow for the same reason.
 *  2. **The `dark:` side's own contrast.** Rule B requires that a partner
 *     exists, not that it passes. `dark:text-red-600` would satisfy Rule B and
 *     measure 4.12:1 on the dark background. Nothing in the tree does this, and
 *     adding the symmetric rule needs a second per-family threshold measured
 *     against the *dark* background — a separate change with its own argument.
 *  3. **Colours that are not Tailwind palette classes.** An arbitrary value
 *     (`text-[#e17100]`), a CSS variable, an inline `style`, or an SVG `fill` is
 *     invisible to this. The palette classes are where the recurrence was.
 *  4. **A focus indicator that keeps the UA outline.** Rule D only fires when
 *     `outline-none` is present, because removing the browser's own outline is
 *     what makes an indicator the author's problem. `move-to-menu.tsx` styles
 *     `data-[highlighted]:bg-accent` with no `outline-none`, so the UA outline
 *     still draws and 2.4.11 is still satisfied — correctly not a finding.
 */

import ts from "typescript";

/**
 * Tailwind's chromatic families. Split out from the neutrals because the whole
 * premise of Rule A is measured and family-dependent: chroma is bought with
 * luminance, so a saturated `-600` lands near 3:1 on this palette's light
 * `--background` (#fdf6fa) while a neutral `-600` is comfortably past 4.5:1.
 *
 * Measured on the light `--background`, which is the worst case (`--card` is
 * white and therefore more forgiving):
 *
 *   green-600  3.03:1   amber-600  3.00:1   emerald-600  3.45:1
 *   red-600    4.48:1   red-500    3.59:1
 *
 * — every one of them under 4.5:1, and `red-600` under it by a margin small
 * enough that nobody spotted it by eye. The same families at `-700`:
 *
 *   green-700  4.65:1   amber-700  4.75:1   emerald-700  5.05:1
 *   red-700    6.04:1
 *
 * So 700 is the floor, and it is the floor for the *most forgiving* family in
 * the set rather than an average.
 */
const CHROMATIC_FAMILIES = [
  "red",
  "orange",
  "amber",
  "yellow",
  "lime",
  "green",
  "emerald",
  "teal",
  "cyan",
  "sky",
  "blue",
  "indigo",
  "violet",
  "purple",
  "fuchsia",
  "pink",
  "rose",
] as const;

/**
 * Neutral families, deliberately out of scope. `text-gray-600` is ~7:1 on this
 * background, so banning it would be a false positive — and a guard with false
 * positives is a guard that gets deleted. None of these appear as a text colour
 * in the tree today; this repo uses `--muted-foreground` for neutral text.
 */
const NEUTRAL_FAMILIES = ["slate", "gray", "zinc", "neutral", "stone"] as const;

/** The lowest Tailwind shade that is AA (4.5:1) as text on `--background`. */
export const MIN_AA_TEXT_SHADE = 700;

const FAMILY_ALTERNATION = [...CHROMATIC_FAMILIES, ...NEUTRAL_FAMILIES].join(
  "|",
);

/** `text-amber-600` → family + shade. Neutral families match too, so Rule A can
 *  exclude them explicitly rather than by silently not recognising them. */
const TEXT_COLOR = new RegExp(`^text-(${FAMILY_ALTERNATION})-(\\d{2,3})$`);

/** `bg-green-100` → family + shade. */
const BG_COLOR = new RegExp(`^bg-(${FAMILY_ALTERNATION})-(\\d{2,3})$`);

/** One element's (or one shared class constant's) complete set of classes. */
export interface ClassScope {
  /** 1-based line of the scope's first string literal, for the message. */
  line: number;
  /** Every class token found anywhere in the scope, in source order, with
   *  duplicates collapsed. Variants are kept verbatim (`dark:text-green-400`). */
  tokens: string[];
}

/** One rule violation. */
export interface StyleFinding {
  /** 1-based line of the string literal the offending token came from. */
  line: number;
  /** The token, or for Rule D the `outline-none` scope's offending class.
   *  Doubles as the allowlist key's second half, so it carries no line. */
  token: string;
  reason: string;
}

// ── Scope extraction ───────────────────────────────────────────────────────
//
// A "scope" is the smallest syntactic thing that decides one element's classes.
// Three shapes cover the whole tree:
//
//   <p className={cn("text-xs", aging && "text-amber-700 dark:text-amber-400")}>
//   ^ JsxAttribute — includes `accent="text-amber-600"`, which is NOT named
//     className, so filtering on the attribute name would have missed
//     dashboard/page.tsx entirely.
//
//   aging: { color: "text-amber-700 dark:text-amber-400" }
//   ^ PropertyAssignment — FRESHNESS_TIER_STYLE's shape.
//
//   const entry = "… outline-none";
//   ^ VariableDeclaration — account-menu's shared entry string, and the shape
//     `integrations-panel.tsx`'s three-arm `pillClass` ternary takes.
//
// Nested scopes do NOT leak into their parent: `headingExtras={<span
// className="…text-amber-600" />}` is a className scope inside a JsxAttribute
// scope, and unioning them would let an unrelated sibling's `dark:` partner
// satisfy Rule B for the span. So collection stops at a nested scope root.

function isScopeRoot(node: ts.Node): boolean {
  return (
    ts.isJsxAttribute(node) ||
    ts.isPropertyAssignment(node) ||
    ts.isVariableDeclaration(node)
  );
}

/** Split a class string into tokens, dropping empties from odd whitespace. */
function classTokens(text: string): string[] {
  return text.split(/\s+/).filter((token) => token.length > 0);
}

/**
 * Is this string literal plausibly a class list rather than prose? Two or more
 * hyphenated-or-variant tokens, or a single token that looks like a utility.
 * Only used to pick which literals seed a scope — over-inclusion is harmless
 * because the rules match exact utility shapes, but this keeps a sentence of UI
 * copy from producing a `ClassScope` with a line number and no classes.
 */
function looksLikeClasses(text: string): boolean {
  const tokens = classTokens(text);
  if (tokens.length === 0) return false;
  return tokens.every((token) =>
    /^[a-z0-9[\]:_@.,/%!&<>()#*+-]+$/i.test(token),
  );
}

/**
 * Every class scope in `source`, each carrying the union of its own class
 * tokens.
 *
 * `fileName` only affects TypeScript's syntax selection (`.tsx` parses JSX), so
 * pass the real path when scanning the tree.
 */
export function scanClassScopes(
  source: string,
  fileName = "input.tsx",
): ClassScope[] {
  const sourceFile = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
    fileName.endsWith(".ts") || fileName.endsWith(".mts")
      ? ts.ScriptKind.TS
      : ts.ScriptKind.TSX,
  );

  const scopes: ClassScope[] = [];
  const visit = (node: ts.Node): void => {
    if (isScopeRoot(node)) {
      const tokens: string[] = [];
      let line: number | null = null;
      const visitOwn = (inner: ts.Node): void => {
        if (inner !== node && isScopeRoot(inner)) return;
        if (
          ts.isStringLiteral(inner) ||
          ts.isNoSubstitutionTemplateLiteral(inner) ||
          ts.isTemplateHead(inner) ||
          ts.isTemplateMiddle(inner) ||
          ts.isTemplateTail(inner)
        ) {
          const text = inner.text;
          if (looksLikeClasses(text)) {
            for (const token of classTokens(text)) {
              if (!tokens.includes(token)) tokens.push(token);
            }
            if (line === null) {
              line =
                sourceFile.getLineAndCharacterOfPosition(
                  inner.getStart(sourceFile),
                ).line + 1;
            }
          }
        }
        ts.forEachChild(inner, visitOwn);
      };
      ts.forEachChild(node, visitOwn);
      if (tokens.length > 0 && line !== null) scopes.push({ line, tokens });
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(sourceFile, visit);

  return scopes.sort((a, b) => a.line - b.line);
}

// ── Rules A and B: text colour ─────────────────────────────────────────────

/** Strip and return a token's variant chain. `dark:hover:text-x` → ["dark",
 *  "hover"] plus the base `text-x`. Arbitrary variants (`[&_svg]:`) are kept as
 *  opaque strings; nothing here needs to interpret them. */
function splitVariants(token: string): { variants: string[]; base: string } {
  const parts: string[] = [];
  let rest = token;
  for (;;) {
    // Do not split inside an arbitrary variant or value: `[&:has(:focus)]:x`
    // and `bg-[color:var(--x)]` both contain a colon.
    const depth = { bracket: 0, paren: 0 };
    let cut = -1;
    for (let i = 0; i < rest.length; i++) {
      const c = rest[i];
      if (c === "[") depth.bracket++;
      else if (c === "]") depth.bracket--;
      else if (c === "(") depth.paren++;
      else if (c === ")") depth.paren--;
      else if (c === ":" && depth.bracket === 0 && depth.paren === 0) {
        cut = i;
        break;
      }
    }
    if (cut === -1) return { variants: parts, base: rest };
    parts.push(rest.slice(0, cut));
    rest = rest.slice(cut + 1);
  }
}

/** Is this token an unprefixed (light-mode, all-states) utility? */
function isUnprefixed(token: string): boolean {
  return splitVariants(token).variants.length === 0;
}

/**
 * Rule B's carve-out: does the scope pin its own background opaquely?
 *
 * `bg-green-100 text-green-800` (integrations-panel's status pill) is safe with
 * no `dark:` partner, because *neither* token changes with the theme — the
 * ratio is 6.45:1 in both. The carve-out requires the background to be
 * **opaque**: `bg-green-600/10` is a 10% tint over `--background`, so the theme
 * still shows through and the ratio still moves. That is not a technicality —
 * it is the difference between `integrations-panel.tsx` (fine) and
 * `(app)/page.tsx`'s Google banners (3.06:1 in dark).
 */
function pinsOwnBackground(tokens: readonly string[]): boolean {
  const hasOpaqueBg = tokens.some(
    (token) => isUnprefixed(token) && BG_COLOR.test(token),
  );
  if (!hasOpaqueBg) return false;
  // A `dark:bg-*` means the background DOES move with the theme, so the text
  // needs a partner after all.
  return !tokens.some((token) => {
    const { variants, base } = splitVariants(token);
    return variants.includes("dark") && base.startsWith("bg-");
  });
}

/**
 * Rules A and B over one source file.
 *
 * **Rule A** — an unprefixed `text-<chromatic>-<shade>` below
 * {@link MIN_AA_TEXT_SHADE} is a finding. No pairing can rescue it: the light
 * theme has no fallback.
 *
 * **Rule B** — an unprefixed `text-<chromatic>-<shade>` at or above the floor
 * needs a `dark:text-*` partner in the same scope, because `-700` and darker run
 * 2.3–4.0:1 against the dark `--background`. Waived when the scope pins its own
 * opaque background (see {@link pinsOwnBackground}).
 */
export function findTextContrastRisks(
  source: string,
  fileName = "input.tsx",
): StyleFinding[] {
  const findings: StyleFinding[] = [];
  for (const scope of scanClassScopes(source, fileName)) {
    const hasDarkText = scope.tokens.some((token) => {
      const { variants, base } = splitVariants(token);
      return variants.includes("dark") && base.startsWith("text-");
    });
    const pinned = pinsOwnBackground(scope.tokens);

    for (const token of scope.tokens) {
      if (!isUnprefixed(token)) continue;
      const match = TEXT_COLOR.exec(token);
      if (!match) continue;
      const [, family, shadeText] = match;
      if ((NEUTRAL_FAMILIES as readonly string[]).includes(family)) continue;
      const shade = Number(shadeText);

      if (shade < MIN_AA_TEXT_SHADE) {
        findings.push({
          line: scope.line,
          token,
          reason: `a bare \`${family}-${shade}\` is not AA (4.5:1) as text on this palette's light --background; use \`text-${family}-${MIN_AA_TEXT_SHADE}\` with a \`dark:text-${family}-400\` partner`,
        });
        continue;
      }
      if (!hasDarkText && !pinned) {
        findings.push({
          line: scope.line,
          token,
          reason: `\`${token}\` has no \`dark:text-*\` partner and the scope does not pin an opaque background, so it renders at 2.3-4.0:1 on the dark --background`,
        });
      }
    }
  }
  return findings;
}

// ── Rule D: focus indicator ────────────────────────────────────────────────

/** Variants that mean "while focused". */
const FOCUS_VARIANTS = ["focus-visible", "focus", "focus-within"];

/** Utilities that remove the browser's own focus outline. */
const OUTLINE_KILLERS = ["outline-none", "outline-hidden", "outline-0"];

/**
 * Base utilities that draw a focus indicator which is **not** solely a colour
 * change — the property 2.4.11 turns on. A ring, an inset ring, a restored
 * outline, an underline or a border *width* all add or move a visible edge.
 *
 * `ring-ring` and `border-ring` are excluded on purpose: they set the ring's or
 * border's *colour*, and a colour with no width is the very shape this rule
 * exists to reject. Every passing site in the tree pairs them with a width
 * (`focus-visible:ring-2`), so requiring the width costs nothing and the
 * distinction is real. `ring-0` and `outline-none` are excluded for the obvious
 * reason.
 */
function drawsIndicator(base: string): boolean {
  if (OUTLINE_KILLERS.includes(base)) return false;
  if (base === "ring-0" || base === "inset-ring-0" || base === "outline-0") {
    return false;
  }
  // `ring`, `ring-2`, `inset-ring`, `inset-ring-4`, `outline-2`, `border-2`.
  if (/^(inset-)?ring(-\d+)?$/.test(base)) return true;
  if (/^outline-\d+$/.test(base)) return true;
  if (/^border(-\d+)?$/.test(base)) return true;
  // `underline` / `decoration-2` — the indicator legal-page links use.
  if (base === "underline" || /^decoration-\d+$/.test(base)) return true;
  return false;
}

/**
 * Rule D — any scope that removes the UA focus outline must draw an indicator
 * of its own that is not merely a colour swap.
 *
 * WCAG 2.4.11 Focus Appearance is **AA in WCAG 2.2**, and axe does not
 * implement it, so this is the only automated check that can see it. The
 * background swap the two header menus relied on measured **1.07:1 (light)** and
 * **1.17:1 (dark)** between the focused and unfocused entry — nowhere near the
 * 3:1 an indicator needs against adjacent colours.
 */
export function findWeakFocusIndicators(
  source: string,
  fileName = "input.tsx",
): StyleFinding[] {
  const findings: StyleFinding[] = [];
  for (const scope of scanClassScopes(source, fileName)) {
    const killer = scope.tokens.find((token) =>
      OUTLINE_KILLERS.includes(splitVariants(token).base),
    );
    if (!killer) continue;

    const hasIndicator = scope.tokens.some((token) => {
      const { variants, base } = splitVariants(token);
      if (!variants.some((v) => FOCUS_VARIANTS.includes(v))) return false;
      return drawsIndicator(base);
    });
    if (hasIndicator) continue;

    const colourOnly = scope.tokens
      .filter((token) => {
        const { variants, base } = splitVariants(token);
        return (
          variants.some((v) => FOCUS_VARIANTS.includes(v)) &&
          (base.startsWith("bg-") || base.startsWith("text-"))
        );
      })
      .join(" ");

    findings.push({
      line: scope.line,
      token: killer,
      reason: colourOnly
        ? `\`${killer}\` removes the UA focus outline and the only focus treatment left is a colour swap (${colourOnly}), which does not satisfy WCAG 2.4.11 Focus Appearance; add \`focus-visible:inset-ring-2 focus-visible:inset-ring-ring\``
        : `\`${killer}\` removes the UA focus outline and nothing replaces it, so the element has no visible focus indicator (WCAG 2.4.7 / 2.4.11)`,
    });
  }
  return findings;
}
