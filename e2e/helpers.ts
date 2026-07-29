import { expect, type Page } from "@playwright/test";

// Shared across the smoke specs: the capture bar's placeholder text, the
// capture-then-Enter step it takes to create a brain-dump item, and the
// Needs-review row locator specs assert on right after capturing. Kept
// minimal — only what's genuinely repeated across specs; anything that
// diverges (e.g. the single-task row lookups) stays local to its spec.
export const CAPTURE_PLACEHOLDER = "Brain dump anything… (Enter to save)";

// Capture a brain-dump item. The capture bar has no submit button — Enter
// saves it. Callers assert on the resulting row themselves.
export async function captureItem(page: Page, label: string): Promise<void> {
  const capture = page.getByPlaceholder(CAPTURE_PLACEHOLDER);
  await capture.fill(label);
  await capture.press("Enter");
}

// Locate a captured item's row in the Needs review bucket by its label.
export function needsReviewRow(page: Page, label: string) {
  return page
    .locator('[data-bucket="needsReview"]')
    .getByRole("listitem")
    .filter({ hasText: label });
}

// ── Shared viewports / theme / shell helpers ────────────────────────────────
// Extracted for #90: the guest axe pass needs the same two viewports, the same
// theme bootstrap and the same "is the shell rendered?" wait that
// e2e/smoke/section-nav.spec.ts and e2e/a11y-contrast.spec.ts had each grown
// their own copy of. One definition, so a fix lands everywhere.

export const MOBILE = { width: 390, height: 844 }; // iPhone 14-ish
export const DESKTOP = { width: 1280, height: 900 };

export type Theme = "light" | "dark";
export const THEMES: readonly Theme[] = ["light", "dark"];

/**
 * Sets df-theme in localStorage before the app's own scripts run, matching the
 * inline bootstrap in src/app/layout.tsx (`localStorage.getItem('df-theme') ===
 * 'dark'`) and the toggle in src/components/theme-toggle.tsx. addInitScript
 * re-runs on every subsequent navigation in this page, so it survives
 * page.goto() calls after this — but it must be called BEFORE the first goto.
 */
export async function setTheme(page: Page, theme: Theme): Promise<void> {
  await page.addInitScript((value: Theme) => {
    try {
      localStorage.setItem("df-theme", value);
    } catch {
      /* private mode etc. — matches the app's own best-effort persistence */
    }
  }, theme);
}

/**
 * Guard the precondition of any theme-scoped assertion: a silently-light "dark"
 * scan is worse than no scan, because it looks like it was checked.
 */
export async function expectThemeApplied(
  page: Page,
  theme: Theme,
): Promise<void> {
  expect(
    await page.evaluate(() =>
      document.documentElement.classList.contains("dark"),
    ),
    `expected the ${theme} theme to be applied (html.dark = ${theme === "dark"})`,
  ).toBe(theme === "dark");
}

/**
 * Wait for the always-present app shell (the brand link in the shared header)
 * so assertions and axe scans see a fully-rendered page, not a hydrating one.
 */
export async function waitForShell(page: Page): Promise<void> {
  await expect(page.getByRole("link", { name: "dlectroflow" })).toBeVisible();
}

// ── #101: every /settings section is a disclosure ───────────────────────────

/**
 * One section's disclosure trigger, by the stable hook `<SectionHeading>` puts on
 * it. Located by attribute rather than by accessible name on purpose: the name is
 * now the section's title, which the "Jump to…" nav also renders as a link, so a
 * by-name locator would be ambiguous.
 */
export function sectionToggle(page: Page, id: string) {
  return page.locator(`[data-section-toggle="${id}"]`);
}

/** Open one section and wait for its body to actually be on screen. */
export async function expandSection(page: Page, id: string): Promise<void> {
  const toggle = sectionToggle(page, id);
  if ((await toggle.getAttribute("aria-expanded")) === "true") return;
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
}

/**
 * Open EVERY section on /settings.
 *
 * The contrast and a11y gates need this: collapsing eight of nine sections takes
 * most of the page's controls out of the scanned DOM (axe correctly skips a
 * `hidden` subtree), so a scan of the resting page would be quietly narrower
 * than the one it replaced — the #90 lesson, arrived at from the other direction.
 */
export async function expandAllSections(page: Page): Promise<void> {
  const toggles = page.locator("[data-section-toggle]");
  const count = await toggles.count();
  expect(count, "no collapsible sections found").toBeGreaterThan(1);
  for (let i = 0; i < count; i++) {
    const toggle = toggles.nth(i);
    if ((await toggle.getAttribute("aria-expanded")) !== "true") {
      await toggle.click();
    }
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
  }
  // Clicking the last section's header scrolled the page down to reach it, and
  // (#101) named that section the current one. Leave the page where the caller
  // found it — at the top, with the scroll-spy back in charge — so "expand
  // everything" is a change of STATE and not also a change of scroll position.
  //
  // Both halves of that have to be WAITED for, which this did not do, and the
  // omission was a live flake in a zero-tolerance gate:
  //
  //  • The nav opts into `scroll-behavior: smooth`, so `scrollTo(0, 0)` is
  //    ASYNCHRONOUS — this returned with the page still ~1400px down (measured).
  //  • The heading band the last click highlighted takes on the magenta
  //    `[data-current]` treatment, and its TITLE transitions to
  //    `--primary-foreground` over the transition duration while the band's
  //    background is magenta immediately. Sampled in flight that is dark text on
  //    magenta — 3.08:1 light / 2.23:1 dark, reported by axe against
  //    `button[data-section-toggle="settings-demo"] > .truncate`. The SETTLED
  //    pairing is white on magenta, the documented AA combination (globals.css),
  //    so the violation only ever existed mid-transition.
  //
  // Same class of problem this file's callers already handle with
  // `reducedMotion: "reduce"` — which suppresses animations, not
  // `transition-colors`. So: scroll instantly, wait for it to land, and wait for
  // any highlighted band's title to finish catching up with it.
  await page.evaluate(() =>
    window.scrollTo({ top: 0, left: 0, behavior: "instant" }),
  );
  await expect
    .poll(() => page.evaluate(() => window.scrollY), {
      message: "the page never came back to the top",
    })
    .toBe(0);
  await page.waitForFunction(() => {
    const band = document.querySelector("[data-section-header][data-current]");
    if (!band) return true; // nothing highlighted — nothing in transition
    const title = band.querySelector("[data-section-toggle] .truncate");
    if (!title) return true;
    // Descendants of a highlighted band are forced to `currentColor`, so a
    // settled title's computed colour IS the band's.
    return getComputedStyle(title).color === getComputedStyle(band).color;
  });
}
