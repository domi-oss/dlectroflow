import { test, expect, type Page } from "@playwright/test";
import { expandSection, waitForShell } from "../helpers";
import { scanA11y } from "./axe-helpers";

/**
 * #199 — the mechanical accessibility gate over shopping-list mode.
 *
 * Its own file rather than a fifth entry in `STATIC_ROUTES`
 * (`axe-core-flow.spec.ts`), because `/shopping` is **not statically reachable**:
 * `Settings.shoppingList` is off by default and the page answers 404 until it is
 * turned on. Adding the route to that list would scan a 404 page and call it
 * clean — the "nothing found" failure, where a green result means nothing was
 * looked at.
 *
 * So the switch is turned on through the UI, which makes this an end-to-end proof
 * of the whole path rather than only a scan: the Settings section renders, its
 * checkbox writes, the menu grows an entry, and the page then exists.
 *
 * The list is scanned WITH A ROW. `axe-core-flow.spec.ts` records what that is
 * worth in its own comment: an empty list is a clean scan of nothing at all — no
 * checkbox, no accessible names carrying item text, no strike decoration. The row
 * controls are the whole a11y surface here.
 *
 * ## The state is set, never assumed
 *
 * `Settings` is a persisted row in a database the whole suite shares, so "the
 * toggle is off" is true on a fresh CI database and false the second time this
 * file runs locally. The first draft asserted the 404 straight after `goto`, and
 * it passed once and then failed — which is the more useful outcome, because a
 * spec that only holds on a fresh database is a spec that goes green in CI while
 * proving nothing about the gate. So the switch is driven to a known state at both
 * ends: OFF before the gate assertion, and OFF again afterwards, so nothing else
 * in the suite inherits an extra menu entry from this file.
 *
 * `reducedMotion` for the reason the core-flow suite gives: it keeps intro
 * animations from being scanned mid-transition, which is what makes the snapshot
 * deterministic between local and CI.
 */
test.use({ contextOptions: { reducedMotion: "reduce" } });

/**
 * Drive the toggle to `on` and prove the write landed.
 *
 * The menu entry is the proof, not the checkbox: the checkbox is local component
 * state the instant it is clicked, whereas the entry is rendered by the app shell
 * and can only appear once `updateShoppingList` has written and the
 * layout-scoped revalidation has taken effect.
 */
async function setShoppingToggle(page: Page, on: boolean): Promise<void> {
  await page.goto("/settings");
  await waitForShell(page);
  await expandSection(page, "settings-shopping");
  const toggle = page.getByRole("checkbox", {
    name: /show the shopping list/i,
  });
  if ((await toggle.isChecked()) !== on) await toggle.setChecked(on);
  await expect(toggle).toBeChecked({ checked: on });

  await page.getByRole("button", { name: "Menu" }).click();
  const entry = page
    .getByRole("navigation", { name: "Main" })
    .getByRole("link", { name: /Shopping list/ });
  if (on) await expect(entry).toBeVisible();
  else await expect(entry).toHaveCount(0);
}

test.describe("accessibility: shopping-list mode (axe)", () => {
  test.afterEach(async ({ page }) => {
    await setShoppingToggle(page, false);
  });

  test("no new serious/critical violations: /shopping with a row", async ({
    page,
  }) => {
    // 1. With the switch off the page does not exist — asserted, because a
    //    menu-only gate would leave it reachable by URL and this is the half of
    //    the gate a unit test cannot see (the real 404 from the real server).
    await setShoppingToggle(page, false);
    await page.goto("/shopping");
    await expect(page.getByText(/404|not found/i).first()).toBeVisible();

    // 2. Turn it on the way a person does, and walk in through the menu.
    await setShoppingToggle(page, true);
    await page
      .getByRole("navigation", { name: "Main" })
      .getByRole("link", { name: /Shopping list/ })
      .click();
    await expect(
      page.getByRole("heading", { level: 1, name: /Shopping list/ }),
    ).toBeVisible();

    // 3. Capture one item, so the scan has row controls to look at.
    const label = `A11y item ${Date.now()}`;
    await page.getByLabel(/add to the list/i).fill(label);
    await page.getByRole("button", { name: /^Add$/ }).click();
    await expect(page.getByText(label)).toBeVisible();

    await scanA11y(page, "/shopping");

    // 4. Leave no fixture behind: the item would otherwise accumulate one row per
    //    run in the shared database, and the next run's scan would be of a longer
    //    list than the one this file describes.
    await page
      .getByRole("button", { name: new RegExp(`Delete ${label}`) })
      .click();
    await expect(page.getByText(label)).toHaveCount(0);
  });
});
