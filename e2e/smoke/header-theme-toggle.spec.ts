import { test, expect, type Page } from "@playwright/test";
import {
  DESKTOP,
  MOBILE,
  expandSection,
  expectThemeApplied,
  setTheme,
  waitForShell,
} from "../helpers";

// #103 — the header's theme control is icon-only, so this is the spec that runs
// against a REAL build rather than jsdom.
//
// Two things only a browser can answer, and both are the whole point of the
// change:
//
//  1. The accessible NAME. jsdom will happily report an aria-label; what matters
//     is that the rendered button has a name at all now that the words are gone
//     — an icon-only control with no name is an unlabelled button to a screen
//     reader, and the jsdom suite can't tell a real accessibility tree from a
//     hopeful attribute.
//  2. The measured HIT TARGET. `min-h-11 min-w-11` is a class name in jsdom (no
//     CSS is applied there, so a class assertion is all it can do). Only a real
//     layout can confirm the box is actually ≥44×44 — Tailwind class collisions
//     or a flex parent squeezing the button would pass the unit test and fail
//     the user.
//
// Measurement assertions, not screenshots: a pixel baseline goes stale on every
// unrelated style change and never says why it failed (the #92 lesson).

/** The header control, located the way an assistive tech user reaches it. */
const themeToggle = (page: Page) =>
  page
    .locator("header")
    .getByRole("button", { name: /^switch to (dark|light) mode$/i });

const MIN_TARGET = 44;

for (const [label, viewport] of [
  ["phone (390)", MOBILE],
  ["desktop (1280)", DESKTOP],
] as const) {
  test.describe(`#103 header theme toggle — ${label}`, () => {
    test.beforeEach(async ({ page }) => {
      await page.setViewportSize(viewport);
    });

    test(`is icon-only and still named + hit-targetable (${label})`, async ({
      page,
    }) => {
      await page.goto("/");
      await waitForShell(page);

      const toggle = themeToggle(page);
      await expect(toggle).toBeVisible();

      // Icon only: an svg child and no visible words.
      expect((await toggle.textContent())?.trim()).toBe("");
      expect(await toggle.locator("svg").count()).toBe(1);
      // The glyph is decorative — the name comes from the label, not the icon.
      await expect(toggle.locator("svg")).toHaveAttribute(
        "aria-hidden",
        "true",
      );

      // Light is the resting state, so the button offers dark, and a pointer
      // user gets the same string on hover as AT users hear.
      await expect(toggle).toHaveAccessibleName("Switch to dark mode");
      await expect(toggle).toHaveAttribute("title", "Switch to dark mode");
      await expect(toggle).toHaveAttribute("aria-pressed", "false");

      const box = await toggle.boundingBox();
      expect(box, "the toggle has no layout box").not.toBeNull();
      expect(
        Math.round(box!.width),
        "hit target too narrow (WCAG 2.5.5)",
      ).toBeGreaterThanOrEqual(MIN_TARGET);
      expect(
        Math.round(box!.height),
        "hit target too short (WCAG 2.5.5)",
      ).toBeGreaterThanOrEqual(MIN_TARGET);

      // The reason the words went: the bar has to fit. Nothing in the header may
      // push the document wider than the viewport.
      const scrollWidth = await page.evaluate(
        () => document.documentElement.scrollWidth,
      );
      expect(
        scrollWidth,
        "the header overflows the viewport",
      ).toBeLessThanOrEqual(viewport.width);
      expect(box!.x + box!.width).toBeLessThanOrEqual(viewport.width);
    });

    test(`toggling re-labels it and writes the theme (${label})`, async ({
      page,
    }) => {
      await page.goto("/");
      await waitForShell(page);

      const toggle = themeToggle(page);
      await toggle.click();

      await expectThemeApplied(page, "dark");
      await expect(toggle).toHaveAccessibleName("Switch to light mode");
      await expect(toggle).toHaveAttribute("title", "Switch to light mode");
      await expect(toggle).toHaveAttribute("aria-pressed", "true");
      // Still wordless in the other theme.
      expect((await toggle.textContent())?.trim()).toBe("");

      await toggle.click();
      await expectThemeApplied(page, "light");
      await expect(toggle).toHaveAccessibleName("Switch to dark mode");
    });
  });
}

// A returning dark-mode user: the pre-hydration script applies `dark` before
// React runs, and the control must come up labelled for the theme that is
// actually on screen (#23's invariant, re-asserted now that the label is the
// only thing carrying the state visibly).
test("#103 a preloaded dark theme comes up labelled 'Switch to light mode'", async ({
  page,
}) => {
  await page.setViewportSize(MOBILE);
  await setTheme(page, "dark");
  await page.goto("/");
  await waitForShell(page);

  // The label assertion goes FIRST because it is the auto-retrying one: the
  // `dark` class is written by the inline <head> script, which can land a beat
  // after the shell is painted, and a bare page.evaluate() read is a single
  // sample (it flaked exactly once that way on a loaded machine). Waiting on
  // the label doesn't weaken anything — the label is DERIVED from the class, so
  // if the class never arrives this fails naming the control, and
  // expectThemeApplied still has to hold underneath it.
  await expect(themeToggle(page)).toHaveAccessibleName("Switch to light mode");
  await expectThemeApplied(page, "dark");
});

// The other call site deliberately did NOT change: a bare icon in a settings
// row would be worse than the label it replaced.
test("#103 Settings > Appearance keeps the theme control's words", async ({
  page,
}) => {
  await page.setViewportSize(DESKTOP);
  await page.goto("/settings");
  await waitForShell(page);
  await expandSection(page, "settings-appearance");

  // Named exactly "Dark mode" — i.e. by its VISIBLE words, with no aria-label
  // overriding them (WCAG 2.5.3). `exact` is load-bearing: Playwright's default
  // accessible-name matching is a case-insensitive SUBSTRING, which also matches
  // the header's "Switch to dark mode". With the whole-string match this locator
  // resolves to the Appearance row and only the Appearance row, so one hit
  // proves both that the words survived here and that they are gone from the bar.
  const row = page.getByRole("button", { name: "Dark mode", exact: true });
  await expect(row).toHaveCount(1);
  await expect(row).toBeVisible();
  await expect(row).toContainText("Dark mode");
});
