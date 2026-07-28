import { test, expect, type Page } from "@playwright/test";
import {
  DESKTOP,
  MOBILE,
  THEMES,
  setTheme,
  expectThemeApplied,
  waitForShell,
} from "../helpers";
import {
  scanA11y,
  scanColorContrast,
  expectNoContrastViolations,
} from "./axe-helpers";

// #90 — axe coverage for GUEST-ONLY UI.
//
// The blind spot this closes: every other spec in the suite runs with the forged
// OWNER storageState (e2e/global-setup.ts, wired in playwright.config.ts's
// `use`), so the guest chrome has never once been in a scanned DOM — not in the
// baseline-relative WCAG gate (e2e/a11y/axe-core-flow.spec.ts) and not in the
// zero-tolerance contrast gate (e2e/a11y-contrast.spec.ts). That is exactly how
// #73's guest banner shipped to production at 2.44:1 in dark mode: nothing
// looked, and a human eyeballing screenshots found it.
//
// No auth trick is needed to be a guest. src/proxy.ts mints a signed guest JWT
// for any request that arrives without the `df_owner` cookie, so a context with
// NO storage state IS a first-time visitor — the same opt-out
// e2e/smoke/guest-unaffected.spec.ts uses. The opt-out is deliberate and load
// bearing: inheriting the config default would silently scan owner UI here and
// stay green.
//
// reducedMotion keeps intro animations from being scanned mid-transition, which
// makes the axe snapshot deterministic across local + CI runs (mirrors
// e2e/a11y/axe-core-flow.spec.ts).
test.use({
  storageState: { cookies: [], origins: [] },
  contextOptions: { reducedMotion: "reduce" },
});

/** The expanded banner, located by its own copy (src/components/guest/guest-indicator.tsx). */
function expandedBanner(page: Page) {
  return page.getByText(/you're in guest mode/i);
}

/**
 * The collapsed pill. It is a <button> whose accessible name comes from its text
 * content ("🎫 Guest · ⚡ 5/5 breakdowns · ⏳ 23h 59m left"), not from its
 * `title`, so match on the stable middle of that string.
 */
function collapsedPill(page: Page) {
  return page.getByRole("button", { name: /breakdowns/ });
}

/**
 * Land on `path` as a guest with the banner EXPANDED and hydration finished.
 *
 * The banner's pre-hydration snapshot is deliberately the collapsed one
 * (getServerDismissed() returns true so a guest who already dismissed it cannot
 * see it flash in), so waiting for the app shell is not enough — waiting for the
 * expanded copy is what proves React has hydrated.
 *
 * It doubles as the "am I really a guest?" precondition: src/app/(app)/layout.tsx
 * renders <GuestIndicator> only when currentUser() is null, so if this spec ever
 * lost its storageState opt-out and inherited the forged owner session, there
 * would be no banner and these scans would fail loudly instead of quietly
 * scanning owner UI.
 */
async function gotoAsGuest(page: Page, path: string): Promise<void> {
  await page.goto(path);
  await waitForShell(page);
  await expect(expandedBanner(page)).toBeVisible();
}

/** Dismiss the expanded banner to reach the collapsed pill, the way a guest does. */
async function collapseBanner(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Dismiss" }).click();
  await expect(expandedBanner(page)).toHaveCount(0);
  await expect(collapsedPill(page)).toBeVisible();
}

// The gate that would have caught #73. Guest surfaces now sit on the same
// ZERO-tolerance `color-contrast` footing as the owner's /settings and /help,
// across both banner states × both themes × both viewport widths.
//
// Both states matter and are not interchangeable: they use different tints
// (bg-amber-500/10 + dark:bg-amber-950/20 expanded vs bg-amber-500/5 +
// dark:bg-amber-950/10 collapsed) behind the SAME text colour, so the collapsed
// pill has the lower-contrast background of the two, and different markup (a
// <div> of paragraphs vs a single <button> line at text-xs, which is the size
// AA judges at 4.5:1). Width matters because the banner reflows at 390px, which
// is where the dismiss control and the pill sit next to different neighbours.
for (const [size, viewport] of [
  ["desktop", DESKTOP],
  ["mobile", MOBILE],
] as const) {
  for (const theme of THEMES) {
    test.describe(`accessibility: guest color-contrast (axe) — ${size} / ${theme} mode`, () => {
      test.use({ viewport });

      test.beforeEach(async ({ page }) => {
        await setTheme(page, theme);
      });

      test(`zero color-contrast violations: guest banner expanded (${size}/${theme})`, async ({
        page,
      }) => {
        await gotoAsGuest(page, "/");
        await expectThemeApplied(page, theme);
        expectNoContrastViolations(await scanColorContrast(page));
      });

      test(`zero color-contrast violations: guest banner collapsed pill (${size}/${theme})`, async ({
        page,
      }) => {
        await gotoAsGuest(page, "/");
        await expectThemeApplied(page, theme);
        await collapseBanner(page);
        expectNoContrastViolations(await scanColorContrast(page));
      });
    });
  }
}

// The rest of the guest chrome, at one width — these routes are guest-only
// *variants*, not guest-only widths, so the 2×2 matrix above would be
// duplication. /settings is a genuinely different page for a guest: #11 renders
// the breakdown-model picker and the integrations section as a read-only shell.
// That paid for itself immediately — the very first run of this gate caught the
// guest integrations card, washed in `opacity-70`, holding its muted copy and
// its "Owner-only" pill at 2.74:1–2.88:1 (light) / 4.42:1 (dark) against AA's
// 4.5:1: the same compositing mistake #56 fixed on the saved-for-later row, live
// on main and invisible to the owner-session gate. Fixed in
// src/components/settings/integrations-panel.tsx. /help is the other route the
// owner gate already covers, so its guest rendering joins on the same footing.
// "/" is covered by the banner matrix above.
for (const theme of THEMES) {
  test.describe(`accessibility: guest routes color-contrast (axe) — ${theme} mode`, () => {
    test.use({ viewport: DESKTOP });

    test.beforeEach(async ({ page }) => {
      await setTheme(page, theme);
    });

    const GUEST_ROUTES = [
      { path: "/settings", name: "settings (guest read-only shell)" },
      { path: "/help", name: "help" },
    ] as const;

    for (const route of GUEST_ROUTES) {
      test(`zero color-contrast violations: ${route.name} (${route.path})`, async ({
        page,
      }) => {
        await gotoAsGuest(page, route.path);
        await expectThemeApplied(page, theme);
        expectNoContrastViolations(await scanColorContrast(page));
      });
    }
  });
}

// Full WCAG A/AA ruleset over the same two banner states — names, roles, labels
// and the rest, which the contrast-only gate above cannot see. Run at one
// width/theme on purpose: these rules are geometry- and palette-independent, and
// the contrast rule (the one that does vary) is already asserted at zero across
// the whole matrix above. Baseline-relative like the core-flow pass, so a new
// serious/critical violation in guest markup fails the gate.
test.describe("accessibility: guest surfaces (axe, full WCAG ruleset)", () => {
  test.use({ viewport: DESKTOP });

  test("no new serious/critical violations: guest banner expanded", async ({
    page,
  }) => {
    await gotoAsGuest(page, "/");
    await scanA11y(page, "guest:/ (banner expanded)");
  });

  test("no new serious/critical violations: guest banner collapsed", async ({
    page,
  }) => {
    await gotoAsGuest(page, "/");
    await collapseBanner(page);
    await scanA11y(page, "guest:/ (banner collapsed)");
  });
});

// The guard on the guard. Every scan above depends on this context NOT carrying
// the forged owner cookie; if the storageState opt-out at the top of this file
// were dropped, the banner locators would start failing with a timeout, which
// reads like a flake. Assert the actual precondition once, so the failure names
// its own cause.
test.describe("accessibility: guest scan preconditions", () => {
  test("the guest scans carry no owner session (never the forged storageState)", async ({
    page,
    context,
  }) => {
    await page.goto("/");
    await waitForShell(page);

    const cookies = (await context.cookies()).map((c) => c.name);
    expect(
      cookies,
      "df_owner must not be present in a guest context",
    ).not.toContain("df_owner");
    // …and the app agrees it is looking at an anonymous visitor.
    await expect(page.getByRole("link", { name: /^sign in$/i })).toBeVisible();
    await expect(page.getByRole("link", { name: /^account$/i })).toHaveCount(0);
  });
});
