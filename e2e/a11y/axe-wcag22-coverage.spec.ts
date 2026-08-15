import fs from "node:fs";
import { test, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import {
  BASELINE_PATH,
  UPDATE_BASELINE,
  WCAG_TAGS,
  scanA11y,
} from "./axe-helpers";

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
 * Deliberately NOT restated here. The `WCAG_TAGS` docblock in `axe-helpers.ts`
 * carries that catalogue — 2.4.11 and its #258 mislabelling, 1.4.11, 2.4.13,
 * 2.5.8 versus 2.5.5, and why a 24px rule is worth turning on where the house
 * bar is 44px. Read it there.
 *
 * A pointer rather than a second copy, raised in review on !341, and the reason
 * is this file's own subject. Two independent statements of a criterion's number
 * and level are exactly how #258 happened: a comment carried 2.4.11's NUMBER
 * with 2.4.13's TITLE for as long as nobody diffed the places that said it. A
 * correction applied to one copy and not the other rebuilds that trap, and a
 * criterion claim drifting out of true is the defect #263 is about — so the one
 * statement lives next to the tag list it describes, which is what a reader is
 * checking it against anyway.
 *
 * What stays in this file is what concerns THIS FILE's test design rather than
 * the criteria themselves: the two axe-core mechanics above, the negative and
 * positive control pair, and the fixture geometry on the constants below.
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
 * The two CHECKS the `target-size` RULE is composed of, joined by axe with
 * `any`.
 *
 * ⚠️ axe reuses the string `"target-size"` for the rule AND for its size check,
 * so `TARGET_SIZE` above and `SIZE_CHECK` here are the same literal naming two
 * different things. Kept as separate constants deliberately: the assertions
 * below read per-CHECK data off a node, which is a different axis from the rule
 * lookup in `bucketFor`, and collapsing them would hide that.
 */
const SIZE_CHECK = "target-size";
const OFFSET_CHECK = "target-offset";

/**
 * The criterion tags axe stamps on the rule it reports.
 *
 * This is what makes the positive control evidence about **WCAG 2.2** rather
 * than about "some rule that happens to be named `target-size`": axe labels each
 * result with the success criterion it implements, and the reported rule carries
 * `["cat.sensory-and-visual-cues", "wcag22aa", "wcag258"]` — measured, not
 * recalled. `wcag258` is 2.5.8 Target Size (Minimum) and `wcag22aa` is its
 * conformance level, which together are the whole claim #263 makes.
 *
 * Stable for the same reason `WCAG_TAGS` is: this is the tag taxonomy
 * `withTags()` selects on, so axe cannot rename it without breaking the
 * widening itself — at which point the first test in this file fails and says so.
 */
const TARGET_SIZE_TAGS = ["wcag22aa", "wcag258"] as const;

/**
 * 2.5.8's normative floor, in CSS pixels — and axe's default `minSize` /
 * `minOffset` for both halves of the rule.
 *
 * <https://www.w3.org/TR/WCAG22/#target-size-minimum>. NOT 44, which is 2.5.5
 * Target Size (Enhanced), Level AAA — see the file docblock.
 */
const WCAG_258_MIN_PX = 24;

/**
 * The fixture size that violates 2.5.8, named because an assertion below reads
 * it back out of axe's measurement.
 *
 * A literal in both places would let the fixture and the assertion drift apart,
 * and the assertion would then be checking a number nothing renders.
 */
const UNDERSIZED_PX = 20;

/**
 * The fixture size that SATISFIES 2.5.8, for the opposite-direction control.
 *
 * The same *kind* of quantity as {@link UNDERSIZED_PX} — both are the `size`
 * argument to {@link twoAdjacentTargets}, i.e. a rendered control dimension —
 * which is why this is a sibling constant rather than anything shared with
 * {@link WCAG_258_MIN_PX}. ⚠️ Those two are **different quantities that must not
 * be welded**: 24 is the floor the gate enforces, 44 is what a fixture happens
 * to be drawn at. Collapsing a fixture dimension into a criterion floor is the
 * 2.5.5-vs-2.5.8 confusion this repo has already had to correct in two separate
 * files, and it would make this fixture read as a conformance requirement.
 *
 * 44 rather than 24 on purpose, and the gap is the whole point: the gate's floor
 * is 24 ({@link WCAG_258_MIN_PX}, **2.5.8 Target Size (Minimum), Level AA**),
 * while 44x44 is the house convention asserted by COLOCATED COMPONENT UNIT TESTS
 * (#205) — which is **2.5.5 Target Size (Enhanced), Level AAA**, NOT the
 * criterion under test. A fixture is a statement about what this repo considers
 * correct, so it is drawn at the house bar rather than at the weaker figure it
 * would also pass.
 *
 * ⚠️ NOT `a11y-class-hygiene`, which an earlier draft of this docblock named.
 * That module has no touch-target rule at all — measured, its exports are
 * `findTextContrastRisks`, `findTintedBannerText` and `findWeakFocusIndicators`,
 * and its own docblock records the 24px floor as "a different gap from this
 * module's, recorded rather than fixed". The 44px bar lives in 26 colocated
 * `*.test.tsx` files asserting `min-h-[44px]`/`min-h-11` class strings, so it
 * exists only where somebody wrote one — which is why two 20px controls in
 * `breakdown-chat.tsx` reached `main` unseen. Getting this attribution wrong
 * matters more here than anywhere: it would credit a repo-wide gate that does
 * not exist, which is #263's own failure shape.
 *
 * Deliberately NOT named for a floor or a minimum: nothing here asserts 44 of
 * anything, and a name like `MIN_TARGET_PX` would read as though the gate
 * required it — which is the misreading the paragraph above exists to prevent.
 */
const CORRECTED_PX = 44;

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

// Derived from AxeBuilder.analyze() rather than imported from axe-core, matching
// what `axe-helpers.ts` does at the same spot and for the same reason: nothing
// here should depend on the exact shape of axe-core's exported type names.
type AxeResults = Awaited<
  ReturnType<InstanceType<typeof AxeBuilder>["analyze"]>
>;
type ResultNode = AxeResults["violations"][number]["nodes"][number];

/**
 * Which axe bucket `ruleId` landed in, or `null` when axe never evaluated it.
 *
 * The `null` case is the finding #263 is about, and it is why this reads all
 * four buckets instead of only `violations`: "no violation" is produced BOTH by
 * a compliant page and by a rule that never ran, and those two are the whole
 * distinction under test. `inapplicable` is a real evaluation (axe looked and
 * found no matching element); absence from all four is not.
 *
 * `ruleTags` and `nodes` are returned raw alongside the rendered `detail` so the
 * callers can assert on axe's STRUCTURED output — the criterion tags and the
 * per-check `data` — instead of on the prose in `detail`, which exists only to
 * make a failure message readable (!341).
 */
async function bucketFor(
  page: Page,
  tags: string[],
  ruleId: string,
): Promise<{
  bucket: Outcome | null;
  impact?: string | null;
  ruleTags: string[];
  nodes: ResultNode[];
  detail: string;
}> {
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
      ruleTags: hit.tags,
      nodes: hit.nodes,
      detail: hit.nodes
        .map(
          (node) =>
            `${node.target.join(" ")}: ${node.failureSummary ?? "(no summary)"}`,
        )
        .join("\n"),
    };
  }
  return {
    bucket: null,
    ruleTags: [],
    nodes: [],
    detail: `axe never evaluated "${ruleId}"`,
  };
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
    await render(page, twoAdjacentTargets("undersized", UNDERSIZED_PX));
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
    await render(page, twoAdjacentTargets("undersized", UNDERSIZED_PX));
    const { bucket, impact, ruleTags, nodes, detail } = await bucketFor(
      page,
      WCAG_TAGS,
      TARGET_SIZE,
    );
    expect(
      bucket,
      `"${TARGET_SIZE}" did not report a violation on a fixture with two ` +
        `adjacent ${UNDERSIZED_PX}px controls and no spacing, which violates ` +
        `both halves of WCAG 2.5.8. axe-core may have changed the rule:\n${detail}`,
    ).toBe("violations");
    expect(
      impact,
      `"${TARGET_SIZE}" reported at impact "${impact}", which is outside ` +
        "axe-helpers' BLOCKING_IMPACTS, so the rule now runs without being " +
        "able to fail the gate.",
    ).toBe("serious");

    // That the criterion under test is the one that fired. The rule id alone
    // cannot say this — it names an implementation, not a conformance level —
    // and it is the level that #263 is about.
    for (const tag of TARGET_SIZE_TAGS) {
      expect(
        ruleTags,
        `the rule reported without the "${tag}" tag (got ` +
          `${JSON.stringify(ruleTags)}), so this is no longer evidence that ` +
          "the WCAG 2.2 AA criterion 2.5.8 was evaluated — which is the only " +
          "claim #263 makes. Check what axe re-tagged the rule as before " +
          "touching this list.",
      ).toContain(tag);
    }

    // Both controls violate both halves, so an empty or short list means the
    // fixture stopped working and the per-node loop below would pass vacuously
    // — the exact failure shape this file exists to prevent, so it is asserted
    // rather than assumed.
    expect(
      nodes.map((node) => node.target.join(" ")),
      "the fixture renders exactly two adjacent undersized controls and each " +
        "one violates both the size and the spacing half of 2.5.8, so axe " +
        `should report two nodes:\n${detail}`,
    ).toHaveLength(2);

    for (const node of nodes) {
      // The 24-CSS-pixel floor and the measured geometry, read from axe's
      // STRUCTURED per-check `data` rather than by substring-matching the prose
      // of `failureSummary`.
      //
      // This used to be `expect(detail).toContain("24px")`, which coupled the
      // gate's own regression test to axe-core's English wording: a release that
      // reworded "24px by 24px" to "24 CSS pixels" would have reddened CI on a
      // copy-only dependency bump, with nothing about the rule's behaviour
      // having changed — the unexplained red pipeline this MR is otherwise
      // careful to avoid (raised in review on !341).
      //
      // `data` is the contract axe interpolates those very messages FROM
      // (`should be at least ${data.minSize}px by ${data.minSize}px`), so this
      // is stabler AND strictly stronger than the substring was: `"24px"`
      // matched anywhere in either half's sentence, so the offset half's own
      // figure satisfied it and it could not say which half reported the floor.
      // Here each half is named and each figure is a number.
      const checkData: Record<string, unknown> = Object.fromEntries(
        node.any.map((check) => [check.id, check.data]),
      );
      expect(
        checkData,
        `axe's structured check data for ${node.target.join(" ")} no longer ` +
          `reports the ${WCAG_258_MIN_PX}px floor against the rendered ` +
          `${UNDERSIZED_PX}px geometry. Either axe changed its default ` +
          "minSize/minOffset (a real change to what the gate enforces) or it " +
          "changed the shape of `data` (update the keys, not the figures).",
      ).toMatchObject({
        [SIZE_CHECK]: {
          minSize: WCAG_258_MIN_PX,
          width: UNDERSIZED_PX,
          height: UNDERSIZED_PX,
        },
        [OFFSET_CHECK]: { minOffset: WCAG_258_MIN_PX },
      });

      // …and that the per-node summary is populated at all, which is the
      // precondition the reporting half of this MR rests on: axe-helpers'
      // `report()` appends it only `if (summary.trim())`, so an empty one costs
      // a failing CI job its diagnostic without failing anything. Asserted as
      // non-empty rather than by content — the content is what the structured
      // assertion above already covers, without the coupling.
      expect(
        (node.failureSummary ?? "").trim(),
        `${node.target.join(" ")} reported no failureSummary, so axe-helpers' ` +
          "report() would print the rule's generic `help` sentence and nothing " +
          "about what this page actually did",
      ).not.toBe("");
    }
  });

  test("the real gate rejects the undersized fixture", async ({ page }) => {
    // The point of #263: not "axe can report the rule" but "scanA11y — the
    // function all seven specs call — now fails on it". A scan wired up so that
    // the rule runs and the assertion still passes would be the false pass this
    // whole change exists to prevent.
    test.skip(
      UPDATE_BASELINE,
      "refresh mode WRITES the scanned violations into axe-baseline.json, and " +
        "a synthetic fixture must never be recorded there",
    );
    await render(page, twoAdjacentTargets("undersized", UNDERSIZED_PX));
    let message: string | null = null;
    try {
      await scanA11y(page, UNDERSIZED_KEY);
    } catch (err) {
      message = (err as Error).message;
    }
    expect(
      message,
      `scanA11y PASSED a page with two adjacent ${UNDERSIZED_PX}px controls ` +
        "and no spacing. " +
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
    // simply fails everything. Why the fixture is drawn at CORRECTED_PX rather
    // than at the gate's own floor is on that constant, stated once so the two
    // places cannot drift into disagreeing.
    test.skip(
      UPDATE_BASELINE,
      "refresh mode would DELETE this key from the baseline; harmless, but the " +
        "assertion below is not the thing refresh mode is for",
    );
    await render(page, twoAdjacentTargets("corrected", CORRECTED_PX));
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
