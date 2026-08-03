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
export const CHROMATIC_FAMILIES = [
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

const CHROMATIC = new Set<string>(CHROMATIC_FAMILIES);

/**
 * `text-amber-600`, `text-red-800/70` → family, shade, optional alpha.
 *
 * The alpha group is captured rather than excluded because `text-red-600/80` is
 * *strictly worse* than the opaque `text-red-600` Rule A already bans — reducing
 * a text colour's opacity blends it toward the background. A pattern that ended
 * at `$` after the shade would let the modifier slip the entire rule.
 *
 * `([a-z]+)` matches any family and the caller checks {@link CHROMATIC}
 * membership, rather than interpolating the family list into the pattern. Two
 * reasons, and the second is the one that made the change:
 *
 *  1. A membership test belongs in a `Set`, not in a regex alternation.
 *  2. Building the pattern from an interpolated string trips semgrep's
 *     `javascript-regex-non-literal` (ReDoS). That finding was a false positive —
 *     the interpolated value was a joined pair of module-level `as const` arrays
 *     of literals, reachable by no input — but a hardcoded pattern is both what
 *     the rule asks for and better code, so there is nothing to dismiss. A
 *     dismissal would also have to be re-argued after every repo-wide reformat,
 *     which re-fingerprints triaged SAST findings.
 *
 * (Written without the offending syntax on purpose: semgrep reads the AST and
 * would not see it in a comment, but env-drift's scanner and Duo have both read
 * this repo's doc comments as real code before.)
 *
 * Non-colour utilities are excluded by shape, not by list: `text-muted-foreground`
 * fails `\d{2,3}` on its last segment and `text-2xl` has no second hyphen.
 */
const TEXT_COLOR = /^text-([a-z]+)-(\d{2,3})(?:\/(\d{1,3}))?$/;

/** `bg-green-100` → family + shade. Family checked by the caller, as above. */
const BG_COLOR = /^bg-([a-z]+)-(\d{2,3})$/;

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
 * Is this string literal plausibly a class list rather than prose?
 *
 * Every token must be shaped like a utility, AND at least one must carry a `-`
 * or a `:` — the two characters no single English word in this app's UI copy
 * needs but every Tailwind utility the rules care about has
 * (`text-amber-600`, `outline-none`, `dark:text-amber-400`, `bg-green-600/10`).
 *
 * Without the second condition, "Sign in with GitLab" scores as a four-class
 * scope: 3192 scopes over `src/`, of which ~1900 are sentences. That costs no
 * correctness — the rules match exact utility shapes, so prose can never trip
 * one — but it does make the "the scanner is not a no-op" count in the test
 * measure mostly copy, which is the wrong thing to assert on. With it: 1263.
 *
 * A scope whose entire class list is a single bare utility (`"flex"`,
 * `"underline"`) is dropped, and that is safe by construction: every rule in
 * this module keys off a hyphenated utility, so such a scope has nothing to say.
 */
// The hyphen leads the character class so it is unambiguously literal. It was
// last, which is also literal — a trailing `-` cannot open a range, so the
// behaviour is identical and the two forms were verified to accept the same
// tokens. But "is `*+-]` a range?" is a question a reader should not have to
// answer, and Duo review asked it on !250. `[` and `]` are for arbitrary values
// (`bg-[color:var(--x)]`), `/` for alpha modifiers, `:` for variants.
const UTILITY_SHAPED = /^[-a-z0-9[\]:_@.,/%!&<>()#*+]+$/i;

function looksLikeClasses(text: string): boolean {
  const tokens = classTokens(text);
  if (tokens.length === 0) return false;
  if (!tokens.every((token) => UTILITY_SHAPED.test(token))) return false;
  return tokens.some((token) => token.includes("-") || token.includes(":"));
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
      // A `Set` for membership alongside the array that keeps source order — the
      // public contract is "in source order, duplicates collapsed", so the order
      // has to be an array while the de-duplication should not be a linear rescan
      // per token. Duo review, !250. `cn("text-xs", cond && "text-xs …")` really
      // does repeat tokens, so the de-duplication is not hypothetical.
      const tokens: string[] = [];
      const seen = new Set<string>();
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
              if (seen.has(token)) continue;
              seen.add(token);
              tokens.push(token);
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
 *  opaque strings; nothing here needs to interpret them.
 *
 *  Exported because every caller that wants to ask "is this a dark-mode
 *  something" must ask it this way. A `token.startsWith("dark:bg-")` prefix test
 *  looks equivalent and silently misses `dark:hover:bg-*` and `dark:sm:bg-*` —
 *  that exact bug shipped in `status-banner-style.test.ts` and was caught by Duo
 *  review on !250. */
export function splitVariants(token: string): {
  variants: string[];
  base: string;
} {
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

/**
 * Does `token` set `<basePrefix>…` **in dark mode**, anywhere in its variant
 * chain? `isDarkVariant("dark:hover:bg-amber-950/20", "bg-")` is true.
 *
 * Exported, and the only sanctioned way to ask. Three separate call sites reached
 * for `token.startsWith("dark:bg-")` / `("dark:text-")` instead, and Duo review
 * caught the same bug in each on !250 — the prefix reads a compound chain as a
 * non-match, so `dark:hover:bg-*` and `dark:sm:text-*` slip through. Three
 * identical bugs from three hand-rolled copies is a missing function, not three
 * mistakes, so this is it. Nothing outside this module should call
 * {@link splitVariants} to reimplement it.
 */
export function isDarkVariant(token: string, basePrefix: string): boolean {
  const { variants, base } = splitVariants(token);
  return variants.includes("dark") && base.startsWith(basePrefix);
}

/** Is this token an unprefixed (light-mode, all-states) utility? */
function isUnprefixed(token: string): boolean {
  return splitVariants(token).variants.length === 0;
}

/**
 * Does this token paint in the LIGHT theme?
 *
 * Anything without a `dark:` in its variant chain does — which is the property
 * Rules A and B actually depend on, and it is strictly wider than "unprefixed".
 * `hover:text-red-600` and `sm:text-red-600` are both sub-AA light-mode text and
 * would walk straight past an unprefixed-only check. Neither shape exists in the
 * tree today, which is exactly why the rule has to cover them: the eight sites
 * #109 inventoried did not exist either, until somebody wrote one.
 *
 * A hover or focus state is held to the same 4.5:1 bar as the resting state —
 * WCAG makes no allowance for "only while pointing at it".
 */
function appliesInLightMode(token: string): boolean {
  return !splitVariants(token).variants.includes("dark");
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
 *
 * `bg-white` and `bg-black` count too. They carry no shade number, so the
 * shade-shaped pattern missed them — but they are fixed sRGB values that do not
 * move with the theme, which is the only property this carve-out depends on.
 * Nothing in the tree pairs one with chromatic text today (the two occurrences
 * are `bg-black/50` and `bg-white/10`, both alpha and therefore correctly still
 * excluded), so this prevents a future false positive rather than fixing a
 * current one — and a false positive here costs an allowlist entry nobody can
 * defend, which is how an allowlist stops meaning anything. Duo review, !250.
 */
function pinsOwnBackground(tokens: readonly string[]): boolean {
  const hasOpaqueBg = tokens.some((token) => {
    if (!isUnprefixed(token)) return false;
    // Opaque only: `bg-white/10` is a 10% wash over whatever is behind it, so the
    // theme still shows through exactly as it does through `bg-green-600/10`.
    if (token === "bg-white" || token === "bg-black") return true;
    const match = BG_COLOR.exec(token);
    // A neutral `bg-gray-100` pins the ratio just as well as a chromatic one, so
    // both count here — but a `bg-<not-a-family>-100` must not, or a typo would
    // silently earn the waiver.
    return (
      match !== null &&
      (CHROMATIC.has(match[1]) ||
        (NEUTRAL_FAMILIES as readonly string[]).includes(match[1]))
    );
  });
  if (!hasOpaqueBg) return false;
  // A `dark:bg-*` means the background DOES move with the theme, so the text
  // needs a partner after all.
  return !tokens.some((token) => isDarkVariant(token, "bg-"));
}

/**
 * Rules A and B over one source file.
 *
 * **Rule A** — a light-painting `text-<chromatic>-<shade>` below
 * {@link MIN_AA_TEXT_SHADE} is a finding. No pairing can rescue it: the light
 * theme has no fallback. An `/alpha` modifier on ANY shade is a finding too — it
 * blends the text toward the background, so it can only be worse than the opaque
 * shade, and 700 is already the floor.
 *
 * **Rule B** — an unprefixed `text-<chromatic>-<shade>` at or above the floor
 * needs a `dark:text-*` partner in the same scope, because `-700` and darker run
 * 2.3–4.0:1 against the dark `--background`. Waived when the scope pins its own
 * opaque background (see {@link pinsOwnBackground}).
 *
 * Rule B stays unprefixed-only on purpose: whether `hover:text-green-700` and
 * `dark:text-green-400` resolve in the right order in dark mode is a Tailwind
 * variant-ordering question, and asserting a partner for a variant-prefixed
 * colour would be asserting something this module has not established. Rule A
 * still covers those tokens, which is where the sub-AA risk actually is.
 */
export function findTextContrastRisks(
  source: string,
  fileName = "input.tsx",
): StyleFinding[] {
  const findings: StyleFinding[] = [];
  for (const scope of scanClassScopes(source, fileName)) {
    /**
     * Does the scope carry a `dark:` text partner **of this family**?
     *
     * Per-family, not per-scope. A scope-wide "some dark text exists" flag lets
     * one token's partner clear another's: `"text-green-700 text-red-700
     * dark:text-green-400"` would pass Rule B for `text-red-700`, which has no
     * partner at all. Duo review, !250 — a real false negative, and the sort a
     * scope-level boolean invites.
     *
     * Per-family is also what the tree already does: every `dark:text-*` in
     * `src/` pairs with the same family as the light value it overrides
     * (`text-red-800 dark:text-red-200`, `text-amber-800 dark:text-amber-300`),
     * so this is a tightening with no new findings — verified, not assumed.
     */
    const hasDarkPartnerFor = (family: string): boolean =>
      scope.tokens.some((token) => isDarkVariant(token, `text-${family}-`));
    const pinned = pinsOwnBackground(scope.tokens);

    for (const token of scope.tokens) {
      if (!appliesInLightMode(token)) continue;
      // Match the BASE, not the whole token: `hover:text-amber-600` is a
      // light-mode sub-AA text colour and a `^text-`-anchored match against the
      // full token silently misses it. The finding still reports the full token,
      // because that is what the allowlist has to key on and what a reader has
      // to find in the file.
      const match = TEXT_COLOR.exec(splitVariants(token).base);
      if (!match) continue;
      const [, family, shadeText, alphaText] = match;
      // Chromatic families only. This also filters anything that merely LOOKS
      // like a palette colour — the neutrals are excluded by measurement (see
      // NEUTRAL_FAMILIES) and a non-family word is not a colour at all.
      if (!CHROMATIC.has(family)) continue;
      const shade = Number(shadeText);

      if (alphaText !== undefined) {
        findings.push({
          line: scope.line,
          token,
          reason: `\`${token}\` fades the text toward the background, so it reads below the opaque \`${family}-${shade}\`; drop the /${alphaText} or allowlist it with a measured ratio`,
        });
        continue;
      }
      if (shade < MIN_AA_TEXT_SHADE) {
        findings.push({
          line: scope.line,
          token,
          reason: `a bare \`${family}-${shade}\` is not AA (4.5:1) as text on this palette's light --background; use \`text-${family}-${MIN_AA_TEXT_SHADE}\` with a \`dark:text-${family}-400\` partner`,
        });
        continue;
      }
      // Only an UNPREFIXED colour is the resting light-mode value a `dark:`
      // partner is meant to override; see the note above.
      if (!isUnprefixed(token)) continue;
      if (!hasDarkPartnerFor(family) && !pinned) {
        findings.push({
          line: scope.line,
          token,
          reason: `\`${token}\` has no \`dark:text-${family}-*\` partner and the scope does not pin an opaque background, so it renders at 2.3-4.0:1 on the dark --background`,
        });
      }
    }
  }
  return findings;
}

// ── Rule C: the tinted-banner shape ───────────────────────────────────────

/** `bg-amber-500/10` — a palette background carrying an alpha modifier. */
const TINTED_BG = /^bg-([a-z]+)-\d{2,3}\/\d{1,3}$/;

/** Does any token set a dark-mode background, at any point in its variant chain? */
function hasDarkBackground(tokens: readonly string[]): boolean {
  return tokens.some((token) => isDarkVariant(token, "bg-"));
}

/**
 * Rule C — scopes whose text sits on a **translucent chromatic tint composited
 * over `--background`**, with the chromatic text colours they use.
 *
 * This is the shape Rules A and B cannot judge. A translucent tint pulls the
 * effective background *toward* the text: `text-green-700` is 4.65:1 on the bare
 * light `--background` and **4.16:1** once its own `bg-green-600/10` is in the
 * way. Six banners in this repo passed the token rules and failed AA that way,
 * and one of them carried a comment asserting it did not.
 *
 * Measuring a composite from source is not something this module can do, so it
 * reports the *shape* and lets `status-banner-style.test.ts` require that those
 * colours come from the one table whose ratios were measured. That keeps the
 * measured numbers next to the table they describe, and keeps the shape
 * detection here where it can be exercised on synthetic input.
 *
 * A scope that sets its own `dark:bg-*` is excluded: it composites over a
 * background it chose rather than over `--background`, so the table's numbers say
 * nothing about it (`guest-indicator.tsx` is the real case). That exclusion has
 * to be variant-aware — `dark:hover:bg-amber-950/20` is a dark background — which
 * is why it goes through {@link splitVariants} rather than a string prefix.
 */
export function findTintedBannerText(
  source: string,
  fileName = "input.tsx",
): { line: number; token: string }[] {
  const found: { line: number; token: string }[] = [];
  for (const scope of scanClassScopes(source, fileName)) {
    const tinted = scope.tokens.some((token) => {
      const match = TINTED_BG.exec(token);
      return match !== null && CHROMATIC.has(match[1]);
    });
    if (!tinted) continue;
    if (hasDarkBackground(scope.tokens)) continue;
    for (const token of scope.tokens) {
      if (!isUnprefixed(token)) continue;
      const match = TEXT_COLOR.exec(token);
      if (match && CHROMATIC.has(match[1])) {
        found.push({ line: scope.line, token });
      }
    }
  }
  return found;
}

// ── Rule D: focus indicator ────────────────────────────────────────────────

/** Variants that mean "while focused". */
const FOCUS_VARIANTS = ["focus-visible", "focus", "focus-within"];

/**
 * Utilities that remove the browser's own focus outline.
 *
 * **`outline-hidden` belongs here, and this is the load-bearing bit.** Duo review
 * (!250) argued it should be removed on the grounds that it "is the standard
 * accessibility technique for Windows High Contrast Mode". Half true, and the
 * wrong half to act on. Tailwind 4.3.3 compiles it to:
 *
 *     .outline-hidden {
 *       --tw-outline-style: none;
 *       outline-style: none;
 *       @media (forced-colors: active) {
 *         outline: 2px solid transparent;
 *         outline-offset: 2px;
 *       }
 *     }
 *
 * The forced-colors block only applies **in** forced-colors mode, where the OS
 * repaints that transparent outline. Outside it — which is nearly every user —
 * `outline-style: none` removes the outline exactly as `outline-none` does. So
 * `outline-hidden` is the HCM-*safe* way to remove an outline, not a way to keep
 * one, and an element using it still owes everyone else a replacement indicator.
 *
 * Dropping it from this list would have created the precise false negative Rule D
 * exists to prevent: `outline-hidden focus-visible:bg-accent` would pass while
 * giving an ordinary user a 1.07:1 background swap and nothing else. Nothing in
 * the tree uses `outline-hidden` today, so this is future-proofing — and the
 * permissive direction is the expensive one to get wrong.
 */
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
  // Every width family matches `-[1-9]\d*`, never `-0`. A `-0` utility sets the
  // width to zero, so it REMOVES the edge it appears to add: `border-0`,
  // `ring-0`, `inset-ring-0` and `decoration-0` all draw nothing, and accepting
  // any of them would let a scope satisfy Rule D by painting nothing at all.
  // Duo review, !250 — `border-0` was the live hole; the others are closed the
  // same way rather than by a special case each, which is how `border-0` was
  // missed in the first place.
  //
  // A bare `ring`, `inset-ring`, `outline` or `border` is a real 1px edge, so it
  // counts. Verified against Tailwind 4.3.3 rather than assumed — all four
  // compile to the same shape, and `outline` was the odd one out here until Duo
  // review round 8 (!250) pointed out the asymmetry:
  //
  //   .outline    { outline-style: var(--tw-outline-style); outline-width: 1px }
  //   .ring       { --tw-ring-shadow: … 0 0 0 calc(1px + …) …; box-shadow: … }
  //   .border     { border-style: var(--tw-border-style); border-width: 1px }
  //   .inset-ring { inset 0 0 0 1px … }
  //
  // Requiring a numeric width for `outline` alone made `focus-visible:outline` a
  // false positive, which would have cost an allowlist entry for a perfectly good
  // indicator — and an allowlist entry nobody can defend is how an allowlist
  // stops meaning anything.
  if (/^(inset-)?ring(-[1-9]\d*)?$/.test(base)) return true;
  if (/^outline(-[1-9]\d*)?$/.test(base)) return true;
  if (/^border(-[1-9]\d*)?$/.test(base)) return true;
  // `underline` / `decoration-2` — the indicator the legal-page links use.
  if (base === "underline" || /^decoration-[1-9]\d*$/.test(base)) return true;
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
    // A killer counts whatever its variant chain — the base is what matters.
    //
    // Duo review (!250) argued a variant-prefixed killer such as
    // `hover:outline-none` leaves the focus outline unaffected and should be
    // ignored. It does not: **hover and focus co-occur constantly.** Click a
    // control and leave the pointer on it and both `:hover` and `:focus-visible`
    // apply, so `hover:outline-none` removes the outline of a focused element for
    // every mouse user — which is most of them. The same holds for
    // `dark:outline-none` (in dark mode), `sm:outline-none` (at that breakpoint)
    // and `group-hover:outline-none`. Treating every killer as a killer is the
    // conservative reading, and the permissive one has no case.
    //
    // It costs nothing today either: the tree's only variant-prefixed killer is
    // `auth-actions.tsx`'s `focus-visible:outline-none`, which is unambiguously a
    // focus-outline killer and passes the rule on its own `focus-visible:ring-2`.
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
