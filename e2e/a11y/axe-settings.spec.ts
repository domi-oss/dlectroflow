import { test } from "@playwright/test";
import { waitForShell, expandAllSections } from "../helpers";
import { scanA11y } from "./axe-helpers";

// #263 — /settings had NO WCAG-tag scan anywhere in the suite.
//
// The blind spot this closes, and it is the #263 defect on a different axis.
// Widening `WCAG_TAGS` to reach WCAG 2.2 only helps on routes some spec actually
// hands to `scanA11y`, and `/settings` was never one of them. It is visited four
// times over — `axe-people-panel.spec.ts`, `e2e/a11y-contrast.spec.ts`,
// `axe-guest-surfaces.spec.ts` (as a guest) and `axe-shopping.spec.ts` (which
// only goes there to flip a toggle, then navigates away) — and every one of
// those either calls `scanColorContrast`, which is
// `.withRules(["color-contrast"])` and therefore evaluates ONE rule instead of
// `WCAG_TAGS`, or does not scan at all. `axe-account-deletion.spec.ts` does use
// `WCAG_TAGS` here but `.include()`s the delete dialog alone, on the member's
// server.
//
// So the net position before this file: the app's largest page had zero coverage
// for missing labels, wrong roles, name/role/value and — the rule #263 turned on
// — 2.5.8 target size, while nine disclosures' worth of controls read as
// "scanned" because a contrast gate did visit it. A green result that means
// nothing was looked at, which is what #263 is about.
//
// Measured when this file was added, so the addition is recorded as additive
// rather than assumed to be: 63 rules evaluated on the expanded page,
// `target-size` reporting in `passes` over **70 nodes**, zero serious/critical
// violations. It also bites — shrinking the route's own buttons to 20px with an
// injected stylesheet made `scanA11y` fail here, citing `target-size`, so this
// is a live check and not a decorative one.
//
// One theme only, deliberately, matching `axe-core-flow.spec.ts`: the rules this
// gate adds over the contrast gate are about structure and rendered geometry,
// neither of which is theme-dependent. Theme × state is the CONTRAST gate's axis
// and it already covers this route on it.
//
// reducedMotion keeps intro animations from being scanned mid-transition, which
// makes the axe snapshot deterministic across local + CI runs (mirrors
// `axe-core-flow.spec.ts`).
test.use({ contextOptions: { reducedMotion: "reduce" } });

test.describe("accessibility: owner /settings (axe)", () => {
  test("no new serious/critical violations: settings, default", async ({
    page,
  }) => {
    await page.goto("/settings");
    await waitForShell(page);
    await scanA11y(page, "/settings");
  });

  // Both states, and they are not interchangeable — the same reason #101 gave
  // the contrast gate a second pass over this route. A closed disclosure's body
  // carries a `hidden` attribute, which axe correctly skips, so the scan above
  // sees nine triggers and one section's worth of controls. Without this second
  // test the new coverage would be quietly narrower than the page it claims.
  test("no new serious/critical violations: settings, every section expanded", async ({
    page,
  }) => {
    await page.goto("/settings");
    await waitForShell(page);
    await expandAllSections(page);
    await scanA11y(page, "/settings (every section expanded)");
  });
});
