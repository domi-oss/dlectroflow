import { test, expect } from "@playwright/test";

// Flow 5: open the hamburger nav and go to the Library hub.
// The nav link reads "Library" (nav.everything, plain voice) and routes to
// /library. Scope the click to the "Main" nav landmark — the first-run welcome
// card also renders a "Library" link, so a page-wide lookup is ambiguous.
test("navigates to the Library hub from the nav menu", async ({ page }) => {
  await page.goto("/inbox");

  await page.getByRole("button", { name: "Menu" }).click();
  await page
    .getByRole("navigation", { name: "Main" })
    .getByRole("link", { name: "Library" })
    .click();

  await page.waitForURL("**/library");
  await expect(
    page.getByRole("heading", { level: 1, name: "Library" }),
  ).toBeVisible();
});
