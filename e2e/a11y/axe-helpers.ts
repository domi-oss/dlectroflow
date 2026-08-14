import fs from "node:fs";
import path from "node:path";
import { expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

// WCAG 2.0 + 2.1 + 2.2, levels A and AA — the standard *mechanical* ruleset that
// catches contrast, missing labels, wrong/absent roles and name/role/value
// issues (issue #31). Axe's "best-practice" rules are intentionally excluded:
// they are not WCAG-normative and would add noise to a blocking gate.
//
// ── #263: the 2.2 pair is the fix, not decoration ────────────────────────────
//
// This list was `["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]` for the life of
// the suite. axe turns it into `runOnly: { type: "tag" }` and runs a rule only if
// one of the rule's tags is in the list, so no WCAG 2.2 success criterion had
// ever been evaluated — seven specs reporting green on criteria nothing looked
// at, which is the failure shape the `document-title` paragraph below and
// `e2e-project-split.test.ts` are both about.
//
// What the pair actually buys, measured in a real browser against axe-core
// 4.12.1 (pinned by `@axe-core/playwright@4.12.1`): 62 rules evaluated before,
// 63 after, delta exactly `["target-size"]`, nothing dropped. That rule is
// **WCAG 2.5.8 Target Size (Minimum), Level AA**, whose normative figure is 24 by
// 24 CSS pixels, and its checks report at impact `serious` — so it clears
// BLOCKING_IMPACTS and can genuinely fail the gate.
//
// Three things this does NOT do, stated because a change about criterion
// coverage that overclaims its coverage is the original bug one level up:
//
//   * It does not deliver **2.4.11 Focus Not Obscured (Minimum), Level AA** —
//     axe-core has no rule for it at any tag, and a keyboard walk is still
//     outstanding on #263. Nothing in this repo detects real 2.4.11 today.
//     ⚠️ `a11y-class-hygiene` is NOT 2.4.11 coverage, whatever a comment
//     elsewhere may still say — its Rule D catches a focus indicator that is
//     merely a colour swap, i.e. **2.4.13 Focus Appearance (AAA)** and **1.4.11
//     Non-text Contrast (AA, WCAG 2.1)**. It carried 2.4.11's NUMBER with
//     2.4.13's TITLE; #258 / !340 is the correction, and any surviving comment
//     that reads otherwise predates it. Real 2.4.11 is a focused control coming
//     to rest UNDER a sticky bar — geometry, which no class-string check can
//     reach at all.
//   * It does not improve **1.4.11 Non-text Contrast**, which is Level AA and
//     WCAG *2.1* — already covered by `wcag21aa` — and which axe cannot measure
//     reliably for a focus indicator against adjacent colours.
//   * It does not reach the 44px the house style asks of interactive controls.
//     44px is **2.5.5 Target Size (Enhanced)**, Level **AAA**; axe's rule is the
//     AA floor of 24px, so a 30px control passes here. That bar is enforced by
//     COLOCATED COMPONENT UNIT TESTS asserting `min-h-[44px]`/`min-h-11` class
//     strings (`theme-toggle.test.tsx`, `sub-header.test.tsx`,
//     `inbox-view.test.tsx` …) — there is no repo-wide touch-target gate, which
//     is exactly why two 20px controls in `breakdown-chat.tsx` reached `main`
//     unseen (#205's family). So the two checks are complementary rather than
//     redundant: theirs is stricter but only exists where someone wrote one,
//     while this one is repo-wide and measures RENDERED geometry.
//
// `wcag22a` matches zero axe rules today: the only Level A criteria new in 2.2
// are 3.2.6 Consistent Help and 3.3.7 Redundant Entry, and axe implements
// neither. It is here so a future axe-core release that adds one is picked up
// without a code change.
//
// `e2e/a11y/axe-wcag22-coverage.spec.ts` is the proof and the regression guard:
// it fails if either tag is removed, and — because `target-size` ships
// `enabled: false` in axe-core and is switched on purely by being named in
// `runOnly` — it also fails if an axe-core upgrade stops honouring that.
export const WCAG_TAGS = [
  "wcag2a",
  "wcag2aa",
  "wcag21a",
  "wcag21aa",
  "wcag22a",
  "wcag22aa",
];

// Only serious/critical block the gate. moderate/minor still appear in the axe
// output for awareness but never fail CI — the conventional axe blocking
// threshold, which keeps the signal high.
const BLOCKING_IMPACTS = new Set(["serious", "critical"]);

// Checked-in allowlist of pre-existing serious/critical violations, keyed by a
// stable route key (NOT the live URL — dynamic ids are normalised away). The
// gate fails only on fingerprints that are NOT in this file, so it starts green
// and then catches regressions per-MR.
//
// Exported for `axe-wcag22-coverage.spec.ts`, whose `records no synthetic
// fixture` test reads this file to prove no fixture key was ever baselined.
// That spec carried its own copy of this path until review on !341, and a second
// literal is the wrong shape for a guard: the day this one moves or becomes
// configurable, the copy keeps resolving, the guard reads a file nobody writes,
// and it passes vacuously. That is the #263 defect one level up — a green result
// that means nothing was looked at — so there is one definition and the guard
// cannot drift away from the thing it guards.
export const BASELINE_PATH = path.join(
  process.cwd(),
  "e2e/a11y/axe-baseline.json",
);

// Refresh mode: `A11Y_UPDATE_BASELINE=1 npx playwright test e2e/a11y` rewrites
// the baseline from the current run instead of asserting against it. Used to
// seed the file and to intentionally accept a reviewed pre-existing violation.
const UPDATE_BASELINE = process.env.A11Y_UPDATE_BASELINE === "1";

// Types are derived straight from AxeBuilder.analyze() so we don't depend on the
// exact shape of axe-core's exported types.
type AxeResults = Awaited<
  ReturnType<InstanceType<typeof AxeBuilder>["analyze"]>
>;
type Violation = AxeResults["violations"][number];
type ViolationNode = Violation["nodes"][number];
type Baseline = Record<string, string[]>;

function loadBaseline(): Baseline {
  try {
    return JSON.parse(fs.readFileSync(BASELINE_PATH, "utf8")) as Baseline;
  } catch (err) {
    // A missing baseline is expected on the very first run — start empty.
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return {};
    // Any other error (e.g. a SyntaxError from invalid JSON or leftover merge
    // conflict markers) must NOT be swallowed: silently returning {} would make
    // every baselined violation look "new" and fail the gate with a misleading
    // message. Re-throw with a diagnostic that points at the real cause.
    throw new Error(
      `Failed to parse axe baseline at ${BASELINE_PATH}: ${(err as Error).message}\n` +
        "Check for merge conflict markers or invalid JSON.",
    );
  }
}

function saveBaseline(baseline: Baseline): void {
  const sorted: Baseline = {};
  for (const key of Object.keys(baseline).sort()) {
    sorted[key] = [...baseline[key]].sort();
  }
  fs.writeFileSync(BASELINE_PATH, `${JSON.stringify(sorted, null, 2)}\n`);
}

// A stable-enough identity for one violating node: the rule id + the element's
// CSS target path. A NEW rule, or an existing rule on a NEW element, yields a
// fingerprint not in the baseline ⇒ the gate fails.
function nodeFingerprint(ruleId: string, node: ViolationNode): string {
  const target = node.target
    .map((t) => (Array.isArray(t) ? t.join(" ") : String(t)))
    .join(" >>> ");
  return `${ruleId}::${target}`;
}

function blockingFingerprints(violations: Violation[]): string[] {
  return violations
    .filter((v) => BLOCKING_IMPACTS.has(v.impact ?? ""))
    .flatMap((v) => v.nodes.map((n) => nodeFingerprint(v.id, n)))
    .sort();
}

// Human-readable report of the serious/critical violations that are NOT allowed
// by the baseline — attached to the assertion so a failing CI job is actionable.
function report(violations: Violation[], allowed: Set<string>): string {
  const lines: string[] = [];
  for (const v of violations) {
    if (!BLOCKING_IMPACTS.has(v.impact ?? "")) continue;
    for (const node of v.nodes) {
      const fp = nodeFingerprint(v.id, node);
      if (allowed.has(fp)) continue;
      // `failureSummary` as well as `help`, added with the WCAG 2.2 widening
      // (#263). `help` is the rule's generic sentence — for `target-size` it
      // reads "All touch targets must be 24px large, or leave sufficient
      // space", which names neither the measured size nor which half of the
      // rule failed, so a red CI job said what the rule wants and not what the
      // page did. axe puts both in `failureSummary` ("Target has insufficient
      // size (20px by 20px…)"), and the contrast reporter below has always
      // printed it — this side simply did not, which only became expensive once
      // a geometry rule started firing. Indented to stay inside the node block.
      const summary = (node.failureSummary ?? "")
        .split("\n")
        .map((line) => `      ${line}`)
        .join("\n");
      lines.push(
        `  [${v.impact}] ${v.id} — ${v.help}\n    at: ${fp}\n    ${v.helpUrl}` +
          (summary.trim() ? `\n${summary}` : ""),
      );
    }
  }
  return lines.join("\n");
}

// ── #222: never read `document.title` mid-commit ────────────────────────────
//
// `src/app/layout.tsx` sets a static `metadata.title`, so every route ships a
// `<title>` in the server-streamed HTML — and, corrected while measuring #249,
// it ships INSIDE `<head>` rather than in the body for React to hoist out of it
// (on `/`: `<title>` at byte 1624 of the response, `</head>` at 2159). React 19
// still owns the element, which is what the rest of this paragraph rests on: on
// the RSC payload a `router.refresh()` brings back, the whole hoisted block
// (`<title>`, the description `<meta>` and both icon `<link>`s) is detached and
// re-inserted — and `e2e/a11y/axe-title-guard.spec.ts` records the same
// ownership showing up a second way, React's first hydration commit re-creating
// a `<title>` that a test had removed.
//
// axe's `doc-has-title` check is exactly `!!sanitize(document.title)`, and
// `document.title` is empty only while the element belongs to no parent at all —
// a `<title>` parked inside a body `<div>` still reads `"dlectroflow"`. So the
// bug is that one instant of re-parenting, a few milliseconds wide, and the
// specs it exposes are the ones whose last wait before scanning is on *body*
// content, which says nothing about `<head>`. It failed whichever
// mutate-then-scan spec landed in the window — `/ (with a row)` on one attempt
// and `/shopping` on the next, same SHA.
//
// #222 carries the CI evidence: the trace snapshots bracketing `axe.runPartial`
// with `<head>` four children short, and the red/red/green runs on one sha. It
// is deliberately not restated here — job logs are purged and trace ids mean
// nothing once the artefact expires, so the durable reference is the issue.
//
// So every scan waits for the title first. Deliberately here rather than in
// `waitForShell`:
//
//   * `waitForShell` runs BEFORE the mutation in every affected spec (`goto` →
//     `waitForShell` → `captureItem` → scan), so a guard there cannot see a
//     window the later mutation opens. It would read as a fix and change nothing.
//   * `e2e/a11y/axe-shopping.spec.ts` — the site the second sighting fired on —
//     does not call `waitForShell` before its scan at all; it arrives by link
//     click and waits on the page heading.
//   * `waitForShell` is shared with the smoke specs, where its contract is "the
//     app shell is rendered". Only the scanners care about `<head>`.
//
// This is a WAIT, not a suppression. `document-title` stays out of
// `axe-baseline.json`: a genuinely title-less route is a real WCAG 2.4.2 failure
// and baselining the rule would blind the gate to it permanently. A route that
// really has no title still fails here — with a better message than axe's, and
// `e2e/a11y/axe-title-guard.spec.ts` holds the title away for good to prove it.
//
// `/\S/` rather than `/dlectroflow/`: this asserts the same predicate axe does,
// which is what makes the wait exactly as strong as the rule it protects.
// Matching the brand would also couple the gate to one string — `/terms` and
// `/privacy` set their own titles today, and the next route to do so should not
// have to know about this file.

/** How long to wait for the title. The window it covers is milliseconds wide. */
const TITLE_TIMEOUT_MS = 5_000;

async function waitForDocumentTitle(page: Page): Promise<void> {
  await expect(
    page,
    "the page never got a non-empty <title>, so scanning now would report a " +
      "`document-title` violation that is really a scan taken too early (#222). " +
      "If this route genuinely ships without a title that is a real WCAG 2.4.2 " +
      "failure — fix the route's metadata, do not baseline the rule.",
  ).toHaveTitle(/\S/, { timeout: TITLE_TIMEOUT_MS });
}

/**
 * Scan the current page with axe and assert there are no NEW serious/critical
 * violations relative to the checked-in baseline for `routeKey`.
 *
 * In `A11Y_UPDATE_BASELINE=1` mode, the baseline entry for `routeKey` is
 * rewritten from this run (and removed when the route is clean) instead of
 * asserting — regenerate the whole baseline by running the a11y suite once with
 * that env var set.
 */
export async function scanA11y(page: Page, routeKey: string): Promise<void> {
  // Ahead of the UPDATE_BASELINE branch, not inside the asserting path: a
  // refresh run that caught the #222 window would otherwise WRITE
  // `document-title::html` into the baseline and permanently blind the gate to
  // the real thing. The escape hatch this helper advertises must not be able to
  // record the flake.
  await waitForDocumentTitle(page);

  const results = await new AxeBuilder({ page }).withTags(WCAG_TAGS).analyze();
  const current = blockingFingerprints(results.violations);

  if (UPDATE_BASELINE) {
    const baseline = loadBaseline();
    if (current.length > 0) baseline[routeKey] = current;
    else delete baseline[routeKey];
    saveBaseline(baseline);
    return;
  }

  const allowed = new Set(loadBaseline()[routeKey] ?? []);
  const introduced = current.filter((fp) => !allowed.has(fp));
  expect(
    introduced,
    `New serious/critical accessibility violations on "${routeKey}" ` +
      `(not in e2e/a11y/axe-baseline.json):\n${report(results.violations, allowed)}\n\n` +
      "If these are intentional/pre-existing, refresh the baseline after review:\n" +
      "  A11Y_UPDATE_BASELINE=1 npx playwright test e2e/a11y",
  ).toEqual([]);
}

// ── Zero-tolerance color-contrast gate ──────────────────────────────────────
// The other half of the a11y suite: only the `color-contrast` rule, asserted at
// ZERO violations with no allowlist, so every real contrast issue on a gated
// surface must be fixed rather than grandfathered into the baseline above.
// Extracted from e2e/a11y-contrast.spec.ts for #90 so the guest pass
// (e2e/a11y/axe-guest-surfaces.spec.ts) gates on exactly the same primitives.

/** Scan the current page for `color-contrast` violations only. */
export async function scanColorContrast(page: Page): Promise<Violation[]> {
  const results = await new AxeBuilder({ page })
    .withRules(["color-contrast"])
    .analyze();
  return results.violations;
}

/** Assert ZERO contrast violations, with an actionable per-node report. */
export function expectNoContrastViolations(violations: Violation[]): void {
  // Named `detail` rather than `report` so it does not shadow the
  // baseline-relative report() above.
  const detail = violations
    .map(
      (v) =>
        `[${v.impact}] ${v.id} — ${v.help}\n` +
        v.nodes
          .map(
            (n) => `    at: ${n.target.join(" >>> ")}\n    ${n.failureSummary}`,
          )
          .join("\n"),
    )
    .join("\n");
  expect(violations, `color-contrast violations found:\n${detail}`).toEqual([]);
}
