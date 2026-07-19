import { test, expect } from "@playwright/test";
import { captureItem, needsReviewRow } from "../helpers";

// Flow 4: complete an item. Create a fresh brain-dump item, then click its
// "Complete" button (not a checkbox) and assert it lands in the Completed bucket.
test("completing an item moves it to the Completed bucket", async ({ page }) => {
  const label = `E2E finish report ${Date.now()}`;
  await page.goto("/inbox");

  await captureItem(page, label);

  // Item appears in the Needs review bucket; complete it from there.
  const row = needsReviewRow(page, label);
  await expect(row).toBeVisible();
  await row.getByRole("button", { name: "Complete" }).click();

  await expect(page.locator('[data-bucket="completed"]')).toContainText(label);
});
