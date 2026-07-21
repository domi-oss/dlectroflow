import { test, expect, type Page } from "@playwright/test";
import { captureItem, needsReviewRow } from "../helpers";
import { scanA11y } from "./axe-helpers";

// Mechanical accessibility (axe) gate over the core flow (issue #31):
//   inbox/capture → clarify → schedule → focus → reward.
// Runs inside the existing e2e_test CI job (any *.spec.ts under testDir), reusing
// the forged-owner session + next-start webServer from the smoke harness. Each
// scan fails only on NEW serious/critical violations vs. e2e/a11y/axe-baseline.json.
//
// reducedMotion keeps intro animations from being scanned mid-transition, which
// makes the axe snapshot deterministic across local + CI runs.
test.use({ contextOptions: { reducedMotion: "reduce" } });

// Wait for the always-present app shell (the brand link in the shared header)
// so axe scans a fully-rendered page, not a hydrating one.
async function waitForShell(page: Page): Promise<void> {
  await expect(page.getByRole("link", { name: "dlectroflow" })).toBeVisible();
}

test.describe("accessibility: core-flow routes (axe)", () => {
  // Statically-reachable core routes. inbox = capture, /focus = focus launcher,
  // /dashboard = reward; /library is the core navigation hub.
  const STATIC_ROUTES = [
    { path: "/inbox", name: "inbox / capture" },
    { path: "/library", name: "library hub" },
    { path: "/focus", name: "focus launcher" },
    { path: "/dashboard", name: "reward / dashboard" },
  ] as const;

  for (const route of STATIC_ROUTES) {
    test(`no new serious/critical violations: ${route.name} (${route.path})`, async ({ page }) => {
      await page.goto(route.path);
      await waitForShell(page);
      await scanA11y(page, route.path);
    });
  }

  // clarify + schedule live on the task-detail page. "Break into steps →" runs a
  // server action that creates the task (no AI required) and navigates to
  // /tasks/[taskId], which renders the breakdown/clarify editor and the schedule
  // control together.
  //
  // We scan the editor in *manual* mode (?edit=1&manual=1): it skips the AI
  // auto-request (no /api/breakdown call) and seeds one blank step, so the DOM is
  // fully deterministic — a stable, repeatable axe snapshot in both local + CI
  // (neither has an ANTHROPIC_API_KEY for the e2e run). The default AI-chat mode
  // renders differently depending on network/stream timing and is not a reliable
  // gate surface.
  test("no new serious/critical violations: clarify + schedule (/tasks/[taskId])", async ({
    page,
  }) => {
    const label = `A11y clarify ${Date.now()}`;
    await page.goto("/inbox");
    await captureItem(page, label);

    const row = needsReviewRow(page, label);
    await expect(row).toBeVisible();
    await row.getByRole("button", { name: /Break into steps/ }).click();
    await page.waitForURL("**/tasks/**");

    // Re-open the same task in the deterministic manual editor.
    const taskPath = new URL(page.url()).pathname;
    await page.goto(`${taskPath}?edit=1&manual=1`);
    await waitForShell(page);
    await expect(page.getByRole("textbox", { name: "Step text" })).toBeVisible();
    await scanA11y(page, "/tasks/[taskId]");
  });

  // focus timer. Triage a fresh item into a single to-do, then "▶ Start Focus"
  // lazily creates its one step and navigates to /focus/[stepId] (the timer).
  test("no new serious/critical violations: focus timer (/focus/[stepId])", async ({ page }) => {
    const label = `A11y focus ${Date.now()}`;
    await page.goto("/inbox");
    await captureItem(page, label);

    const row = needsReviewRow(page, label);
    await expect(row).toBeVisible();
    await row.getByRole("button", { name: "Add to-do" }).click();

    const todoRow = page
      .locator('[data-bucket="singleTask"]')
      .getByRole("listitem")
      .filter({ hasText: label });
    await expect(todoRow).toBeVisible();
    await todoRow.getByRole("button", { name: /Start Focus/ }).click();

    await page.waitForURL("**/focus/**");
    await waitForShell(page);
    // Wait for the timer page's own content (its <h1> step heading), not just the
    // shared app shell, so axe scans a fully-hydrated page — mirrors the clarify
    // test's wait on the "Step text" field. (The countdown span has no ARIA role.)
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    await scanA11y(page, "/focus/[stepId]");
  });
});
