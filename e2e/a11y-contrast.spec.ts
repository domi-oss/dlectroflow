import { test, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { captureItem, needsReviewRow } from "./helpers";

// Dedicated color-contrast gate for the #40 visual-identity-refresh palette
// (Phase 1.2), covering both themes. Distinct from the broader
// baseline-relative WCAG gate in e2e/a11y/axe-core-flow.spec.ts: this one
// checks only the `color-contrast` rule and asserts ZERO violations, with no
// allowlist — every real contrast issue on these routes must be fixed, not
// grandfathered in.

type Theme = "light" | "dark";
const THEMES: readonly Theme[] = ["light", "dark"];

// Sets df-theme in localStorage before the app's own scripts run, matching
// the inline bootstrap in src/app/layout.tsx
// (`localStorage.getItem('df-theme') === 'dark'`) and the toggle in
// src/components/theme-toggle.tsx. addInitScript re-runs on every subsequent
// navigation in this page, so it survives page.goto() calls after this.
async function setTheme(page: Page, theme: Theme): Promise<void> {
  await page.addInitScript((value: Theme) => {
    try {
      localStorage.setItem("df-theme", value);
    } catch {
      /* private mode etc. — matches the app's own best-effort persistence */
    }
  }, theme);
}

// Wait for the always-present app shell (the brand link in the shared
// header) so axe scans a fully-rendered page, not a hydrating one — mirrors
// e2e/a11y/axe-core-flow.spec.ts's waitForShell.
async function waitForShell(page: Page): Promise<void> {
  await expect(page.getByRole("link", { name: "dlectroflow" })).toBeVisible();
}

async function scanColorContrast(page: Page) {
  const results = await new AxeBuilder({ page })
    .withRules(["color-contrast"])
    .analyze();
  return results.violations;
}

function expectNoContrastViolations(
  violations: Awaited<ReturnType<typeof scanColorContrast>>,
): void {
  const report = violations
    .map(
      (v) =>
        `[${v.impact}] ${v.id} — ${v.help}\n` +
        v.nodes
          .map(
            (n) => `    at: ${n.target.join(" >>> ")}\n    ${n.failureSummary}`,
          )
          .join("\n"),
    )
    .join("\n");
  expect(violations, `color-contrast violations found:\n${report}`).toEqual([]);
}

for (const theme of THEMES) {
  test.describe(`accessibility: color-contrast (axe) — ${theme} mode`, () => {
    test.beforeEach(async ({ page }) => {
      await setTheme(page, theme);
    });

    const STATIC_ROUTES = [
      { path: "/inbox", name: "inbox / capture" },
      { path: "/settings", name: "settings" },
      { path: "/focus", name: "focus launcher" },
    ] as const;

    for (const route of STATIC_ROUTES) {
      test(`zero color-contrast violations: ${route.name} (${route.path})`, async ({
        page,
      }) => {
        await page.goto(route.path);
        await waitForShell(page);
        expectNoContrastViolations(await scanColorContrast(page));
      });
    }

    // The "Break into steps now?" CTA (bg-destructive + text-destructive-
    // foreground, src/components/inbox/inbox-view.tsx) only renders once an
    // item sits in the Multi-step bucket with 0 steps ("awaitingBreakdown" —
    // see inbox-view.tsx's `awaitingBreakdown = item.stepsTotal === 0`).
    // Drive the real UI path (capture → All options → Move to… → Multi-step
    // to-dos) instead of seeding DB state, so this scan exercises the exact
    // rendered DOM the dark-mode AA fix targets — in dark mode, white text on
    // --destructive was 3.52:1 (fails AA-normal 4.5:1); the fix swaps in the
    // --destructive-foreground token (near-black in dark, white in light).
    // We deliberately do NOT click the CTA itself — that starts the AI
    // breakdown flow, which needs ANTHROPIC_API_KEY (unavailable in this
    // e2e env, same constraint documented in e2e/a11y/axe-core-flow.spec.ts).
    test(`zero color-contrast violations: inbox "Break into steps now?" CTA (${theme})`, async ({
      page,
    }) => {
      const label = `A11y contrast destructive-cta ${theme} ${Date.now()}`;
      await page.goto("/inbox");
      await waitForShell(page);
      await captureItem(page, label);

      const row = needsReviewRow(page, label);
      await expect(row).toBeVisible();
      await row.getByRole("button", { name: "All options" }).click();
      await row.getByRole("button", { name: "Move to…" }).click();
      await row.getByRole("menuitem", { name: /Multi-step/ }).click();

      const multiStepRow = page
        .locator('[data-bucket="multiStep"]')
        .getByRole("listitem")
        .filter({ hasText: label });
      await expect(
        multiStepRow.getByRole("button", { name: "Break into steps now?" }),
      ).toBeVisible();

      expectNoContrastViolations(await scanColorContrast(page));
    });

    // NOT covered here, deliberately: the settings "Yes, disconnect" confirm
    // CTA (src/components/settings/integrations-panel.tsx) — also
    // bg-destructive + text-destructive-foreground, same token pairing fixed
    // above — only renders when Google Tasks is both configured AND
    // connected (`canDisconnect = google.connected`). The e2e boot env (see
    // bootGuardEnv in playwright.config.ts) sets no GOOGLE_CLIENT_ID/SECRET,
    // so `google.configured` is always false here and IntegrationsPanel never
    // renders a Disconnect control at all — reaching the confirm state would
    // need a live OAuth connection seeded in the DB, out of scope for this
    // gate. It shares the exact same --destructive / --destructive-foreground
    // pairing as the inbox CTA above, so the fix verified there applies here
    // too.
  });
}
