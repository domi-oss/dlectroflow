import { test, expect } from "@playwright/test";
import { CAPTURE_PLACEHOLDER } from "../helpers";

// Flow 1: authenticated app loads and the inbox renders.
// "/" hard-redirects to "/inbox". Assert on always-present shell elements
// (brand link + capture bar), NOT on data-dependent section headers.
test("authenticated inbox renders", async ({ page }) => {
  await page.goto("/inbox");
  await expect(page.getByRole("link", { name: "dlectroflow" })).toBeVisible();
  await expect(page.getByPlaceholder(CAPTURE_PLACEHOLDER)).toBeVisible();
});
