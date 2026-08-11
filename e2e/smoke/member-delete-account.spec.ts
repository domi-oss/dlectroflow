import { test, expect } from "@playwright/test";
import {
  openAccountSection,
  deleteAccountTrigger as trigger,
} from "../member-account-fixture";

/**
 * #153 — the member's own "Delete my account" control, in a production build.
 *
 * Runs in the `member` Playwright project: the owner's session renders the
 * refusal sentence instead of the control, so none of this is reachable from
 * the session every other smoke spec uses.
 *
 * ── NOTHING HERE CONFIRMS THE DELETION ──────────────────────────────────────
 *
 * `e2e-member-user` is a SHARED FIXTURE. Confirming would freeze it, and a
 * frozen account resolves to `null` in `currentUser()` — so `member-google`'s
 * specs would find a signed-out shell, `people-admin`'s would find a Revoked
 * pill where they expect Active, and the run would only go green again after a
 * re-seed. The confirm path would also offer any seeded Google token to
 * Google's revoke endpoint, which is the one thing the member specs are
 * carefully built never to do. The same rule the People panel's revoke
 * confirmation already follows (see e2e/constants.ts on MEMBER_USER_ID): open
 * it, read it, cancel it.
 *
 * The action itself — who may call it, whose row it writes, and that the
 * Google grant is withdrawn first — is covered by
 * src/app/actions/account.test.ts, where it can be driven without a fixture to
 * destroy.
 */

test("a member's Account section offers a real Delete my account dialog", async ({
  page,
}) => {
  await openAccountSection(page);
  await trigger(page).click();

  // `role="alertdialog"`, not a `dialog` and not a bare confirm(): this is an
  // interruption, and a screen reader is told so.
  const dialog = page.getByRole("alertdialog", {
    name: /delete your account/i,
  });
  await expect(dialog).toBeVisible();

  // What is destroyed, what is retained, and the honest note about the last
  // step — the sentences are the feature, so their absence is a failure.
  await expect(dialog).toContainText(/cannot sign back in/i);
  await expect(dialog).toContainText(/asks Google to revoke/i);
  await expect(dialog).toContainText(/30 days/);
  await expect(dialog).toContainText(/by hand/i);
  // WCAG 1.4.1 — the destructive read survives without colour.
  await expect(dialog).toContainText(/permanent/i);

  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
});

test("the dialog needs a typed word, and Escape returns focus to the trigger", async ({
  page,
}) => {
  await openAccountSection(page);
  await trigger(page).click();

  const dialog = page.getByRole("alertdialog");
  const confirm = dialog.getByRole("button", { name: /^delete my account$/i });
  // Two deliberate acts. Opening the dialog is not the second one.
  await expect(confirm).toBeDisabled();

  await dialog.getByLabel(/type/i).fill("delete");
  await expect(confirm).toBeEnabled();

  // The escape route, and the thing an inline confirmation row cannot do: focus
  // goes back where it came from rather than falling to <body>.
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(trigger(page)).toBeFocused();

  // Reopening must not find the word still typed — that would collapse the two
  // acts back into one for anybody who changed their mind and came back.
  await trigger(page).click();
  await expect(
    page.getByRole("alertdialog").getByRole("button", {
      name: /^delete my account$/i,
    }),
  ).toBeDisabled();
  await page
    .getByRole("alertdialog")
    .getByRole("button", { name: /^cancel$/i })
    .click();
  await expect(page.getByRole("alertdialog")).toBeHidden();
});

// The 390px axe scan and the WCAG 2.5.5 target-size floor moved to
// e2e/a11y/axe-account-deletion.spec.ts (#247). They are AA assertions, and this
// project inherits the suite-wide retry — which makes a real regression
// indistinguishable from a flake. That spec carries a `test.use` override for the
// member's session so it can run in the zero-retry `a11y` project.
