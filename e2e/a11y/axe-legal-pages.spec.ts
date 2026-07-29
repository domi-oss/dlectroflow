import { test, expect, type Page } from "@playwright/test";
import {
  DESKTOP,
  MOBILE,
  THEMES,
  setTheme,
  expectThemeApplied,
} from "../helpers";
import {
  scanA11y,
  scanColorContrast,
  expectNoContrastViolations,
} from "./axe-helpers";

// #123 — axe coverage for the published legal pages.
//
// These are the two surfaces in the app most likely to be read by someone who is
// NOT a comfortable user of it: a person checking what happens to their data
// before they sign up, a regulator, or a Google OAuth verification reviewer. They
// are also the longest continuous prose in the product, which is exactly the
// shape a11y problems hide in — heading order, landmark structure, link contrast
// on a wall of text.
//
// No storageState, deliberately. Both pages are in PUBLIC_PREFIXES
// (src/lib/auth/gate.ts) and render outside the `(app)` route group, so a context
// with no cookies is the real first-time visitor — the same opt-out
// e2e/a11y/axe-guest-surfaces.spec.ts uses, and the same one that proves the
// pages are not quietly behind the sign-in wall.
//
// reducedMotion mirrors the other axe specs so the snapshot is deterministic.
test.use({
  storageState: { cookies: [], origins: [] },
  contextOptions: { reducedMotion: "reduce" },
});

const LEGAL_ROUTES = [
  { path: "/privacy", heading: "Privacy Policy" },
  { path: "/terms", heading: "Terms of Service" },
] as const;

/**
 * Land on a legal page and prove it actually rendered before scanning.
 *
 * The h1 is the precondition worth asserting rather than a bare `goto`: if the
 * middleware ever stopped treating these paths as public, `goto` would follow the
 * redirect to /login and return 200 from a *different* page — and every scan below
 * would then pass while covering nothing. Checking the heading makes that failure
 * loud instead of invisible.
 */
async function gotoLegal(page: Page, path: string, heading: string) {
  await page.goto(path);
  await expect(
    page.getByRole("heading", { level: 1, name: heading }),
  ).toBeVisible();
}

// Zero-tolerance contrast, across both themes and both widths. Long-form prose
// leans on `text-muted-foreground` for the effective date, the contents list and
// the footer, and the footer is `text-xs` — the size AA judges at 4.5:1.
for (const [size, viewport] of [
  ["desktop", DESKTOP],
  ["mobile", MOBILE],
] as const) {
  for (const theme of THEMES) {
    test.describe(`accessibility: legal pages color-contrast (axe) — ${size} / ${theme} mode`, () => {
      test.use({ viewport });

      for (const route of LEGAL_ROUTES) {
        test(`zero color-contrast violations: ${route.path} (${size}/${theme})`, async ({
          page,
        }) => {
          await setTheme(page, theme);
          await gotoLegal(page, route.path, route.heading);
          await expectThemeApplied(page, theme);
          expectNoContrastViolations(await scanColorContrast(page));
        });
      }
    });
  }
}

// Full WCAG A/AA ruleset — heading order, landmarks, link names, the things the
// contrast-only pass cannot see. One width/theme: these rules are geometry- and
// palette-independent, and the rule that does vary is asserted at zero above.
test.describe("accessibility: legal pages (axe, full WCAG ruleset)", () => {
  test.use({ viewport: DESKTOP });

  for (const route of LEGAL_ROUTES) {
    test(`no new serious/critical violations: ${route.path}`, async ({
      page,
    }) => {
      await gotoLegal(page, route.path, route.heading);
      await scanA11y(page, `legal:${route.path}`);
    });
  }
});

// The structural claims the render tests make in jsdom, re-checked in a real
// browser where they actually matter: a fragment jump has to land ON the heading,
// which is what makes a 17-section document navigable by keyboard.
test.describe("accessibility: legal page navigation", () => {
  test.use({ viewport: DESKTOP });

  for (const route of LEGAL_ROUTES) {
    test(`contents links move focus to the heading they target: ${route.path}`, async ({
      page,
    }) => {
      await gotoLegal(page, route.path, route.heading);

      const firstEntry = page.locator('nav ol a[href^="#"]').first();
      const targetId = (await firstEntry.getAttribute("href"))!.slice(1);
      await firstEntry.click();

      // The heading carries tabIndex={-1} precisely so this is true; without it
      // the browser scrolls but leaves focus at the top of the document.
      await expect(page.locator(`h2#${targetId}`)).toBeFocused();
    });
  }
});
