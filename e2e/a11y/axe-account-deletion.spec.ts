import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { MOBILE } from "../helpers";
import { MEMBER_STORAGE_STATE, MEMBER_BASE_URL } from "../constants";
import { WCAG_TAGS } from "./axe-helpers";
import { openDeleteAccountDialog } from "../member-account-fixture";

/**
 * The member's "Delete my account" confirmation, held to the accessibility gate
 * (#247).
 *
 * This was one test inside `e2e/smoke/member-delete-account.spec.ts`, which runs
 * in the `member` project — where the suite-wide `retries` applies. It is the
 * escapee #247's audit turned up that the issue did not know about, and the one a
 * guard keyed on `e2e/a11y/axe-helpers.ts` could never have caught: it imported
 * `@axe-core/playwright` and built its own `AxeBuilder`, touching the helper
 * module not at all. So the guard in `src/lib/e2e-project-split.test.ts` is keyed
 * on the PACKAGE, which everything that scans has to go through.
 *
 * ── Why a `test.use` override instead of a fourth project ────────────────────
 * The `member` project exists to supply the member's session and its own server
 * (`MEMBER_STORAGE_STATE`, `MEMBER_BASE_URL`); the `a11y` project runs as the
 * owner, who gets the refusal sentence here rather than the control. Both of
 * those are `use` options, so a per-file override buys the member's session
 * inside the zero-retry project without a fourth project to keep ordered and in
 * `dependencies`. Both servers are started before any project runs — they are
 * `webServer` entries, not project fixtures — so the second one is already
 * listening.
 *
 * The filename deliberately avoids the `member-` prefix: `MEMBER_SPECS` is
 * `/member-[\w-]+\.spec\.ts/` and unanchored, so `axe-member-account.spec.ts`
 * would have matched it AND `A11Y_SPECS`, and a doubly-claimed spec runs twice —
 * the second time with a retry, which is the whole defect. `e2e-project-split`'s
 * `doubleRoutedSpecs` guard would have caught it; better not to need it.
 *
 * NOTHING here confirms the deletion — see `e2e/member-account-fixture.ts` for
 * what confirming would do to the shared member fixture.
 */

test.use({
  storageState: MEMBER_STORAGE_STATE,
  baseURL: MEMBER_BASE_URL,
  viewport: MOBILE,
});

test("the delete-account dialog is usable and axe-clean at 390px", async ({
  page,
}) => {
  // 390px is the device most of this app is used on, and a modal with its
  // buttons past the fold is a modal you cannot answer.
  const dialog = await openDeleteAccountDialog(page);

  for (const name of [/^cancel$/i, /^delete my account$/i]) {
    const button = dialog.getByRole("button", { name });
    await expect(button).toBeVisible();
    const box = await button.boundingBox();
    // WCAG 2.5.5 target size, the same floor the disconnect confirmation is
    // held to in member-google.spec.ts. Moved here with the scan: it is an AA
    // assertion, so a retry masks a real regression exactly as it would a flake.
    expect(box!.height).toBeGreaterThanOrEqual(44);
  }

  // Scoped to the dialog: the rest of /settings is scanned by the owner-session
  // specs in this project, and an open modal makes everything behind it inert
  // anyway. `WCAG_TAGS` rather than a fourth copy of the tag list — this file
  // used to restate it, and a gate whose scope is stated in several places
  // drifts in one of them.
  const results = await new AxeBuilder({ page })
    .include('[role="alertdialog"]')
    .withTags(WCAG_TAGS)
    .analyze();
  expect(results.violations).toEqual([]);

  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
});
