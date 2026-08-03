import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import {
  findTextContrastRisks,
  findWeakFocusIndicators,
  scanClassScopes,
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
 *    reason: **axe does not implement WCAG 2.4.11 Focus Appearance**. No fixture
 *    would have caught it.
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
const REVIEWED_TEXT_COLORS: Record<string, string> = {};

// ── Reviewed focus indicators ──────────────────────────────────────────────
//
// Elements that remove the UA focus outline and replace it with something this
// module cannot recognise as an indicator. A reason has to say what the visible
// indicator IS and its contrast against both adjacent colours (WCAG 2.4.11).
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

/** Findings from the real tree, minus anything reviewed, as readable lines. */
function repoOffenders(
  scan: (
    source: string,
    fileName: string,
  ) => { line: number; token: string; reason: string }[],
  reviewed: Record<string, string>,
): string[] {
  const offenders: string[] = [];
  for (const file of scannedFiles()) {
    for (const finding of scan(readFileSync(file, "utf8"), file)) {
      const key = `${file}:${finding.token}`;
      if (reviewed[key]) continue;
      offenders.push(`${file}:${finding.line} — ${finding.reason}`);
    }
  }
  return offenders;
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
    expect(findings[0].reason).toContain("dark:text-*");
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
});

// ── Rule D: focus indicator ────────────────────────────────────────────────

describe("findWeakFocusIndicators", () => {
  it("rejects outline-none whose only focus treatment is a background swap (#117)", () => {
    const findings = findWeakFocusIndicators(
      `const entry = "flex px-3 outline-none hover:bg-accent focus-visible:bg-accent focus-visible:text-primary";`,
      "input.ts",
    );
    expect(findings).toHaveLength(1);
    expect(findings[0].reason).toContain("2.4.11");
    expect(findings[0].reason).toContain("focus-visible:bg-accent");
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

  it("stays quiet about an element that keeps the UA outline", () => {
    // move-to-menu.tsx: `data-[highlighted]:bg-accent` with no outline-none, so
    // the browser's own outline still draws. Correctly not a finding.
    expect(
      findWeakFocusIndicators(
        `const x = <Item className="hover:bg-accent data-[highlighted]:bg-accent rounded px-2" />;`,
      ),
    ).toEqual([]);
  });

  it("reports an outline-none with no focus treatment at all", () => {
    const findings = findWeakFocusIndicators(
      `const x = <a className="rounded outline-none" />;`,
    );
    expect(findings).toHaveLength(1);
    expect(findings[0].reason).toContain("no visible focus indicator");
  });
});

// ── The real tree ──────────────────────────────────────────────────────────

describe("src/ WCAG-AA class hygiene (#109, #117)", () => {
  it("scans a non-trivial number of class scopes", () => {
    // Guards the guard. A path change, a syntax-kind mistake or an over-eager
    // exclusion would make every assertion below pass by measuring nothing —
    // which is the failure mode that let eight of these ship in the first place.
    const scopes = scannedFiles().flatMap((file) =>
      scanClassScopes(readFileSync(file, "utf8"), file),
    );
    expect(scopes.length).toBeGreaterThan(500);
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

  it("uses no sub-AA chromatic text colour, and no un-partnered -700 (#109)", () => {
    expect(repoOffenders(findTextContrastRisks, REVIEWED_TEXT_COLORS)).toEqual(
      [],
    );
  });

  it("replaces every removed focus outline with a real indicator (#117, WCAG 2.4.11)", () => {
    expect(
      repoOffenders(findWeakFocusIndicators, REVIEWED_FOCUS_INDICATORS),
    ).toEqual([]);
  });
});
