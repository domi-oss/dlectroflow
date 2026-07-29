import { test, expect } from "@playwright/test";
import { captureItem, needsReviewRow, waitForShell, MOBILE } from "../helpers";

/**
 * #118 Phase C — an invited MEMBER, signed in, with their own Google connection,
 * in a production build.
 *
 * This is the claim the whole phase makes, and it is not testable from the
 * owner's session: before Phase C a member got `google = null`, the .ics
 * fallback, and a 🔒 owner-only shell in Settings. Every assertion below was
 * false a commit ago.
 *
 * Runs in the `member-google` Playwright project, against its own server: that
 * server is the one with a dummy GOOGLE_CLIENT_ID, which is what makes the Google
 * method offered at all. See playwright.config.ts for why it is a second server
 * rather than two extra variables on the shared one.
 *
 * Nothing here pushes to Google. The seeded credential is a dummy with no refresh
 * token and no expiry, so no code path in these specs makes a network request to
 * Google: a push would, a refresh would, and confirming a disconnect would offer
 * the token to Google's revoke endpoint — so this spec does none of the three.
 */

const INTEGRATIONS = "#settings-integrations";
const ACCOUNT = "#settings-account";

/** The Integrations section, expanded. Every settings section is a disclosure
 *  (#101) and they all rest closed, so a spec has to open the one it is about. */
async function openSection(
  page: import("@playwright/test").Page,
  id: string,
): Promise<void> {
  await page.goto("/settings");
  await waitForShell(page);
  const toggle = page.locator(`[data-section-toggle="${id.slice(1)}"]`);
  await expect(toggle).toBeVisible();
  if ((await toggle.getAttribute("aria-expanded")) !== "true") {
    await toggle.click();
  }
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
}

test("a member's Settings shows THEIR OWN Google connection, not a locked shell", async ({
  page,
}) => {
  await openSection(page, INTEGRATIONS);

  const integrations = page
    .locator(INTEGRATIONS)
    .locator("xpath=ancestor::section");
  // The 🔒 shell is what a member used to get. Its absence is the fix.
  await expect(integrations.getByText(/owner-only/i)).toHaveCount(0);
  await expect(
    integrations.getByText("Connected", { exact: true }),
  ).toBeVisible();
  await expect(
    integrations.getByRole("button", { name: /^disconnect$/i }),
  ).toBeVisible();
  // And the copy says the connection is theirs, not the instance's.
  await expect(integrations.getByText(/your own google tasks/i)).toBeVisible();
});

test("a member's Account section offers a key field and never echoes one", async ({
  page,
}) => {
  await openSection(page, ACCOUNT);

  const account = page.locator(ACCOUNT).locator("xpath=ancestor::section");
  const field = account.getByLabel(/api key/i);
  await expect(field).toHaveAttribute("type", "password");

  await field.fill("sk-e2e-not-a-real-key");
  await account.getByRole("button", { name: /^save key$/i }).click();

  // Cleared on success, and the value is nowhere in the delivered page.
  await expect(field).toHaveValue("");
  await expect(account.getByRole("status")).toContainText(/saved/i);
  expect(await page.content()).not.toContain("sk-e2e-not-a-real-key");

  // Clean up so the next run starts without a key (global-setup also clears it,
  // but leaving one behind would make the specs order-dependent).
  await account.getByRole("button", { name: /^remove key$/i }).click();
  await account.getByRole("button", { name: /yes, remove/i }).click();
  await expect(account.getByRole("status")).toContainText(/removed/i);
});

test("a member's inbox calendar control leads with Google, not the .ics fallback", async ({
  page,
}) => {
  const label = `E2E member ${Date.now()}`;
  await page.goto("/");
  await waitForShell(page);
  await captureItem(page, label);
  const row = needsReviewRow(page, label);
  await expect(row).toBeVisible();
  // Before #118 this row showed "Add to calendar (.ics)" for a member, because
  // the page handed them `google = null`.
  await expect(row.getByRole("button", { name: "Schedule" })).toBeVisible();
});

test("the disconnect confirmation is reachable and reads correctly at 390px", async ({
  page,
}) => {
  // e2e/a11y-contrast.spec.ts documented this control as unreachable because no
  // environment could have Google connected. This one can.
  await page.setViewportSize(MOBILE);
  await openSection(page, INTEGRATIONS);

  const integrations = page
    .locator(INTEGRATIONS)
    .locator("xpath=ancestor::section");
  await integrations.getByRole("button", { name: /^disconnect$/i }).click();

  // Announced, not merely displayed.
  await expect(integrations.getByRole("status")).toContainText(
    /remove access/i,
  );
  const confirm = integrations.getByRole("button", {
    name: /yes, disconnect/i,
  });
  await expect(confirm).toBeVisible();
  const box = await confirm.boundingBox();
  expect(box!.height).toBeGreaterThanOrEqual(44);

  // Do NOT confirm: a confirmed disconnect would call Google's revoke endpoint
  // and would leave the fixture disconnected for the specs above.
  await integrations.getByRole("button", { name: /^cancel$/i }).click();
  await expect(
    integrations.getByRole("button", { name: /^disconnect$/i }),
  ).toBeVisible();
});
