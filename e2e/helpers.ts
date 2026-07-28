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
