import { test, expect } from "@playwright/test";
import { captureItem, needsReviewRow } from "../helpers";

// Flow 2: brain-dump capture (Enter to submit) then triage into a to-do.
// The capture bar has no submit button. New items land in "Needs review";
// "Add to-do" moves the item into the single-task bucket.
test("brain-dump item triages into a single-task to-do", async ({ page }) => {
  const label = `E2E buy milk ${Date.now()}`;
  await page.goto("/");

  await captureItem(page, label);

  // Item appears in the Needs review bucket; triage it.
  const row = needsReviewRow(page, label);
  await expect(row).toBeVisible();
  await row.getByRole("button", { name: "Add to-do" }).click();

  // It now lives in the single-task bucket with a Start Focus affordance.
  const singleTask = page.locator('[data-bucket="singleTask"]');
  await expect(singleTask).toContainText(label);
  await expect(
    singleTask
      .getByRole("listitem")
      .filter({ hasText: label })
      .getByRole("button", { name: /Start Focus/ }),
  ).toBeVisible();
});
