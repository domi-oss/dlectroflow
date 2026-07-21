import fs from "node:fs";
import path from "node:path";
import { expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

// WCAG 2.0 + 2.1, levels A and AA — the standard *mechanical* ruleset that
// catches contrast, missing labels, wrong/absent roles and name/role/value
// issues (issue #31). Axe's "best-practice" rules are intentionally excluded:
// they are not WCAG-normative and would add noise to a blocking gate.
export const WCAG_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"];

// Only serious/critical block the gate. moderate/minor still appear in the axe
// output for awareness but never fail CI — the conventional axe blocking
// threshold, which keeps the signal high.
const BLOCKING_IMPACTS = new Set(["serious", "critical"]);

// Checked-in allowlist of pre-existing serious/critical violations, keyed by a
// stable route key (NOT the live URL — dynamic ids are normalised away). The
// gate fails only on fingerprints that are NOT in this file, so it starts green
// and then catches regressions per-MR.
const BASELINE_PATH = path.join(process.cwd(), "e2e/a11y/axe-baseline.json");

// Refresh mode: `A11Y_UPDATE_BASELINE=1 npx playwright test e2e/a11y` rewrites
// the baseline from the current run instead of asserting against it. Used to
// seed the file and to intentionally accept a reviewed pre-existing violation.
const UPDATE_BASELINE = process.env.A11Y_UPDATE_BASELINE === "1";

// Types are derived straight from AxeBuilder.analyze() so we don't depend on the
// exact shape of axe-core's exported types.
type AxeResults = Awaited<ReturnType<InstanceType<typeof AxeBuilder>["analyze"]>>;
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
      lines.push(`  [${v.impact}] ${v.id} — ${v.help}\n    at: ${fp}\n    ${v.helpUrl}`);
    }
  }
  return lines.join("\n");
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
