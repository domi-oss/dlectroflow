import { expect, type Page } from "@playwright/test";
import { waitForShell } from "./helpers";

/**
 * The member's Account section, shared by the two specs that drive it (#247).
 *
 * Extracted rather than duplicated because the two live in different Playwright
 * projects and Playwright refuses to let one spec file import another:
 *
 *   * `e2e/smoke/member-delete-account.spec.ts` (`member`, retries inherited) —
 *     that the dialog exists, reads correctly, and cancels without writing.
 *   * `e2e/a11y/axe-account-deletion.spec.ts` (`a11y`, `retries: 0`) — the axe
 *     scan and the WCAG 2.5.5 target-size floor, which were in the file above and
 *     retry-masked there.
 *
 * NOTHING in either spec confirms the deletion. `e2e-member-user` is a shared
 * fixture: confirming would freeze it, `currentUser()` would then resolve to
 * `null`, and `member-google`'s specs would find a signed-out shell while
 * `people-admin`'s would find a Revoked pill where they expect Active. The
 * confirm path would also offer any seeded Google token to Google's revoke
 * endpoint, which is the one thing the member specs are built never to do.
 */

const ACCOUNT_SECTION = "settings-account";

/** Every /settings section is a disclosure (#101) and they all rest closed. */
export async function openAccountSection(page: Page): Promise<void> {
  await page.goto("/settings");
  await waitForShell(page);
  const toggle = page.locator(`[data-section-toggle="${ACCOUNT_SECTION}"]`);
  await expect(toggle).toBeVisible();
  if ((await toggle.getAttribute("aria-expanded")) !== "true") {
    await toggle.click();
  }
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
}

/**
 * The "Delete my account" button.
 *
 * Reached from the section's anchor through its ancestor `<section>` because the
 * id sits on the heading, not on the region that holds the control.
 */
export function deleteAccountTrigger(page: Page) {
  return page
    .locator(`#${ACCOUNT_SECTION}`)
    .locator("xpath=ancestor::section")
    .getByRole("button", { name: /^delete my account$/i });
}

/** Open the confirmation and wait for it to be on screen. */
export async function openDeleteAccountDialog(page: Page) {
  await openAccountSection(page);
  await deleteAccountTrigger(page).click();
  const dialog = page.getByRole("alertdialog");
  await expect(dialog).toBeVisible();
  return dialog;
}
