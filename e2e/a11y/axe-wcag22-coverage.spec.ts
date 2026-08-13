import fs from "node:fs";
import path from "node:path";
import { test, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { WCAG_TAGS, scanA11y } from "./axe-helpers";

/**
 * #263 — the gate must actually EVALUATE WCAG 2.2, and be shown to bite.
 *
 * ── What was wrong ───────────────────────────────────────────────────────────
 * `WCAG_TAGS` in `axe-helpers.ts` read `["wcag2a", "wcag2aa", "wcag21a",
 * "wcag21aa"]`. Every scan in this directory passes that list to
 * `AxeBuilder.withTags()`, which becomes axe's `runOnly: { type: "tag" }` — and
 * axe runs a rule only if one of its tags is in that list. No `wcag22*` tag was
 * in it, so no WCAG 2.2 success criterion had ever been evaluated by this
 * project's blocking accessibility gate. Seven axe specs reported green against
 * a rule set that excluded 2.2 entirely.
 *
 * That is the failure mode this repo keeps meeting: a zero that means "nothing
 * was looked at" rather than "nothing is wrong" (see the `document-title`
 * paragraph in `axe-helpers.ts`, and `e2e-project-split.test.ts` on an empty
 * gate reporting green). Widening the list without proving the widening bites
 * would replace a known blind spot with a *recorded* false pass, which is
 * strictly worse — so this file is the proof, not decoration.
 *
 * ── What the widening does deliver, measured ─────────────────────────────────
 * Against axe-core 4.12.1 (pinned via `@axe-core/playwright@4.12.1`) the
 * widening adds exactly ONE rule: `target-size`, tagged `wcag22aa`/`wcag258`,
 * check impact `serious` — so it clears `BLOCKING_IMPACTS` and can actually fail
 * the gate. Measured in a real browser: 62 rules evaluated under the old list,
 * 63 under the new one, delta `["target-size"]`, nothing removed.
 *
 * Two mechanical details that are the whole reason this needs a test rather than
 * a reading of the diff:
 *
 *   * `target-size` ships `enabled: false` in axe-core. Naming its tag in
 *     `runOnly` is what turns it on: axe's `matchTags` consults `rule.enabled`
 *     only when the include list is EMPTY (`matching || include.length === 0 &&
 *     rule.enabled !== false`). So the widening works, but it works through a
 *     branch that an axe-core upgrade could change — at which point the gate
 *     would go quiet again with no diff to blame. The delta tests below fail if
 *     that happens.
 *   * `wcag22a` currently matches ZERO axe rules. The only Level A criteria new
 *     in 2.2 are 3.2.6 Consistent Help and 3.3.7 Redundant Entry, and axe
 *     implements neither. It is in the list so a future axe-core release that
 *     adds one is picked up without a code change, not because it earns
 *     coverage today. Deliberately NOT asserted — pinning "zero rules" would
 *     turn a good axe-core upgrade into a red pipeline.
 *
 * ── What the widening does NOT deliver ──────────────────────────────────────
 * Stated precisely, because a change about criterion coverage that overclaims
 * its coverage is the same bug one level up.
 *
 *   * **2.4.11 Focus Not Obscured (Minimum), Level AA (new in WCAG 2.2)** —
 *     axe-core has NO rule for it, at any tag. Widening the tag list does not
 *     deliver 2.4.11 and this file does not test it. It needs a Playwright
 *     keyboard walk that Tabs a long page and asserts the focused element's rect
 *     is not covered by a sticky ancestor; that is a separate checklist item on
 *     #263 and is out of scope here. `src/lib/a11y-class-hygiene.ts` remains the
 *     only check in the repo that can see 2.4.11 at all.
 *   * **1.4.11 Non-text Contrast** is Level AA and WCAG **2.1**, not 2.2 — it
 *     was already covered by `wcag21aa` before this change. axe cannot reliably
 *     measure a focus indicator's 3:1 against adjacent colours, so the widening
 *     neither adds nor improves it.
 *   * **2.4.13 Focus Appearance** is Level **AAA** (WCAG 2.2), so it is out of
 *     scope for an AA gate by design, and it is not 2.4.11.
 *   * The rule this turns on is **2.5.8 Target Size (Minimum), Level AA**, whose
 *     normative figure is **24 by 24 CSS pixels**. It is NOT 2.5.5 Target Size
 *     (Enhanced), which is Level **AAA** and asks for **44 by 44**. Both figures
 *     verified against the W3C Recommendation, not recalled: 2.5.8 is Level AA
 *     in <https://www.w3.org/TR/WCAG22/#target-size-minimum>.
 *
 * The 24px consequence matters to this repo specifically: `a11y-class-hygiene`
 * enforces **44px** on interactive controls (#205), so axe's rule is strictly
 * WEAKER than the house bar. A control between 24px and 44px passes here and
 * fails there. This gate therefore does not replace that one, and the corrected
 * fixture below is sized 44px rather than 24px so a test fixture cannot be read
 * as endorsing the weaker figure.
 */

/**
 * The tag families this file exists to keep in `WCAG_TAGS`.
 *
 * `wcag22aa` is the one carrying coverage today; `wcag22a` is the forward-looking
 * half. Both are asserted because dropping either would silently narrow the gate
 * — the exact defect #263 records, which nothing detected for the life of the
 * suite.
 */
const WCAG_22_TAGS = ["wcag22a", "wcag22aa"] as const;

/**
 * `WCAG_TAGS` minus the 2.2 families — i.e. exactly what `main` ran before #263.
 *
 * Derived rather than restated so the negative control cannot drift away from
 * the thing it is a control for: a hard-coded copy of the old list would keep
 * "proving" a delta against a list nobody uses any more.
 */
const PRE_22_TAGS = WCAG_TAGS.filter((tag) => !tag.startsWith("wcag22"));

/** The one axe rule tagged `wcag22aa` in axe-core 4.12.1 — WCAG 2.5.8. */
const TARGET_SIZE = "target-size";

/**
 * Route keys for the synthetic fixtures.
 *
 * A colon can never appear in a real route key (they are paths — see
 * `axe-baseline.json`), so these cannot collide with a scanned surface, and the
 * `records no synthetic fixture` test below fails if a
 * `A11Y_UPDATE_BASELINE=1` run ever writes one into the committed baseline.
 */
const UNDERSIZED_KEY = "fixture:wcag22-undersized-targets";
const CORRECTED_KEY = "fixture:wcag22-corrected-targets";

const BASELINE_PATH = path.join(process.cwd(), "e2e/a11y/axe-baseline.json");

/**
 * Two adjacent activatable controls of `size`px with NO gap between them.
 *
 * Both halves of 2.5.8 have to fail for the rule to report, because axe joins
 * them with `any`: the `target-size` check (min 24px) and the `target-offset`
 * check (min 24px of spacing). An UNDERSIZED CONTROL ON ITS OWN PASSES — that is
 * 2.5.8's own spacing exception, and it is why this fixture is a pair with zero
 * gap rather than a single small button. Getting that wrong is how a "positive
 * control" ends up proving nothing: the first draft of this fixture used two
 * 20px inline-blocks separated by markup whitespace, whose ~4px space put the
 * centres 24.4px apart and passed the offset check.
 *
 * Everything else about the page is deliberately WCAG-clean (`lang`, a non-empty
 * `<title>`, 21:1 text on the controls, a heading), so a violation reported here
 * can only be the rule under test.
 */
function twoAdjacentTargets(title: string, size: number): string {
  const button =
    `<button type="button" style="width:${size}px;height:${size}px;` +
    `padding:0;border:0;background:#000;color:#fff;font-size:10px">`;
  return (
    `<!doctype html><html lang="en"><head><title>${title}</title></head>` +
    `<body><main><h1>${title}</h1><div style="display:flex;gap:0">` +
    `${button}1</button>${button}2</button>` +
    `</div></main></body></html>`
  );
}

/** Render a fixture and wait for the `<title>` the gate's own precondition needs. */
async function render(page: Page, html: string): Promise<void> {
  await page.setContent(html, { waitUntil: "load" });
  await expect(page).toHaveTitle(/\S/);
}

type Outcome = "violations" | "passes" | "incomplete" | "inapplicable";

/**
 * Which axe bucket `ruleId` landed in, or `null` when axe never evaluated it.
 *
 * The `null` case is the finding #263 is about, and it is why this reads all
 * four buckets instead of only `violations`: "no violation" is produced BOTH by
 * a compliant page and by a rule that never ran, and those two are the whole
 * distinction under test. `inapplicable` is a real evaluation (axe looked and
 * found no matching element); absence from all four is not.
 */
async function bucketFor(
  page: Page,
  tags: string[],
  ruleId: string,
): Promise<{ bucket: Outcome | null; impact?: string | null; detail: string }> {
  const results = await new AxeBuilder({ page }).withTags(tags).analyze();
  const buckets: Outcome[] = [
    "violations",
    "passes",
    "incomplete",
    "inapplicable",
  ];
  for (const bucket of buckets) {
    const hit = results[bucket].find((rule) => rule.id === ruleId);
    if (!hit) continue;
    return {
      bucket,
      impact: "impact" in hit ? hit.impact : null,
      detail: hit.nodes
        .map(
          (node) =>
            `${node.target.join(" ")}: ${node.failureSummary ?? "(no summary)"}`,
        )
        .join("\n"),
    };
  }
  return { bucket: null, detail: `axe never evaluated "${ruleId}"` };
}

test.describe("#263 WCAG 2.2 rule coverage", () => {
  test("WCAG_TAGS names both WCAG 2.2 tag families", () => {
    for (const tag of WCAG_22_TAGS) {
      expect(
        WCAG_TAGS,
        `WCAG_TAGS is missing "${tag}", so axe will not run any rule tagged ` +
          "for that WCAG 2.2 conformance level and every scan in e2e/a11y/ " +
          "will report green on criteria it never evaluated (#263). Add the " +
          "tag back rather than adjusting this test.",
      ).toContain(tag);
    }
  });

  test("the pre-2.2 tag list never evaluated the 2.5.8 rule at all", async ({
    page,
  }) => {
    // The negative control, and the evidence for the defect: on a fixture that
    // genuinely violates 2.5.8, the list `main` used to ship does not report a
    // violation, a pass, an incomplete OR an inapplicable — the rule is simply
    // absent from the run. Without this half, the positive control below could
    // not distinguish "the widening turned a rule on" from "the fixture is bad".
    await render(page, twoAdjacentTargets("undersized", 20));
    const { bucket, detail } = await bucketFor(page, PRE_22_TAGS, TARGET_SIZE);
    expect(
      bucket,
      `"${TARGET_SIZE}" was evaluated under ${JSON.stringify(PRE_22_TAGS)}, ` +
        "which contradicts #263's premise that the pre-2.2 tag list cannot " +
        `reach it. Investigate before trusting either half of this file:\n${detail}`,
    ).toBeNull();
  });

  test("the widened tag list reports 2.5.8 as a blocking violation", async ({
    page,
  }) => {
    // The positive control. `serious` is not incidental: axe-helpers' own
    // BLOCKING_IMPACTS is `{serious, critical}`, so a rule reported at
    // moderate/minor would appear in the output and never fail CI — evaluated
    // but toothless, which is a subtler version of the same blind spot.
    await render(page, twoAdjacentTargets("undersized", 20));
    const { bucket, impact, detail } = await bucketFor(
      page,
      WCAG_TAGS,
      TARGET_SIZE,
    );
    expect(
      bucket,
      `"${TARGET_SIZE}" did not report a violation on a fixture with two ` +
        "adjacent 20px controls and no spacing, which violates both halves of " +
        `WCAG 2.5.8. axe-core may have changed the rule:\n${detail}`,
    ).toBe("violations");
    expect(
      impact,
      `"${TARGET_SIZE}" reported at impact "${impact}", which is outside ` +
        "axe-helpers' BLOCKING_IMPACTS, so the rule now runs without being " +
        "able to fail the gate.",
    ).toBe("serious");
    expect(
      detail,
      "the violation carried no per-node 24px diagnostic, so a failing CI job " +
        "would not say what to fix",
    ).toContain("24px");
  });

  test("the real gate rejects the undersized fixture", async ({ page }) => {
    // The point of #263: not "axe can report the rule" but "scanA11y — the
    // function all seven specs call — now fails on it". A scan wired up so that
    // the rule runs and the assertion still passes would be the false pass this
    // whole change exists to prevent.
    test.skip(
      process.env.A11Y_UPDATE_BASELINE === "1",
      "refresh mode WRITES the scanned violations into axe-baseline.json, and " +
        "a synthetic fixture must never be recorded there",
    );
    await render(page, twoAdjacentTargets("undersized", 20));
    let message: string | null = null;
    try {
      await scanA11y(page, UNDERSIZED_KEY);
    } catch (err) {
      message = (err as Error).message;
    }
    expect(
      message,
      "scanA11y PASSED a page with two adjacent 20px controls and no spacing. " +
        "The WCAG 2.2 tags are in the list but the gate does not bite, which " +
        "is the exact false-pass shape #263 is about.",
    ).not.toBeNull();
    expect(
      message,
      `scanA11y failed for some reason other than ${TARGET_SIZE}, so this ` +
        "test is no longer evidence about WCAG 2.5.8",
    ).toContain(TARGET_SIZE);
  });

  test("the real gate passes the corrected fixture", async ({ page }) => {
    // The other direction, so the test above cannot be satisfied by a gate that
    // simply fails everything. 44px rather than 24px on purpose: 24 is 2.5.8's
    // Level AA floor, 44 is what `a11y-class-hygiene` enforces here (#205), and
    // a fixture is a statement about what this repo considers correct.
    test.skip(
      process.env.A11Y_UPDATE_BASELINE === "1",
      "refresh mode would DELETE this key from the baseline; harmless, but the " +
        "assertion below is not the thing refresh mode is for",
    );
    await render(page, twoAdjacentTargets("corrected", 44));
    await scanA11y(page, CORRECTED_KEY);
  });

  test("axe-baseline.json records no synthetic fixture", () => {
    // `scanA11y` under `A11Y_UPDATE_BASELINE=1` writes whatever it scanned into
    // the committed baseline. The two `test.skip`s above are the guard; this is
    // the check that the guard held, because a fixture key baselined by accident
    // would make the positive control pass vacuously ever after.
    const baseline = JSON.parse(
      fs.readFileSync(BASELINE_PATH, "utf8"),
    ) as Record<string, string[]>;
    for (const key of [UNDERSIZED_KEY, CORRECTED_KEY]) {
      expect(
        Object.keys(baseline),
        `"${key}" is a synthetic fixture and must never appear in ` +
          "axe-baseline.json — remove the entry rather than the test",
      ).not.toContain(key);
    }
  });
});
