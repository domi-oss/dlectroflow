import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import {
  findTextContrastRisks,
  findTintedBannerText,
  findWeakFocusIndicators,
  isDarkVariant,
  scanClassScopes,
  splitVariants,
  MIN_AA_TEXT_SHADE,
} from "@/lib/a11y-class-hygiene";

/**
 * #109 / #117 — the WCAG-AA gate for state-dependent styling.
 *
 * The premise of both issues is that **a green a11y suite means "the gate could
 * not see this", not "this is fine"**:
 *
 *  * #109's eight sites were all data- or state-dependent. `use-save-status.tsx`
 *    only paints its green while a save is in flight; `aging-section.tsx` only
 *    paints its amber when a demo override is set; `login/page.tsx` only paints
 *    its red on an error redirect. axe measured none of them, so `/settings`,
 *    `/login` and `/` all passed their zero-tolerance contrast gates while
 *    failing AA in a state a real user reaches.
 *  * #117's menu-entry focus indicator is invisible to axe for a different
 *    reason: **axe ships no rule for any of WCAG 2.2's focus criteria** — that
 *    alone is why no fixture would have caught it, and it is measured in
 *    `a11y-class-hygiene.ts`'s header rather than asserted. The e2e runs asking
 *    for 2.0/2.1 tags only is a second and independent reason, and that header
 *    shows it holds by example — axe's one WCAG 2.2 rule is not selected — rather
 *    than by assumption. The three criteria and their levels are set out at
 *    `findWeakFocusIndicators`; this docblock used to cite the wrong one of them
 *    (#258).
 *
 * !188 fixed #95 by seeding the state — backdating a library row by 13 hours so
 * the amber existed during the scan. That works, and it is the right tool for a
 * *composition* failure, but it costs a fixture per state and catches the
 * instance rather than the class. Which is why !188's own sweep then found eight
 * more, and why this file found a ninth (`task-schedule.tsx:135`) that neither
 * issue's inventory had.
 *
 * This is the cheap half: read the class strings out of the source and assert
 * shade discipline. It runs in the unit job, in under a second, with no browser
 * and no database, and it fails on the *class* — so the next redesign cannot
 * reintroduce it.
 *
 * ── If this fails ──────────────────────────────────────────────────────────
 * The repo drifted; fix the drift, do not relax the test. Both allowlists below
 * take an explicit reason, and adding an entry is an accessibility decision that
 * has to be argued for in review — the same contract `REVIEWED_DYNAMIC_HOSTS`
 * carries in `fetch-host-hygiene.test.ts`.
 *
 * ── What this cannot see ───────────────────────────────────────────────────
 * `a11y-class-hygiene.ts`'s header lists the four gaps in full. The one worth
 * repeating here, because it bit this very MR: a correct token pair can still
 * fail once composed. `text-green-700 dark:text-green-400` on a
 * `bg-green-600/10` tint measures **4.16:1** in light, and this file passes it.
 * Measured composition is `e2e/a11y-contrast.spec.ts`'s job.
 */

// ── Reviewed text colours ──────────────────────────────────────────────────
//
// Sites where a sub-`-700` chromatic text colour, or a `-700`+ with no `dark:`
// partner, is nonetheless AA. Keyed by `<file>:<token>` rather than by line
// number, so the map does not rot when a component moves — the failure mode that
// made the SAST rule in #83 unusable.
//
// A defensible reason states the MEASURED ratio and the background it was
// measured against. "Looks fine" is not a reason. Empty today: every site in the
// tree either passes the rule or was fixed.
//
// ── The key's known trade-off, and what bounds it ──────────────────────────
// `<file>:<token>` is coarser than `<file>:<line>:<token>`: it excuses EVERY
// occurrence of that token in that file, so a second, unjustified use could
// shelter behind a reviewed first one. Duo review raised this on !250, correctly,
// as informational.
//
// Keying by line is not the fix — a line-keyed map rots on every move, which is
// the exact failure that made #83's SAST rule unusable and the reason this map is
// shaped the way it is. Instead the risk is made visible: `expectNoStaleEntries`
// asserts each key excuses **exactly one** finding, so a second occurrence fails
// the suite and has to be argued for rather than inherited. If two really are
// justified, that is a deliberate edit to the assertion with the reason to match.
const REVIEWED_TEXT_COLORS: Record<string, string> = {};

// ── Reviewed focus indicators ──────────────────────────────────────────────
//
// Elements that remove the UA focus outline and replace it with something this
// module cannot recognise as an indicator. A reason has to say what the visible
// indicator IS and its contrast against both adjacent colours — which is WCAG
// 1.4.11 Non-text Contrast, the AA criterion that puts 3:1 under the visual
// information identifying a state. (Cited as "2.4.11" until #258; that is Focus
// Not Obscured, a question about stacking order, and nothing here measures it.)
// Empty today.
const REVIEWED_FOCUS_INDICATORS: Record<string, string> = {};

// ── Scope ──────────────────────────────────────────────────────────────────
//
// `src/` only. `e2e/` holds assertions ABOUT these classes (a spec that names
// `text-amber-600` to prove it is gone would otherwise be a finding), and it
// never renders to a user. Test files are excluded for the same reason, and it
// is not hypothetical: `inbox-view.test.tsx`, `row-actions.test.tsx` and
// `library-row-meta.test.tsx` all assert `not.toContain("text-amber-600")`.
const SCANNED_ROOT = "src";

// The guard cannot scan itself: `OUTLINE_KILLERS = ["outline-none", …]` is a
// `const` initialiser holding the very class names it bans, so the scanner reads
// its own rule table as an element's class list and reports it. Excluding the
// module is the honest fix; the alternative — "an array literal is data, not
// classes" — would silently stop checking any real class array elsewhere in the
// tree. This file has no JSX and ships no markup, so nothing is lost.
const SELF = path.join(SCANNED_ROOT, "lib", "a11y-class-hygiene.ts");

function scannedFiles(): string[] {
  const entries = readdirSync(SCANNED_ROOT, {
    recursive: true,
    encoding: "utf8",
  });
  const files: string[] = [];
  for (const entry of entries) {
    if (!/\.(ts|tsx|mts)$/.test(entry)) continue;
    if (/\.test\.(ts|tsx)$/.test(entry)) continue;
    const file = path.join(SCANNED_ROOT, entry);
    if (file === SELF) continue;
    files.push(file);
  }
  return files;
}

type Scan = (
  source: string,
  fileName: string,
) => { line: number; token: string; reason: string }[];

/**
 * Every finding in the real tree, as an allowlist key plus a readable message.
 *
 * Both are returned rather than just the message, so the stale-allowlist guard
 * below can compare real keys instead of parsing them back out of prose. (Duo
 * suggested a regex over the formatted line; a guard whose correctness depends on
 * a message's punctuation is a guard that breaks when someone rewords it.)
 */
function repoFindings(scan: Scan): { key: string; message: string }[] {
  const found: { key: string; message: string }[] = [];
  for (const file of scannedFiles()) {
    for (const finding of scan(readFileSync(file, "utf8"), file)) {
      found.push({
        key: `${file}:${finding.token}`,
        message: `${file}:${finding.line} — ${finding.reason}`,
      });
    }
  }
  return found;
}

/** Findings the reviewed map does not excuse, as readable lines. */
function repoOffenders(scan: Scan, reviewed: Record<string, string>): string[] {
  return repoFindings(scan)
    .filter(({ key }) => !reviewed[key])
    .map(({ message }) => message);
}

/**
 * A stale exemption reads like considered coverage. Every key must still name
 * something the scanner actually flags, and every reason must be long enough to
 * be a reason — the same two assertions `fetch-host-hygiene.test.ts` makes about
 * `REVIEWED_DYNAMIC_HOSTS`.
 *
 * Both maps are empty today, so this passes trivially. That is the point: it is
 * armed before the first entry is added, not after somebody notices the first
 * entry outlived its bug. Raised by Duo review on !250.
 */
function expectNoStaleEntries(
  scan: Scan,
  reviewed: Record<string, string>,
  mapName: string,
): void {
  const found = repoFindings(scan);
  const live = new Set(found.map(({ key }) => key));
  for (const [key, reason] of Object.entries(reviewed)) {
    expect(live, `${mapName}: ${key} is no longer flagged`).toContain(key);
    expect(
      reason.length,
      `${mapName}: ${key} needs a real reason with a measured ratio`,
    ).toBeGreaterThan(40);
    // The key is `<file>:<token>`, so it excuses every occurrence of that token
    // in that file. Asserting exactly one keeps a second, unreviewed use from
    // sheltering behind a reviewed first one — the coarseness Duo flagged on
    // !250. Two genuinely-justified occurrences are still possible, but only as a
    // deliberate edit here with the reason to match, not by inheritance.
    expect(
      found.filter((f) => f.key === key).length,
      `${mapName}: ${key} now excuses more than one finding — review each`,
    ).toBe(1);
  }
}

// ── The parser, on synthetic input ─────────────────────────────────────────

describe("scanClassScopes", () => {
  it("unions the tokens of one className across cn() arguments and both ternary arms", () => {
    const scopes = scanClassScopes(
      `const x = <p className={cn("text-xs", aging ? "text-amber-700 dark:text-amber-400" : "text-muted-foreground")} />;`,
    );
    expect(scopes).toHaveLength(1);
    expect(scopes[0].tokens).toEqual([
      "text-xs",
      "text-amber-700",
      "dark:text-amber-400",
      "text-muted-foreground",
    ]);
  });

  it("treats an object property as its own scope (the FRESHNESS_TIER_STYLE shape)", () => {
    const scopes = scanClassScopes(
      `const S = { aging: { dot: "🟡", color: "text-amber-700 dark:text-amber-400" } };`,
      "input.ts",
    );
    // `dot` holds an emoji, which is not a class list, so only `color` scopes.
    expect(scopes.map((s) => s.tokens)).toContainEqual([
      "text-amber-700",
      "dark:text-amber-400",
    ]);
  });

  it("treats a shared class constant as a scope (account-menu's `entry`)", () => {
    const scopes = scanClassScopes(
      `const entry = "flex px-3 outline-none focus-visible:bg-accent";`,
      "input.ts",
    );
    expect(scopes).toHaveLength(1);
    expect(scopes[0].tokens).toContain("outline-none");
  });

  it("does not let a nested element's classes leak into the enclosing attribute", () => {
    // `headingExtras={<span className="text-amber-600" />}` — if the two scopes
    // merged, an unrelated sibling's `dark:` partner would satisfy Rule B for
    // the span. This is the aging-section.tsx shape.
    const scopes = scanClassScopes(
      `const x = <Section headingExtras={<span className="text-amber-700" />} className="dark:text-amber-400" />;`,
    );
    const tokenSets = scopes.map((s) => s.tokens);
    expect(tokenSets).toContainEqual(["text-amber-700"]);
    expect(tokenSets).toContainEqual(["dark:text-amber-400"]);
  });

  it("reads the literal spans of a template, so an interpolation does not hide the rest", () => {
    const scopes = scanClassScopes(
      "const x = <div className={`text-2xl font-semibold ${accent ?? ''}`} />;",
    );
    expect(scopes[0].tokens).toEqual(["text-2xl", "font-semibold"]);
  });

  it("accepts every character class strings really contain", () => {
    // Pins the utility-shape character class after the hyphen moved to the front
    // of it (Duo review, !250 — literal in both positions, but only obviously so
    // in one). Each of these appears in the real tree.
    const scopes = scanClassScopes(
      `const x = <div className="min-h-[44px] bg-[color:var(--tick-color)] data-[highlighted]:bg-accent bg-green-600/10 [&_svg]:size-4 active:not-aria-[haspopup]:translate-y-px" />;`,
    );
    expect(scopes).toHaveLength(1);
    expect(scopes[0].tokens).toEqual([
      "min-h-[44px]",
      "bg-[color:var(--tick-color)]",
      "data-[highlighted]:bg-accent",
      "bg-green-600/10",
      "[&_svg]:size-4",
      "active:not-aria-[haspopup]:translate-y-px",
    ]);
  });

  it("ignores class names that appear only in a comment", () => {
    // Not hypothetical: status-pill.tsx and inbox-view.tsx both name
    // `text-amber-600` in a comment documenting the bug they fixed. A regex
    // reports two findings that do not exist.
    expect(
      scanClassScopes(
        `// the old flat \`text-amber-600\` dropped to 3:1\nconst a = 1;`,
        "input.ts",
      ),
    ).toEqual([]);
  });
});

describe("splitVariants", () => {
  // Exported so no caller reaches for a `startsWith("dark:")` prefix test. That
  // shortcut reads a compound chain as a non-match, which is how the
  // `dark:hover:bg-*` bug reached review on !250.
  it("returns the whole variant chain, not just the first", () => {
    expect(splitVariants("dark:hover:bg-amber-950/20")).toEqual({
      variants: ["dark", "hover"],
      base: "bg-amber-950/20",
    });
  });

  it("leaves an unprefixed utility alone", () => {
    expect(splitVariants("text-amber-700")).toEqual({
      variants: [],
      base: "text-amber-700",
    });
  });

  it("does not split on a colon inside an arbitrary variant or value", () => {
    expect(splitVariants("data-[highlighted]:bg-accent")).toEqual({
      variants: ["data-[highlighted]"],
      base: "bg-accent",
    });
    expect(splitVariants("[&:has(:focus)]:ring-2")).toEqual({
      variants: ["[&:has(:focus)]"],
      base: "ring-2",
    });
    expect(splitVariants("bg-[color:var(--x)]")).toEqual({
      variants: [],
      base: "bg-[color:var(--x)]",
    });
  });
});

describe("isDarkVariant", () => {
  // The whole point of this function existing. Three call sites hand-rolled
  // `startsWith("dark:bg-")` / `("dark:text-")` and Duo review found the same bug
  // in each across rounds 4, 5 and 7 of !250. Three identical bugs from three
  // copies is a missing function, not three mistakes.
  it("matches a compound variant chain, which a `dark:` prefix test does not", () => {
    for (const token of [
      "dark:hover:bg-amber-950/20",
      "dark:sm:bg-amber-950/20",
      "dark:focus-visible:bg-accent",
    ]) {
      expect(isDarkVariant(token, "bg-"), token).toBe(true);
      // The shortcut this replaces, shown failing on the same input.
      expect(token.startsWith("dark:bg-"), token).toBe(false);
    }
  });

  it("matches the simple form too", () => {
    expect(isDarkVariant("dark:text-green-400", "text-")).toBe(true);
    expect(isDarkVariant("dark:text-green-400", "text-green-")).toBe(true);
  });

  it("does not match a light-mode utility or another family", () => {
    expect(isDarkVariant("text-green-400", "text-")).toBe(false);
    expect(isDarkVariant("hover:text-green-400", "text-")).toBe(false);
    expect(isDarkVariant("dark:text-green-400", "text-red-")).toBe(false);
    expect(isDarkVariant("dark:bg-green-950", "text-")).toBe(false);
  });

  it("is not fooled by a variant merely containing 'dark'", () => {
    // `darker:` is not `dark:`, and an exact chain-member check is what makes
    // that true — another thing a prefix test gets wrong.
    expect(isDarkVariant("darker:text-green-400", "text-")).toBe(false);
  });
});

// ── Rule A / B: text colour ────────────────────────────────────────────────

describe("findTextContrastRisks", () => {
  it("rejects a bare chromatic -600 as text (3.00-4.48:1 on the light background)", () => {
    const findings = findTextContrastRisks(
      `const x = <p className="text-xs text-green-600 dark:text-green-400" />;`,
    );
    expect(findings).toHaveLength(1);
    expect(findings[0].token).toBe("text-green-600");
    // A `dark:` partner does not rescue it — the LIGHT theme has no fallback.
    expect(findings[0].reason).toContain("light --background");
  });

  it("rejects text-red-500, which reads 3.59:1 and looks fine by eye", () => {
    expect(
      findTextContrastRisks(
        `const x = <p className="text-sm text-red-500" />;`,
      ),
    ).toHaveLength(1);
  });

  it("accepts the repo's tuned pair", () => {
    expect(
      findTextContrastRisks(
        `const x = <p className="text-amber-700 dark:text-amber-400" />;`,
      ),
    ).toEqual([]);
  });

  it("rejects a -700 with no dark: partner (2.34-3.97:1 on the dark background)", () => {
    const findings = findTextContrastRisks(
      `const x = <p className="text-sm font-medium text-green-700" />;`,
    );
    expect(findings).toHaveLength(1);
    // The remedy names the family, so it can be pasted rather than worked out.
    expect(findings[0].reason).toContain("dark:text-green-*");
  });

  it("waives the dark: partner when the scope pins its own OPAQUE background", () => {
    // integrations-panel.tsx's status pill: green-800 on green-100 is 6.45:1 and
    // neither token moves with the theme.
    expect(
      findTextContrastRisks(
        `const p = tone === "ok" ? "bg-green-100 text-green-800" : "bg-red-100 text-red-700";`,
        "input.ts",
      ),
    ).toEqual([]);
  });

  it.each(["bg-white", "bg-black"])(
    "waives the partner for %s, a fixed value the theme cannot move",
    (bg) => {
      // Duo review, !250. These carry no shade number, so the shade-shaped
      // pattern missed them — but "does not move with the theme" is the only
      // property the carve-out depends on, and a fixed sRGB value has it.
      expect(
        findTextContrastRisks(
          `const x = <p className="${bg} text-green-700" />;`,
        ),
        bg,
      ).toEqual([]);
    },
  );

  it.each(["bg-white/10", "bg-black/50"])(
    "does NOT waive it for %s, which the theme still shows through",
    (bg) => {
      // Both of these are real occurrences in the tree, and both are washes over
      // whatever is behind them — the same reason `bg-green-600/10` is excluded.
      expect(
        findTextContrastRisks(
          `const x = <p className="${bg} text-green-700" />;`,
        ),
        bg,
      ).toHaveLength(1);
    },
  );

  it("does NOT waive it for a translucent tint, which the theme still shows through", () => {
    // `(app)/page.tsx`'s Google banners: bg-green-600/10 over --background is
    // still dark in dark mode, and text-green-700 measures 3.62:1 there.
    const findings = findTextContrastRisks(
      `const x = <div className="border border-green-600/30 bg-green-600/10 text-sm text-green-700" />;`,
    );
    expect(findings).toHaveLength(1);
    expect(findings[0].token).toBe("text-green-700");
  });

  it("re-requires a partner when the pinned background itself has a dark: variant", () => {
    const findings = findTextContrastRisks(
      `const x = <p className="bg-amber-50 text-amber-800 dark:bg-amber-950" />;`,
    );
    expect(findings).toHaveLength(1);
  });

  it("leaves neutral families alone — text-gray-600 is ~7:1, so banning it would be a false positive", () => {
    expect(
      findTextContrastRisks(`const x = <p className="text-gray-600" />;`),
    ).toEqual([]);
  });

  it("ignores a dark:-prefixed light shade, which is the correct partner", () => {
    expect(
      findTextContrastRisks(`const x = <p className="dark:text-green-400" />;`),
    ).toEqual([]);
  });

  it("names the floor in the remedy so the message is actionable", () => {
    const [finding] = findTextContrastRisks(
      `const x = <p className="text-emerald-600" />;`,
    );
    expect(finding.reason).toContain(`text-emerald-${MIN_AA_TEXT_SHADE}`);
  });

  // Two shapes that do not exist in the tree today. That is the point: the eight
  // sites #109 inventoried did not exist either, until somebody wrote one. A rule
  // that only covers the syntax already in use catches the instance, not the
  // class — which is what this whole file exists to stop.
  it("catches a sub-AA colour hidden behind a non-dark variant", () => {
    // `hover:` and `sm:` both paint in the light theme, and WCAG makes no
    // allowance for "only while pointing at it".
    for (const token of ["hover:text-amber-600", "sm:text-red-500"]) {
      const findings = findTextContrastRisks(
        `const x = <p className="${token}" />;`,
      );
      expect(findings, token).toHaveLength(1);
      expect(findings[0].token).toBe(token);
    }
  });

  it("catches an /alpha modifier, which a $-anchored shade regex would let past", () => {
    // Fading a text colour blends it toward the background, so it can only be
    // worse than the opaque shade — and 700 is already the floor.
    const findings = findTextContrastRisks(
      `const x = <p className="text-red-800/70 dark:text-red-400" />;`,
    );
    expect(findings).toHaveLength(1);
    expect(findings[0].reason).toContain("fades the text");
  });

  it("does not double-report an alpha shade as also being too light", () => {
    expect(
      findTextContrastRisks(`const x = <p className="text-red-500/70" />;`),
    ).toHaveLength(1);
  });

  it("does not let one family's dark: partner clear another family's token", () => {
    // Duo review, !250. A scope-level "some dark text exists" flag passed
    // `text-red-700` here because `dark:text-green-400` was in the same scope —
    // a real false negative, and exactly the shape a per-scope boolean invites.
    const findings = findTextContrastRisks(
      `const x = <p className="text-green-700 text-red-700 dark:text-green-400" />;`,
    );
    expect(findings).toHaveLength(1);
    expect(findings[0].token).toBe("text-red-700");
    expect(findings[0].reason).toContain("dark:text-red-*");
  });

  it("accepts two families when each has its own partner (the people-panel shape)", () => {
    expect(
      findTextContrastRisks(
        `const c = tone === "error" ? "text-red-700 dark:text-red-400" : "text-green-700 dark:text-green-400";`,
        "input.ts",
      ),
    ).toEqual([]);
  });

  it("accepts a dark partner at any shade of the same family", () => {
    // `people-panel.tsx` pairs `text-red-800` with `dark:text-red-200`, and
    // `inbox-view.tsx` pairs `text-amber-800` with `dark:text-amber-300`. The
    // rule is that a partner EXISTS for that family, not which shade it is.
    expect(
      findTextContrastRisks(
        `const x = <p className="text-amber-800 dark:text-amber-300" />;`,
      ),
    ).toEqual([]);
  });

  it("does not demand a dark: partner for a variant-prefixed colour", () => {
    // Rule B is about the RESTING light value a `dark:` partner overrides.
    // Whether `hover:text-green-700` and `dark:text-green-400` resolve in the
    // right order is a Tailwind variant-ordering question this module has not
    // established, so it does not assert on it. Rule A still covers the shade.
    expect(
      findTextContrastRisks(
        `const x = <p className="hover:text-green-700" />;`,
      ),
    ).toEqual([]);
  });
});

// ── Rule C: the tinted-banner shape ───────────────────────────────────────

describe("findTintedBannerText", () => {
  it("reports the chromatic text sitting on a translucent chromatic tint", () => {
    // The `(app)/page.tsx` banner shape. Its token pair can be correct and its
    // composite ratio still fail — green-700 is 4.65:1 on the bare light
    // --background and 4.16:1 once the banner's own /10 tint is in the way.
    const found = findTintedBannerText(
      `const x = <div className="rounded-lg border border-green-600/30 bg-green-600/10 text-sm text-green-800 dark:text-green-400" />;`,
    );
    expect(found.map((f) => f.token)).toEqual(["text-green-800"]);
  });

  it("ignores an OPAQUE coloured background, which pins its own ratio", () => {
    // `integrations-panel.tsx`'s pill: bg-green-100 does not composite over
    // --background, so the tint reasoning does not apply to it.
    expect(
      findTintedBannerText(
        `const p = "bg-green-100 text-green-800";`,
        "input.ts",
      ),
    ).toEqual([]);
  });

  it("ignores a scope that supplies its own dark background", () => {
    // `guest-indicator.tsx`: it composites over a background it chose, so the
    // tone table's measured ratios say nothing about it.
    expect(
      findTintedBannerText(
        `const x = <div className="bg-amber-500/10 text-amber-800 dark:bg-amber-950/20 dark:text-amber-300" />;`,
      ),
    ).toEqual([]);
  });

  it("recognises a COMPOUND dark variant as a dark background", () => {
    // Duo review round 4, !250. This was a `token.startsWith("dark:bg-")` prefix
    // test, which reads `dark:hover:bg-*` as not-a-dark-background and reported
    // the scope anyway. Fixed by going through `splitVariants`, and asserted here
    // for both orderings because the variant chain's order is the author's choice.
    for (const dark of [
      "dark:hover:bg-amber-950/20",
      "dark:sm:bg-amber-950/20",
    ]) {
      expect(
        findTintedBannerText(
          `const x = <div className="bg-amber-500/10 text-amber-800 ${dark}" />;`,
        ),
        dark,
      ).toEqual([]);
    }
  });

  it("does not treat a non-palette tint as a banner", () => {
    expect(
      findTintedBannerText(
        `const x = <div className="bg-primary/10 text-amber-800" />;`,
      ),
    ).toEqual([]);
  });

  it("does not report a variant-prefixed text colour on a tint", () => {
    // Rule A already covers `hover:text-*`; this rule is about the resting value
    // whose composite ratio the tone table measured.
    expect(
      findTintedBannerText(
        `const x = <div className="bg-green-600/10 hover:text-green-800" />;`,
      ),
    ).toEqual([]);
  });
});

// ── Rule D: focus indicator ────────────────────────────────────────────────

describe("findWeakFocusIndicators", () => {
  it("rejects outline-none whose only focus treatment is a background swap (#117)", () => {
    const findings = findWeakFocusIndicators(
      `const entry = "flex px-3 outline-none hover:bg-accent focus-visible:bg-accent focus-visible:text-primary";`,
      "input.ts",
    );
    expect(findings).toHaveLength(1);
    // The criterion a colour swap misses is **2.4.13 Focus Appearance (AAA)** —
    // it has no indicator area and no focused/unfocused contrast. Re-pointed
    // from "2.4.11" by #258, which was the wrong number AND the wrong level; the
    // message now has to carry the level too, because "you are failing AA" and
    // "you are below a bar this project chose" are different instructions.
    expect(findings[0].reason).toContain("2.4.13");
    expect(findings[0].reason).toContain("AAA");
    expect(findings[0].reason).toContain("focus-visible:bg-accent");
    // And it must not let "AAA" be read as "optional", which is #258's own
    // defect mirrored. 1.4.11 Non-text Contrast is **AA** and, per the W3C's
    // Understanding note, it governs an author-drawn focus indicator's 3:1
    // against adjacent colours — the exemption is for a UA-drawn one, and this
    // branch fires precisely when the author replaced it. So a hue-only
    // indicator is very likely an AA failure as well; told only "AAA, a bar this
    // repo chose", a developer allowlists it and ships one.
    //
    // The message must still not ASSERT the AA failure: per gap 1 this module
    // measures no ratio. Naming the criterion and saying the gate cannot read it
    // leaves the question open, which is the honest position and the one the
    // docblock takes.
    expect(findings[0].reason).toContain("1.4.11 Non-text Contrast");
    expect(findings[0].reason).toContain("which is AA");
    expect(findings[0].reason).toContain("cannot measure");
  });

  it("states no measured ratio, because the gate measures none (Duo, !340)", () => {
    // This `reason` is returned for EVERY colour-only violation, so anything in
    // it specific to one historical site is a claim about a finding the gate
    // never looked at. The wording before this test ended "because #117's swap
    // measured 1.07:1" — for a new violation in an unrelated file that figure is
    // inherited, unmeasurable by this module, and unfalsifiable by the person
    // reading it while trying to fix their own code.
    //
    // #258 was a criterion number that did not match what was measured. A
    // measurement that does not match what was examined is the same defect one
    // level down, and harder to catch, because a wrong number at least looks
    // like a number somebody could check. Raised by Duo review on !340.
    //
    // Asserted on the WHOLE string, not by substring. The wrap fixtures further
    // down this file are the reason: a control that only checks the parts it
    // remembers to name lets a ratio creep back in beside them.
    const findings = findWeakFocusIndicators(
      `const x = <button className="rounded outline-none focus-visible:bg-muted" />;`,
      "some-unrelated-component.tsx",
    );
    expect(findings).toHaveLength(1);
    expect(findings[0].reason).not.toContain("#117");
    expect(findings[0].reason).not.toContain("1.07");
    // No ratio of any kind. Thresholds live in the docblock with the criteria
    // they belong to; in a per-finding message a bare "3:1" reads as something
    // this gate compared against, and it compared against nothing.
    expect(findings[0].reason).not.toMatch(/\d+(\.\d+)?\s*:\s*1\b/);
    expect(findings[0].reason).toBe(
      "`outline-none` removes the UA focus outline and the only focus treatment left is a colour swap (focus-visible:bg-muted); a hue change carries no indicator area and no focused/unfocused contrast, so it engages WCAG 2.4.13 Focus Appearance, which is AAA, and WCAG 1.4.11 Non-text Contrast, which is AA and therefore not optional. This gate cannot measure a contrast ratio, so whether either threshold is met here is unknown and a human has to check. Add `focus-visible:inset-ring-2 focus-visible:inset-ring-ring`",
    );
  });

  it("accepts outline-none paired with a focus ring (the repo's trigger convention)", () => {
    expect(
      findWeakFocusIndicators(
        `const x = <button className="rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2" />;`,
      ),
    ).toEqual([]);
  });

  it("accepts an inset ring, which is what a flush popup entry needs", () => {
    expect(
      findWeakFocusIndicators(
        `const entry = "outline-none focus-visible:bg-accent focus-visible:inset-ring-2 focus-visible:inset-ring-ring";`,
        "input.ts",
      ),
    ).toEqual([]);
  });

  it("accepts focus-visible:underline, which legal-page links use", () => {
    expect(
      findWeakFocusIndicators(
        `const x = <a className="outline-none focus-visible:underline" />;`,
      ),
    ).toEqual([]);
  });

  it("does not accept a ring COLOUR with no ring width", () => {
    // `focus-visible:ring-ring` alone paints nothing. Every passing site in the
    // tree pairs it with a width, so requiring the width costs nothing.
    const findings = findWeakFocusIndicators(
      `const x = <a className="outline-none focus-visible:ring-ring" />;`,
    );
    expect(findings).toHaveLength(1);
  });

  it("does not accept ring-0 or a re-removed outline", () => {
    expect(
      findWeakFocusIndicators(
        `const x = <a className="outline-none focus-visible:ring-0 focus-visible:outline-none" />;`,
      ),
    ).toHaveLength(1);
  });

  // Duo review, !250: `border-0` slipped the rule, because `border(-\d+)?`
  // accepts it. A `-0` width utility REMOVES the edge it looks like it adds, so a
  // scope could satisfy Rule D — and appear to satisfy 2.4.7 Focus Visible —
  // while painting nothing at all. Every width family is
  // asserted, not just the one that was reported — `border-0` was missed
  // precisely because the others were closed by special case, one at a time.
  it.each([
    "focus-visible:border-0",
    "focus-visible:ring-0",
    "focus-visible:inset-ring-0",
    "focus-visible:outline-0",
    "focus-visible:decoration-0",
  ])("rejects %s, which sets a width of zero and draws nothing", (token) => {
    expect(
      findWeakFocusIndicators(
        `const x = <a className="outline-none ${token}" />;`,
      ),
      token,
    ).toHaveLength(1);
  });

  it.each([
    "focus-visible:border",
    "focus-visible:border-2",
    "focus-visible:ring",
    "focus-visible:inset-ring",
    "focus-visible:inset-ring-4",
    // Bare `outline` was rejected until Duo review round 8, !250. Tailwind 4.3.3
    // compiles it to `outline-width: 1px` — the same shape as bare `ring` and
    // bare `border`, both of which were already accepted. The asymmetry made a
    // perfectly good indicator a false positive, and an allowlist entry nobody
    // can defend is how an allowlist stops meaning anything.
    "focus-visible:outline",
    "focus-visible:outline-2",
    "focus-visible:decoration-2",
  ])("accepts %s, which draws a real edge", (token) => {
    expect(
      findWeakFocusIndicators(
        `const x = <a className="outline-none ${token}" />;`,
      ),
      token,
    ).toEqual([]);
  });

  it("does not accept a 10-wide ring being mistaken for ring-1 then a zero", () => {
    // Guards the `[1-9]\d*` shape itself: `ring-10` must still pass, so the
    // "no zero" rule cannot have been written as `[1-9]` alone.
    expect(
      findWeakFocusIndicators(
        `const x = <a className="outline-none focus-visible:ring-10" />;`,
      ),
    ).toEqual([]);
  });

  it.each(["focus-visible", "focus", "focus-within"])(
    "accepts a ring under the %s variant",
    (variant) => {
      // `focus-within` is deliberately included. Duo review (!250) argued it only
      // fires for a focused CHILD, making it a false negative. Selectors Level 4
      // says otherwise — it matches "any element for which the `:focus`
      // pseudo-class applies, as well as" one with a focused descendant — and a
      // real browser agrees: with only `a:focus-within { box-shadow: … }`, a
      // directly-focused `<a>` computes that box-shadow. Removing it would have
      // made a working style need an allowlist entry.
      expect(
        findWeakFocusIndicators(
          `const x = <a className="outline-none ${variant}:ring-2 ${variant}:ring-ring" />;`,
        ),
        variant,
      ).toEqual([]);
    },
  );

  it("stays quiet about an element that keeps the UA outline", () => {
    // move-to-menu.tsx: `data-[highlighted]:bg-accent` with no outline-none, so
    // the browser's own outline still draws. Correctly not a finding.
    expect(
      findWeakFocusIndicators(
        `const x = <Item className="hover:bg-accent data-[highlighted]:bg-accent rounded px-2" />;`,
      ),
    ).toEqual([]);
  });

  // Duo review round 3, !250, argued `outline-hidden` should not count as an
  // outline-removing utility because it is "the standard technique for Windows
  // High Contrast Mode". Tailwind 4.3.3 compiles it to `outline-style: none` plus
  // a TRANSPARENT outline inside `@media (forced-colors: active)` — so outside
  // forced-colors mode, which is nearly every user, it removes the outline just
  // like `outline-none`. It is the HCM-safe way to remove an outline, not a way
  // to keep one. Locked in with a test so the argument is not re-litigated from
  // memory: dropping it would let `outline-hidden focus-visible:bg-accent` pass
  // while giving an ordinary user a 1.07:1 background swap and nothing else.
  it.each(["outline-none", "outline-hidden", "outline-0"])(
    "treats %s as removing the UA outline, so a replacement is still required",
    (killer) => {
      const findings = findWeakFocusIndicators(
        `const x = <a className="${killer} focus-visible:bg-accent" />;`,
      );
      expect(findings, killer).toHaveLength(1);
      expect(findings[0].token).toBe(killer);
    },
  );

  // Duo review, !250, argued a variant-prefixed killer leaves the FOCUS outline
  // alone and should be ignored. Dismissed: hover and focus co-occur constantly —
  // click a control and leave the pointer on it and both `:hover` and
  // `:focus-visible` apply, so `hover:outline-none` removes a focused element's
  // outline for every mouse user. Same for `dark:` (in dark mode) and `sm:` (at
  // that breakpoint). Treating every killer as a killer is the conservative
  // reading and the permissive one has no case, so it is pinned here.
  it.each([
    "hover:outline-none",
    "dark:outline-none",
    "sm:outline-none",
    "group-hover:outline-hidden",
  ])("treats %s as a killer, because it can apply while focused", (killer) => {
    const findings = findWeakFocusIndicators(
      `const x = <a className="${killer} focus-visible:bg-accent" />;`,
    );
    expect(findings, killer).toHaveLength(1);
    expect(findings[0].token).toBe(killer);
  });

  it("still passes outline-hidden once a real indicator is present", () => {
    expect(
      findWeakFocusIndicators(
        `const x = <a className="outline-hidden focus-visible:ring-2 focus-visible:ring-ring" />;`,
      ),
    ).toEqual([]);
  });

  it("reports an outline-none with no focus treatment at all", () => {
    const findings = findWeakFocusIndicators(
      `const x = <a className="rounded outline-none" />;`,
    );
    expect(findings).toHaveLength(1);
    expect(findings[0].reason).toContain("no visible focus indicator");
    // #258 — the two messages must name DIFFERENT criteria, because the two
    // failures are different: nothing at all is 2.4.7 Focus Visible, which is AA
    // and non-negotiable; a colour swap is 2.4.13, which is AAA and a project
    // choice. A developer acts differently on those two, so a message that
    // blurred them would be the defect #258 fixed, reintroduced.
    expect(findings[0].reason).toContain("2.4.7");
    expect(findings[0].reason).toContain("AA");
    expect(findings[0].reason).not.toContain("2.4.13");
  });
});

// ── The real tree ──────────────────────────────────────────────────────────

describe("src/ WCAG-AA class hygiene (#109, #117)", () => {
  it("actually reaches the classes it is meant to police", () => {
    // Guards the guard. A path change, a syntax-kind mistake or an over-eager
    // exclusion would make every assertion below pass by measuring nothing —
    // which is the failure mode that let eight of these ship in the first place.
    //
    // Counted, not guessed (2026-08-03): 1263 class-bearing scopes, 25 carrying
    // `outline-none`, 32 carrying a `dark:text-*` partner. The floors are set
    // well below those so ordinary churn does not trip them, but a scan that
    // stopped seeing `outline-none` or `dark:` — the two tokens Rules B and D are
    // built on — could no longer report a clean run as meaningful.
    const scopes = scannedFiles().flatMap((file) =>
      scanClassScopes(readFileSync(file, "utf8"), file),
    );
    expect(scopes.length).toBeGreaterThan(800);
    expect(
      scopes.filter((s) => s.tokens.includes("outline-none")).length,
    ).toBeGreaterThan(15);
    expect(
      scopes.filter((s) => s.tokens.some((t) => isDarkVariant(t, "text-")))
        .length,
    ).toBeGreaterThan(20);
  });

  it("still SEES the pattern it bans (the scanner is not a no-op)", () => {
    // Paired with the count above: proves a non-zero result is reachable, so a
    // clean run below means "looked and found nothing", not "looked at nothing".
    expect(
      findTextContrastRisks(`const x = <p className="text-amber-600" />;`),
    ).toHaveLength(1);
    expect(
      findWeakFocusIndicators(
        `const x = <a className="outline-none focus-visible:bg-muted" />;`,
      ),
    ).toHaveLength(1);
  });

  it("keeps no stale entry in either reviewed map", () => {
    expectNoStaleEntries(
      findTextContrastRisks,
      REVIEWED_TEXT_COLORS,
      "REVIEWED_TEXT_COLORS",
    );
    expectNoStaleEntries(
      findWeakFocusIndicators,
      REVIEWED_FOCUS_INDICATORS,
      "REVIEWED_FOCUS_INDICATORS",
    );
  });

  it("uses no sub-AA chromatic text colour, and no un-partnered -700 (#109)", () => {
    expect(repoOffenders(findTextContrastRisks, REVIEWED_TEXT_COLORS)).toEqual(
      [],
    );
  });

  it("replaces every removed focus outline with a real indicator (#117, WCAG 2.4.7)", () => {
    expect(
      repoOffenders(findWeakFocusIndicators, REVIEWED_FOCUS_INDICATORS),
    ).toEqual([]);
  });
});

// ── Criterion citations ────────────────────────────────────────────────────
//
// #258 — the three focus criteria of WCAG 2.2, read off the specification rather
// than recalled:
//
//   2.4.7   Focus Visible                  AA    (since WCAG 2.0)
//   2.4.11  Focus Not Obscured (Minimum)   AA    (new in 2.2)
//   2.4.13  Focus Appearance               AAA   (new in 2.2)
//
// So "2.4.11 Focus Appearance" is not a criterion at all: it welds one
// criterion's number to a different one's name. **The level then follows the
// name**, which is why this was not a typo — the weld reported a AAA bar as an AA
// obligation in five places in `a11y-class-hygiene.ts`, in `CLAUDE.md`, and in
// fourteen component comments that had copied it, before it reached a design spec
// in !332 and Duo caught it there.
//
// It is asserted mechanically rather than left as a note to be careful, because
// the propagation is the actual failure mode: every one of those fourteen sites
// was written by somebody reading a neighbouring file. The repo has already paid
// for this once in the target-size family — `note-field.tsx` and
// `row-menu-viewport-fit.spec.ts` both had to correct 2.5.8 (Minimum, AA, 24x24)
// having been cited for a voluntary 44x44, which is 2.5.5 (Enhanced, AAA).
//
// ── The invariant, and why it is not a list of banned strings ──────────────
//
// The first draft of this guard banned the two known welds by pattern, with a
// 40-character window between number and name. It reported the whole focus family
// as broken **including the corrected enumeration above**, because a list that
// names three criteria in a row puts one number within 40 characters of the next
// one's name. A guard that fires on the fix is worse than no guard: the obvious
// way to quiet it is to stop enumerating, which is exactly the prose #258 needed
// to add.
//
// So the invariant is inverted and stated positively: **where one of these
// numbers is directly followed by a criterion name, it must be its own name, and
// any level stated alongside must be its own level.** That flags every weld,
// including welds nobody has thought of yet, and it cannot fire on a correct
// citation however many are listed together.
//
// Bare numbers stay legal, deliberately. "nothing checks 2.4.11" is an honest and
// necessary sentence — this module's own gap 5 is one — and only a number wearing
// the wrong name is a defect.
//
// Numbers and levels below are from the WCAG 2.2 specification, checked for #258.
// Only criteria actually verified are policed: an unverified entry here would be
// the same defect as the one being fixed, wearing a guard's authority.
// The `(Minimum)`/`(Enhanced)` qualifier is a FIELD, not a trailing comment. It
// used to be `// (Enhanced)` beside each entry, which made it invisible to the
// guard — and the qualifier is the half this repo has already got wrong twice, in
// the target-size family named further down. `2.5.5 Target Size (Minimum)` and
// `2.4.11 Focus Not Obscured (Enhanced)` are both welds, and both passed green
// until this became data.
const CRITERION_SPEC: Record<
  string,
  { name: string; qualifier?: string; level: string }
> = {
  "1.4.11": { name: "Non-text Contrast", level: "AA" },
  "2.4.3": { name: "Focus Order", level: "A" },
  "2.4.7": { name: "Focus Visible", level: "AA" },
  "2.4.11": { name: "Focus Not Obscured", qualifier: "Minimum", level: "AA" },
  "2.4.12": { name: "Focus Not Obscured", qualifier: "Enhanced", level: "AAA" },
  "2.4.13": { name: "Focus Appearance", level: "AAA" },
  "2.5.3": { name: "Label in Name", level: "A" },
  "2.5.5": { name: "Target Size", qualifier: "Enhanced", level: "AAA" },
  "2.5.8": { name: "Target Size", qualifier: "Minimum", level: "AA" },
};

/** How a fault should name a criterion: `Focus Not Obscured (Minimum)`. */
function displayName(id: string): string {
  const spec = CRITERION_SPEC[id];
  return spec.qualifier ? `${spec.name} (${spec.qualifier})` : spec.name;
}

// A policed number, an optional `(Minimum)`/`(Enhanced)` qualifier, then a
// criterion-name-shaped phrase. The name must follow the number directly — only a
// bracket, dash, colon or comma may sit between — which is what keeps an
// enumeration legal. Ordinary prose after a number ("2.4.7 has no threshold")
// starts lowercase, captures nothing, and is skipped rather than flagged.
//
// `in` is the ONLY lowercase word allowed inside a name, because "Label in Name"
// is the only policed criterion that contains one. A first draft also allowed
// `of` and `for` on the assumption that some name would need them; none does, and
// the cost was immediate — `note-field.tsx`'s correct "WCAG 2.5.3 Label in Name
// for voice control" captured "Label in Name for" and was reported as a misweld.
// A guard's alternation is not the place for speculative generality: every extra
// word it accepts is a sentence it can misread.
//
// The leading qualifier position is kept even though nothing in the tree uses it
// (`2.4.11 (Minimum) Focus Not Obscured` — checked, zero occurrences), because
// removing it would be a change with no test able to notice.
//
// ── Stated gap: a parenthesised NAME is not policed ────────────────────────
// `WCAG 2.5.3 (Label in Name)` is how ten files in this tree write a citation,
// and this pattern does not match it at all: after the number it wants a name, and
// `(` is neither a name nor one of the four separators allowed before one. Such a
// citation is skipped, not checked — so a weld written that way would pass.
//
// Left that way deliberately rather than by oversight. Allowing an optional `(`
// around the name collides with the name-less `2.5.8 (Minimum)` shape, which three
// files use: the name group would capture "Minimum" and report a correct citation
// as a weld. Closing that needs a lookahead excluding the qualifier words, and
// every extra token this alternation accepts is a sentence it can misread — the
// `of`/`for` lesson above, which cost a false positive on the first attempt. The
// qualifier half of the risk IS covered, by {@link CITED_QUALIFIER}; the
// parenthesised-name half is not, and it is written down here so the coverage is
// not read as wider than it is.
const CITED_CRITERION =
  /\b([12]\.[45]\.\d{1,2})\s*(?:\((?:Minimum|Enhanced)\)\s*)?(?:[-—:,]\s*)?((?:Non-text|[A-Z][a-z]+)(?:[ -](?:Non-text|in|[A-Z][a-z]+)){0,3})/g;

// A qualifier sitting immediately after a matched citation, which is where every
// real one in this tree sits: `2.5.5 Target Size (Enhanced)`.
const TRAILING_QUALIFIER = /^\s*\((Minimum|Enhanced)\b/;

// The name-LESS shape, which {@link CITED_CRITERION} cannot see at all because it
// requires a name: `2.5.8 (Minimum), at 24x24`. Three scanned files use it
// (`note-field.tsx`, `shopping-list.tsx`, `row-menu-viewport-fit.spec.ts`), so a
// qualifier check that only ran after a matched name would have skipped them and
// called them clean. The inner name is optional so this also matches the shape
// with a name, which is why the results are deduplicated by offset below.
//
// `\b` rather than `\)` after the qualifier on purpose: `2.5.8 (Minimum, AA)` is
// in the tree, and a strict close would skip it.
const CITED_QUALIFIER =
  /\b([12]\.[45]\.\d{1,2})\s*(?:(?:Non-text|[A-Z][a-z]+)(?:[ -](?:Non-text|in|[A-Z][a-z]+)){0,3}\s*)?\((Minimum|Enhanced)\b/g;

/**
 * `AAA`, `AA`, or a bare `A` that is a conformance level rather than the article.
 *
 * The article is the whole difficulty. `/\b(AAA|AA|A)\b/` reports
 * "2.4.13 Focus Appearance. A hue change carries no area" as *stated here as A* —
 * and this guard reads 697 files including `CLAUDE.md` and `CHANGELOG.md`, so any
 * sentence beginning "A " within {@link LEVEL_PROXIMITY} of a citation would red
 * an unrelated author's MR. This MR rewrote fourteen such comments, so the
 * exposure was live rather than theoretical.
 *
 * Dropping the `A` alternative entirely was the other option, and it is worse: it
 * would also stop catching a AAA criterion understated as level A, which is
 * exactly the direction #258's weld failed in. The lookahead keeps that and loses
 * only `A` followed by a lowercase word — which the article always is and a level
 * almost never is. `Level A conformance` is the residual blind spot; no citation
 * in the tree is written that way, and there is no capture group so the match is
 * read whole.
 */
const STATED_LEVEL = /\bAAA\b|\bAA\b|\bA\b(?!\s+[a-z])/;

/**
 * How far after a citation a level token still counts as ITS level; beyond this it
 * belongs to somebody else's sentence.
 *
 * Named rather than inlined because it is the one magic number in this reader and
 * it was, until #258's review, the one thing with no test. See
 * "bounds the level search by index" below, which pins both the bound itself and
 * the reason the search runs over the whole remainder before being bounded.
 */
const LEVEL_PROXIMITY = 40;

/**
 * Every criterion citation in a stretch of text, with what is wrong about it and
 * where it sits.
 *
 * Returns the corrections rather than a boolean so the failure names the right
 * answer at the point of failure. A guard that says only "line 729 is wrong"
 * makes the next person repeat the specification lookup that produced #258.
 */
/**
 * Which criterion actually owns a cited name, as a clause to append.
 *
 * Every candidate, never the first of several. `2.4.13 Focus Not Obscured
 * (Enhanced)` used to be answered with *"Focus Not Obscured is 2.4.11, AA"* —
 * `find` took the first name match and ignored the qualifier, so the guard told
 * an author who meant 2.4.12 at AAA to renumber to 2.4.11 at AA. **Naming the
 * wrong answer is worse than naming none**, and this function's whole purpose per
 * {@link citationFaults} is that the failure names the right one.
 */
function ownerClause(name: string, qualifier?: string): string {
  const owners = Object.entries(CRITERION_SPEC).filter(
    ([, spec]) =>
      spec.name === name && (!qualifier || spec.qualifier === qualifier),
  );
  if (owners.length === 0) return "";
  if (owners.length === 1) {
    const [id, spec] = owners[0];
    return ` — "${displayName(id)}" is ${id}, ${spec.level}`;
  }
  // No qualifier given and the name is shared, so the citation is genuinely
  // ambiguous. Say so and list both, rather than guessing which was meant.
  return (
    ` — "${name}" is ambiguous without a qualifier: ` +
    owners
      .map(([id, spec]) => `${id} (${spec.qualifier}), ${spec.level}`)
      .join(" or ")
  );
}

function citationFaults(text: string): { offset: number; fault: string }[] {
  const faults: { offset: number; fault: string }[] = [];
  const named = new Set<number>();
  for (const match of text.matchAll(CITED_CRITERION)) {
    const [whole, number, name] = match;
    const spec = CRITERION_SPEC[number];
    if (!spec) continue;
    named.add(match.index);
    const rest = text.slice(match.index + whole.length);
    const cited = TRAILING_QUALIFIER.exec(rest)?.[1];
    if (name !== spec.name) {
      faults.push({
        offset: match.index,
        fault:
          `${number} is "${displayName(number)}" (${spec.level}), not "${name}"` +
          ownerClause(name, cited),
      });
      continue;
    }
    // Right name, wrong Minimum/Enhanced. The qualifier is what carries the level
    // in this family, so an inversion is a full weld even though the name matches:
    // `2.5.5 Target Size (Minimum)` makes a voluntary 44x44 read as the AA floor,
    // which is the correction `note-field.tsx` and `row-menu-viewport-fit.spec.ts`
    // have already had to make once each.
    if (cited && cited !== spec.qualifier) {
      faults.push({
        offset: match.index,
        fault:
          `${number} is "${displayName(number)}", not "${name} (${cited})"` +
          ownerClause(name, cited),
      });
      continue;
    }
    // The level is the half that misleads hardest, so it is checked wherever it
    // is stated: told they fail AA a developer treats it as non-negotiable, told
    // AAA they know it is a project's choice.
    //
    // Measured from the match's OWN index, not from `indexOf(name)`. Two
    // citations of the same name in one sentence — "2.5.5 Target Size (Enhanced)
    // is AAA; 2.5.8 Target Size (Minimum) is AA" — both resolve `indexOf` to the
    // first, so the second read the first one's level and was reported as wrong.
    // Pinned by HONEST #6 below.
    //
    // And searched over the whole remainder, then bounded BY INDEX, rather than
    // over a `LEVEL_PROXIMITY`-character slice: slicing first can cut the token
    // itself, leaving `AA` where `AAA` was written and reporting a correct AAA
    // citation as AA. That one is pinned by "bounds the level search by index"
    // and by nothing else — the honest fixtures cannot reach it, because
    // `faultsIn` passes only the fixture lines and the remainder is then too
    // short to run past the bound. An earlier version of this comment claimed
    // those fixtures covered it; they did not, and reverting the fix reddened
    // none of them.
    const stated = STATED_LEVEL.exec(rest);
    if (stated && stated.index < LEVEL_PROXIMITY && stated[0] !== spec.level) {
      faults.push({
        offset: match.index,
        fault: `${number} ${displayName(number)} is ${spec.level}, stated here as ${stated[0]}`,
      });
    }
  }
  // The name-less `2.5.8 (Minimum)` shape, deduplicated against the pass above so
  // one citation cannot raise two faults. Additive by construction: it can only
  // reach numbers the first pass never matched.
  for (const match of text.matchAll(CITED_QUALIFIER)) {
    const [, number, qualifier] = match;
    const spec = CRITERION_SPEC[number];
    if (!spec || named.has(match.index)) continue;
    if (qualifier !== spec.qualifier) {
      faults.push({
        offset: match.index,
        fault:
          `${number} is "${displayName(number)}", not "(${qualifier})"` +
          ownerClause(spec.name, qualifier),
      });
    }
  }
  return faults;
}

/** The faults in a synthetic snippet, as plain strings — for the controls. */
function faultsIn(...lines: string[]): string[] {
  return citationFaults(flatten(lines.join("\n")).text).map(
    ({ fault }) => fault,
  );
}

/**
 * Every file whose prose a developer reads while deciding whether a change is
 * compliant — source, specs and the repo's own docs. Wider than
 * {@link scannedFiles}, which walks `src/` only and skips tests, because the
 * mislabel spread through exactly the files that one excludes: two test
 * docblocks, an e2e spec and `CLAUDE.md`.
 */
function citationScannedFiles(): string[] {
  const files = ["CLAUDE.md", "CHANGELOG.md", "AGENTS.md", "README.md"];
  for (const root of ["src", "e2e", "docs"]) {
    for (const entry of readdirSync(root, {
      recursive: true,
      encoding: "utf8",
    })) {
      if (!/\.(ts|tsx|mts|md)$/.test(entry)) continue;
      files.push(path.join(root, entry));
    }
  }
  // This file cannot scan itself: the table above names the mislabel in order to
  // ban it, and the prose explaining why names it too. Same trade-off — and same
  // resolution — as `SELF` above, and nothing is lost, because a citation in a
  // guard's own rule table is not a citation anybody reads for guidance.
  return files.filter((file) => file !== CITATION_SELF);
}

const CITATION_SELF = path.join("src", "lib", "a11y-class-hygiene.test.ts");

/**
 * A whole file flattened to one line: comment markers and indentation stripped
 * per line, everything joined with a single space, with an index back to the
 * original line numbers.
 *
 * Matching line by line is not good enough and this is measured, not
 * hypothetical, and the numbers are the measured ones rather than the remembered
 * ones. Against `origin/main`, where **eleven** welds were live: this reader finds
 * all eleven, a per-line reader finds **ten**, and the one it misses entirely is
 * `note-field.tsx:342`, which wrapped BEFORE the name (`… WCAG 2.4.11` /
 * `// Focus Appearance …`) so no name is on the line at all.
 *
 * `add-note-button.tsx:114` wrapped INSIDE the name (`… WCAG 2.4.11 Focus` /
 * `// Appearance …`) and is **not** missed — it is flagged with a degraded
 * correction, `not "Focus"`, which reads as "rename the criterion" when the fix is
 * to renumber it. Both shapes are Prettier's `printWidth` doing its job, so a
 * per-line scan is structurally unable to police an 80-column repo; the same
 * failure as `regexp-source-hygiene`'s first version, which silently missed four
 * files and called them clean.
 *
 * An earlier version of this docblock said "six of the eight… because
 * `add-note-button.tsx` and `note-field.tsx` had both wrapped the citation" — and
 * disagreed with the fixture comment below it on all three counts. A stated
 * measurement that does not match what was measured is #258's own defect, so it is
 * corrected here rather than left as approximately right.
 *
 * The marker is stripped **before** the join, not after: stripping after leaves
 * the second line's `//` between the two halves of a wrapped name, so
 * `WCAG 2.4.11 Focus` + `// Appearance` reads as `2.4.11 Focus // Appearance` and
 * the name never matches at all.
 *
 * ── Why the whole file and not a two-line window ────────────────────────────
 * A sliding window was tried first and produced two false positives in one run,
 * both from its own edges: a citation the window cut in half reported the half
 * ("2.4.11 is not Focus"), and a level token the trailing slice cut reported the
 * fragment ("AAA" read as "A"). Each was patchable, and patching an edge case in
 * a guard's *reader* is how a guard ends up with rules nobody can predict. A
 * flattened file has no edges. The line index is the only thing a window bought,
 * and {@link Flattened.lineAt} buys it back.
 */
type Flattened = { text: string; lineAt: (offset: number) => number };

function flatten(source: string): Flattened {
  const starts: number[] = [];
  let text = "";
  for (const raw of source.split("\n")) {
    starts.push(text.length);
    text += `${raw.replace(/^\s*(\/\/|\/\*+|\*)\s*/, "").replace(/\s+/g, " ")} `;
  }
  return {
    text,
    lineAt: (offset) => {
      // The last line whose flattened text begins at or before the offset.
      // Reported 1-based, as an editor counts them.
      let line = 0;
      while (line + 1 < starts.length && starts[line + 1] <= offset) line += 1;
      return line + 1;
    },
  };
}

describe("WCAG criterion citations (#258)", () => {
  it("welds no criterion number to another criterion's name or level", () => {
    const offenders: string[] = [];
    for (const file of citationScannedFiles()) {
      const { text, lineAt } = flatten(readFileSync(file, "utf8"));
      for (const { offset, fault } of citationFaults(text)) {
        offenders.push(`${file}:${lineAt(offset)} — ${fault}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("still SEES a misweld (the citation scan is not a no-op)", () => {
    // Guards the guard, the same way the two assertions above do for the class
    // scanner. A clean run of the test above has to mean "looked and found
    // nothing" — a path typo or a broken pattern would otherwise report the repo
    // clean by reading nothing at all, which is the exact shape of failure that
    // let #109's eight sites ship green.
    expect(citationScannedFiles().length).toBeGreaterThan(300);

    // The sentence #258 was filed about, the mirrored weld, and two wrong levels
    // on otherwise correct pairs. The target-size pair is here because the same
    // weld has already cost this repo two corrections: 2.5.5 Target Size
    // (Enhanced) is AAA, and calling it AA is what makes a voluntary 44x44 read
    // as an obligation.
    //
    // Every one asserts the CORRECTION, not merely that some fault was raised.
    // `.not.toEqual([])` was the original shape and it is too weak to be worth
    // keeping anywhere in this file: all four happen to produce the right fault
    // today, but reordering `CRITERION_SPEC` would make the second blame 2.4.12
    // and the assertion would still pass. The wrap fixtures below are the case
    // where that weakness was not hypothetical.
    for (const [broken, correction] of [
      [
        ["// WCAG 2.4.11 Focus Appearance is AA in WCAG 2.2"],
        '2.4.11 is "Focus Not Obscured (Minimum)" (AA), not "Focus Appearance" — "Focus Appearance" is 2.4.13, AAA',
      ],
      [
        ["// WCAG 2.4.13 Focus Not Obscured (Minimum) is AA"],
        '2.4.13 is "Focus Appearance" (AAA), not "Focus Not Obscured" — "Focus Not Obscured (Minimum)" is 2.4.11, AA',
      ],
      [
        ["// a ring is needed for WCAG 2.4.13 Focus Appearance, which is AA"],
        "2.4.13 Focus Appearance is AAA, stated here as AA",
      ],
      [
        ["// the shared 44x44 floor, WCAG 2.5.5 Target Size, which is AA"],
        "2.5.5 Target Size (Enhanced) is AAA, stated here as AA",
      ],
    ] as [string[], string][]) {
      expect(faultsIn(...broken), broken.join(" ⏎ ")).toEqual([correction]);
    }

    // ── The (Minimum)/(Enhanced) inversion ──────────────────────────────────
    //
    // The qualifier is where the level lives in these two families, so inverting
    // it is a full weld even though the name is right — and it is the weld this
    // repo has actually shipped twice, in `note-field.tsx` and
    // `row-menu-viewport-fit.spec.ts`. All four of these passed **green** until
    // the qualifier became a field on `CRITERION_SPEC` instead of a trailing
    // comment beside it, which is a guard naming a precedent it could not see.
    for (const [broken, correction] of [
      [
        ["// 2.5.5 Target Size (Minimum), which is AAA"],
        '2.5.5 is "Target Size (Enhanced)", not "Target Size (Minimum)" — "Target Size (Minimum)" is 2.5.8, AA',
      ],
      [
        ["// 2.5.8 Target Size (Enhanced), at 24x24 — AA"],
        '2.5.8 is "Target Size (Minimum)", not "Target Size (Enhanced)" — "Target Size (Enhanced)" is 2.5.5, AAA',
      ],
      [
        ["// 2.4.11 Focus Not Obscured (Enhanced) is AA"],
        '2.4.11 is "Focus Not Obscured (Minimum)", not "Focus Not Obscured (Enhanced)" — "Focus Not Obscured (Enhanced)" is 2.4.12, AAA',
      ],
      [
        ["// 2.4.12 Focus Not Obscured (Minimum) is AAA"],
        '2.4.12 is "Focus Not Obscured (Enhanced)", not "Focus Not Obscured (Minimum)" — "Focus Not Obscured (Minimum)" is 2.4.11, AA',
      ],
      // Name-less, which `CITED_CRITERION` cannot match at all. Three scanned
      // files write citations this way, so without the second pass the guard
      // would read every one of them as nothing at all.
      [
        ["// 2.5.8 (Enhanced), at 24x24"],
        '2.5.8 is "Target Size (Minimum)", not "(Enhanced)" — "Target Size (Enhanced)" is 2.5.5, AAA',
      ],
      // A qualifier on a criterion that has no Minimum/Enhanced variant.
      [
        ["// 2.4.13 Focus Appearance (Minimum) is AAA"],
        '2.4.13 is "Focus Appearance", not "Focus Appearance (Minimum)"',
      ],
    ] as [string[], string][]) {
      expect(faultsIn(...broken), broken.join(" ⏎ ")).toEqual([correction]);
    }

    // ── The correction must name the RIGHT criterion, or none ───────────────
    //
    // `find` on the name alone answered "Focus Not Obscured is 2.4.11, AA" for a
    // citation qualified `(Enhanced)`, sending an author who meant 2.4.12 at AAA
    // to renumber to 2.4.11 at AA. A guard whose stated purpose is naming the
    // right answer must not name a wrong one, and when the name genuinely does
    // not resolve it says so instead of picking the first match.
    expect(faultsIn("// 2.4.13 Focus Not Obscured (Enhanced) is AAA")).toEqual([
      '2.4.13 is "Focus Appearance" (AAA), not "Focus Not Obscured" — "Focus Not Obscured (Enhanced)" is 2.4.12, AAA',
    ]);
    expect(faultsIn("// 2.4.13 Focus Not Obscured is AA")).toEqual([
      '2.4.13 is "Focus Appearance" (AAA), not "Focus Not Obscured" — "Focus Not Obscured" is ambiguous without a qualifier: 2.4.11 (Minimum), AA or 2.4.12 (Enhanced), AAA',
    ]);

    // ── A capital "A" is usually the article, not a level ───────────────────
    //
    // `/\b(AAA|AA|A)\b/` read the article and reported a correct AAA citation as
    // level A. This guard scans `CLAUDE.md`, `CHANGELOG.md` and `AGENTS.md`, so
    // that reds an unrelated author's MR for beginning a sentence with "A " near
    // a citation — and this MR rewrote fourteen comments of exactly that shape.
    //
    // Deleting the `A` alternative was the other candidate fix and it is worse:
    // it also stops catching a AAA criterion understated as A, which is the
    // direction #258's own weld failed in. Both directions are pinned here.
    expect(
      faultsIn("// 2.4.13 Focus Appearance. A hue change carries no area."),
    ).toEqual([]);
    expect(faultsIn("// 2.4.13 Focus Appearance, which is A")).toEqual([
      "2.4.13 Focus Appearance is AAA, stated here as A",
    ]);
    expect(faultsIn("// 2.5.3 Label in Name, which is A")).toEqual([]);

    // The two 80-column wrap shapes, asserted on the CORRECTION rather than on
    // "some fault", because `.not.toEqual([])` does not discriminate the reader
    // from the pattern for one of them. Measured against `origin/main`'s tree,
    // where eleven welds were live: a per-line scan reports ten of them, and the
    // two wrapped files fail differently.
    //
    //  * `note-field.tsx` wrapped BEFORE the name (`… WCAG 2.4.11` ⏎
    //    `// Focus Appearance …`). Per-line captures no name, so the file reads
    //    **clean** — the only one of the eleven that does.
    //  * `add-note-button.tsx` wrapped INSIDE it (`… WCAG 2.4.11 Focus` ⏎
    //    `// Appearance …`). Per-line captures `Focus`, so it *is* flagged — with
    //    the wrong correction, `not "Focus"`, which reads as "rename the
    //    criterion" when the fix is to renumber it. A control that accepts any
    //    fault passes straight through that, and did.
    //
    // Asserted through `flatten` rather than a hand-joined string, so what is
    // proven is the reader: the second shape also needs the comment marker
    // stripped before the join, or the name reads as `Focus Not // Obscured` and
    // an honest wrapped citation is flagged instead.
    for (const wrapped of [
      ["// swap, because WCAG 2.4.11", "// Focus Appearance needs a real edge"],
      ["// not a colour swap: WCAG 2.4.11 Focus", "// Appearance is not met"],
    ]) {
      expect(faultsIn(...wrapped), wrapped.join(" ⏎ ")).toEqual([
        '2.4.11 is "Focus Not Obscured (Minimum)" (AA), not "Focus Appearance" — "Focus Appearance" is 2.4.13, AAA',
      ]);
    }

    // And the honest citations stay legal, so the guard cannot be satisfied by
    // deleting the numbers — which would lose the only thing telling a reader
    // what bar they are held to. Every one of these was a false positive at some
    // point while this was being written, which is why they are pinned:
    //
    //  * the enumeration, flagged by the first draft's 40-character window —
    //    three criteria in one sentence is exactly the prose #258 added, and a
    //    guard that fires on its own fix gets deleted;
    //  * "Label in Name for voice control", captured as a name because the
    //    alternation speculatively allowed `for`;
    //  * two same-named criteria in one sentence, where the level check resolved
    //    `indexOf` to the first one for both;
    //  * a level token falling where a fixed-length slice cut it, reading the
    //    trailing "A" of "AAA" as level A.
    for (const honest of [
      "// no visible focus indicator (WCAG 2.4.7 Focus Visible, AA)",
      "// nothing here checks 2.4.11 Focus Not Obscured (Minimum), which is AA",
      "// a ring clears 2.4.13 Focus Appearance (AAA) by construction",
      "// not 2.4.7 Focus Visible, not 2.4.11 Focus Not Obscured, not 2.4.13 Focus Appearance",
      "// satisfying WCAG 2.5.3 Label in Name for voice control",
      "// 2.5.5 Target Size (Enhanced) is AAA; 2.5.8 Target Size (Minimum) is AA",
      "// 2.5.5 Target Size (Enhanced)'s 44x44 is AAA, above 2.5.8's AA 24x24",
      "// carries none of 2.4.13 Focus Appearance's area or its contrast (AAA)",
      "// WCAG 2.4.11 — the UA outline is removed, so the ring has to paint",
      "// 2.4.7 has no threshold of its own, which is the whole problem",
      // The name-less qualifier shape, correct. `note-field.tsx`,
      // `shopping-list.tsx` and `row-menu-viewport-fit.spec.ts` all write it.
      "// 2.5.8 (Minimum), at 24x24, is the AA floor",
      // ...and with a level inside the same bracket, which `a11y-class-hygiene.ts`
      // itself writes, so a strict `\\)` after the qualifier would skip it.
      "// 2.5.8 (Minimum, AA) against 2.5.5 (Enhanced, AAA)",
      // A parenthesised NAME, which ten files write. Legal, and honestly not
      // policed: see the note on `CITED_CRITERION`.
      "// satisfying WCAG 2.5.3 (Label in Name) for voice control",
    ]) {
      expect(faultsIn(honest), honest).toEqual([]);
    }
  });

  it("bounds the level search by index, not by slicing the text first", () => {
    // `LEVEL_PROXIMITY` is the one magic number in this reader, and until #258's
    // review it was the one thing with no control at all: reverting the
    // search-then-bound fix reddened **none** of the sixteen fixtures above. The
    // honest fixtures are structurally unable to reach it, because `faultsIn`
    // passes only the fixture lines, so the remainder is about thirty characters
    // and never runs past the bound. The comment claiming they covered it was
    // wrong, and this is what actually covers it.
    //
    // The bug needs a level token that STRADDLES the bound. Slicing first —
    // `text.slice(from, from + LEVEL_PROXIMITY)` — truncates `AAA` to `AA`, and
    // the pattern matches the fragment against the end of the slice, so a
    // CORRECT AAA citation is reported as AA. Searching the whole remainder and
    // then bounding the match's index cannot do that.
    //
    // Offsets are computed and asserted rather than hand-spaced, because a
    // hand-spaced fixture is exactly what failed here: the one documented as
    // pinning this put `AAA` at offset 25, comfortably inside a 40-char window.
    const cite = "2.4.13 Focus Appearance";
    const probe = (fillerLength: number, level: string) => {
      // Lowercase filler — a capitalised word would be swallowed into the name.
      const { text } = flatten(
        `// ${cite} ${"y".repeat(fillerLength)} ${level} is stated`,
      );
      const rest = text.slice(text.indexOf(cite) + cite.length);
      return {
        offset: rest.indexOf(level),
        faults: citationFaults(text).map(({ fault }) => fault),
      };
    };

    // Correct AAA, straddling the bound: starts inside it and ends outside.
    const straddling = probe(LEVEL_PROXIMITY - 4, "AAA");
    expect(straddling.offset).toBe(LEVEL_PROXIMITY - 2);
    expect(straddling.faults).toEqual([]);

    // Wrong level, comfortably inside the bound: read, and reported.
    const inside = probe(10, "AA");
    expect(inside.offset).toBeLessThan(LEVEL_PROXIMITY);
    expect(inside.faults).toEqual([
      "2.4.13 Focus Appearance is AAA, stated here as AA",
    ]);

    // Wrong level, past the bound: somebody else's sentence, so not ours.
    const outside = probe(LEVEL_PROXIMITY, "AA");
    expect(outside.offset).toBeGreaterThan(LEVEL_PROXIMITY);
    expect(outside.faults).toEqual([]);
  });

  it("reports the line a citation is actually on, wrap and all", () => {
    // The line number is the whole reason the file is indexed rather than simply
    // flattened, so it is asserted rather than assumed. A guard that reports every
    // fault against line 1 is a guard nobody can act on.
    const { text, lineAt } = flatten(
      [
        "const a = 1;",
        "// filler",
        "// a colour swap, because WCAG 2.4.11 Focus",
        "// Appearance is not satisfied by hue",
      ].join("\n"),
    );
    const faults = citationFaults(text);
    expect(faults).toHaveLength(1);
    // Line 3 — where the citation STARTS, not where its wrapped tail lands.
    expect(lineAt(faults[0].offset)).toBe(3);
  });
});
