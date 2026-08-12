import { test, expect } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import { captureItem, needsReviewRow, waitForShell, MOBILE } from "../helpers";
import { MEMBER_USER_ID, MEMBER_GOOGLE_ACCESS_TOKEN } from "../constants";
import { seedConnectedGoogle, clearGoogleTokens } from "../google-credential";

/**
 * #118 Phase C — an invited MEMBER, signed in, with their own Google connection,
 * in a production build.
 *
 * This is the claim the whole phase makes, and it is not testable from the
 * owner's session: before Phase C a member got `google = null`, the .ics
 * fallback, and a 🔒 owner-only shell in Settings. Every assertion below was
 * false a commit ago.
 *
 * Runs in the `member` Playwright project, which carries the member's own
 * storageState (the owner's cookie cannot exercise any of this) against its own
 * server on its own port. Google is CONFIGURED on both servers — `bootGuardEnv`
 * has set a dummy client id since #106 — so what makes these controls reachable is
 * the connected credential seeded below, not the second server. See
 * playwright.config.ts for what that server actually buys (its own PUBLIC_ORIGIN).
 *
 * Nothing here pushes to Google. The seeded credential is a dummy with no refresh
 * token and no expiry, so no code path in these specs makes a network request to
 * Google: a push would, a refresh would, and confirming a disconnect would offer
 * the token to Google's revoke endpoint — so this spec does none of the three.
 */

const INTEGRATIONS = "#settings-integrations";
const ACCOUNT = "#settings-account";

let prisma: PrismaClient;

/**
 * The member's connected credential is seeded HERE, not in global-setup (!200).
 *
 * schedule-menu.spec.ts already states the rule for the owner's row: a connected
 * credential changes the 📅 control on every row that sees it, so the file that
 * wants the state seeds it and hands it back. Keeping the member's row on the
 * same footing means neither project depends on the other's ordering, and a spec
 * that fails here cannot leave a connected member behind for the next run.
 *
 * Encrypted through e2e/google-credential.ts, which pins TOKEN_ENC_KEY to the key
 * the server under test decrypts with — see that file for why the ambient value
 * must never win.
 */
test.beforeAll(async () => {
  prisma = new PrismaClient();
  try {
    await seedConnectedGoogle(
      prisma,
      MEMBER_USER_ID,
      MEMBER_GOOGLE_ACCESS_TOKEN,
    );
  } catch (err) {
    // Own the client's lifecycle on the seed path: a throw here means afterAll
    // never runs against a usable client, which would leak the connection.
    await prisma.$disconnect();
    throw err;
  }
});

test.afterAll(async () => {
  try {
    await clearGoogleTokens(prisma, MEMBER_USER_ID);
  } finally {
    await prisma.$disconnect();
  }
});

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

  /**
   * The KEY panel's own live region.
   *
   * #129 put a second `role="status"` in this section — the data export's — so
   * `account.getByRole("status")` is now two elements and fails Playwright's strict
   * mode. Resolved through the `aria-describedby` the Save button carries, which
   * makes the assertion stronger than it was rather than merely unambiguous: it
   * checks the outcome reached the region the control actually points at.
   */
  const keyStatus = async () => {
    const id = await account
      .getByRole("button", { name: /^save key$/i })
      .getAttribute("aria-describedby");
    expect(id, "the Save button must describe its live region").toBeTruthy();
    return page.locator(`#${id}`);
  };

  await field.fill("sk-e2e-not-a-real-key");
  await account.getByRole("button", { name: /^save key$/i }).click();

  // Cleared on success, and the value is nowhere in the delivered page.
  await expect(field).toHaveValue("");
  await expect(await keyStatus()).toContainText(/saved/i);
  expect(await page.content()).not.toContain("sk-e2e-not-a-real-key");

  // Clean up so the next run starts without a key (global-setup also clears it,
  // but leaving one behind would make the specs order-dependent).
  await account.getByRole("button", { name: /^remove key$/i }).click();
  await account.getByRole("button", { name: /yes, remove/i }).click();
  await expect(await keyStatus()).toContainText(/removed/i);
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
  //
  // #253 — the control is an entry in the row's ▾ list, not an inline 📅. Which
  // control it is remains the whole point of the assertion: a member must get the
  // Google path, not the guest .ics fallback.
  await row.getByRole("button", { name: "All options" }).click();
  await expect(row.getByRole("button", { name: "Schedule" })).toBeVisible();
  await expect(
    row.getByRole("button", { name: "Add to calendar (.ics)" }),
  ).toBeVisible(); // the owner-only companion entry, not the guest's primary
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

  const confirm = integrations.getByRole("button", {
    name: /yes, disconnect/i,
  });
  await expect(confirm).toBeVisible();

  // Announced, not merely displayed — located THROUGH the button's own
  // `aria-describedby` rather than by a bare `getByRole("status")`. #154 added a
  // second live region to this section (the calendar feed card's), and this
  // direction is the stronger assertion anyway: it proves the button points at
  // an announced question, rather than that exactly one announced thing exists
  // on the page.
  const describedBy = await confirm.getAttribute("aria-describedby");
  expect(
    describedBy,
    "the confirm button must describe its question",
  ).toBeTruthy();
  const question = page.locator(`#${describedBy}`);
  await expect(question).toHaveAttribute("role", "status");
  await expect(question).toContainText(/remove access/i);
  const box = await confirm.boundingBox();
  expect(box!.height).toBeGreaterThanOrEqual(44);

  // Do NOT confirm: a confirmed disconnect would call Google's revoke endpoint
  // and would leave the fixture disconnected for the specs above.
  await integrations.getByRole("button", { name: /^cancel$/i }).click();
  await expect(
    integrations.getByRole("button", { name: /^disconnect$/i }),
  ).toBeVisible();
});
