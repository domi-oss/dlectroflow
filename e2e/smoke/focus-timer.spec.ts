import { test, expect } from "@playwright/test";
import { captureItem, needsReviewRow } from "../helpers";

// Flow 3: focus timer start → pause (redesigned /focus timer, MR ②). Create a
// to-do, launch focus from it (navigates to /focus/{stepId}), start the timer,
// then pause it and assert the control toggles to Resume.
test("focus timer starts and pauses", async ({ page }) => {
  const label = `E2E focus task ${Date.now()}`;
  await page.goto("/");

  await captureItem(page, label);

  // Item appears in the Needs review bucket; triage it into a to-do.
  const row = needsReviewRow(page, label);
  await expect(row).toBeVisible();
  await row.getByRole("button", { name: "Add to-do" }).click();

  // It now lives in the single-task bucket with a Start Focus affordance.
  const todoRow = page
    .locator('[data-bucket="singleTask"]')
    .getByRole("listitem")
    .filter({ hasText: label });
  await expect(todoRow).toBeVisible();
  await todoRow.getByRole("button", { name: /Start Focus/ }).click();

  // ▶ Start Focus runs a server action (ensures the step exists) THEN
  // navigates — wait for the URL rather than asserting timer controls first.
  await page.waitForURL("**/focus/**");

  // Redesigned timer: a consistent ← Back returns to the focus launcher (no
  // server call — the session stays open/resumable).
  await expect(page.getByRole("link", { name: /back/i })).toHaveAttribute(
    "href",
    "/focus",
  );

  // The timer's own controls render their glyph as an aria-hidden lucide icon
  // and strip the leading glyph from the shared string, so the accessible name
  // is the bare text ("Start focusing", not "▶ Start focusing").
  await page.getByRole("button", { name: "Start focusing" }).click();

  // Complete-step + Pause/Resume are the on-page controls now; the old
  // "Pause for now" control + the gaveup screen were removed in the redesign.
  await expect(
    page.getByRole("button", { name: /complete step/i }),
  ).toBeVisible();

  // exact: true keeps these off the mini-player's "Play/Pause focus sound".
  await page.getByRole("button", { name: "Pause", exact: true }).click();
  // The ring/countdown are animated and time-dependent — assert only the
  // stable post-pause control state, relying on Playwright auto-waiting.
  await expect(
    page.getByRole("button", { name: "Resume", exact: true }),
  ).toBeVisible();
});
