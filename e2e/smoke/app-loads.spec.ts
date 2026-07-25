import { test, expect } from "@playwright/test";
import { CAPTURE_PLACEHOLDER } from "../helpers";

// Flow 1: authenticated app loads and the inbox renders at the bare root.
// The inbox now lives at "/" (src/app/(app)/page.tsx); "/inbox" permanently
// redirects to "/" (next.config redirects()). Assert on always-present shell
// elements (brand link + capture bar), NOT on data-dependent section headers.
test("authenticated inbox renders at /", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("link", { name: "dlectroflow" })).toBeVisible();
  await expect(page.getByPlaceholder(CAPTURE_PLACEHOLDER)).toBeVisible();
});

// #58: the old "/inbox" URL must keep working (OAuth callbacks, bookmarks,
// external links) via a permanent redirect to "/".
test("/inbox permanently redirects to / (bookmarks + OAuth callbacks)", async ({
  page,
}) => {
  await page.goto("/inbox");
  await expect(page).toHaveURL(/^https?:\/\/[^/]+\/(\?.*)?$/);
  await expect(page.getByPlaceholder(CAPTURE_PLACEHOLDER)).toBeVisible();
});
