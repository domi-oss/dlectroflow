import { test, expect, type Page } from "@playwright/test";
import { waitForShell } from "../helpers";

/**
 * #129 — the member's own "Download my data (.zip)" control, in a production
 * build, all the way to the bytes.
 *
 * Runs in the `member` Playwright project (see `MEMBER_SPECS` in
 * `playwright.config.ts`): this is the account's own settings page, and the
 * archive is named after the signed-in handle.
 *
 * ── What only this spec can prove ────────────────────────────────────────────
 *
 * Every layer below has its own tests — the serialisers on a fixture snapshot,
 * the whole archive against a real Postgres in
 * `src/lib/export/collect.integration.test.ts`, the route's headers with a real
 * `Response`, the control's states in jsdom. What none of them touch is the last
 * mile: a real click, in a real browser, against a real session, producing a real
 * file with the name the server chose. That is what this is for.
 *
 * ── Read this before debugging a RETRY failure ───────────────────────────────
 *
 * `/api/export` is metered at one export per workspace per minute
 * (`src/lib/export/cooldown.ts`), and the counter lives in the server process, so
 * it survives between specs. A first attempt therefore passes cleanly, but if
 * this test ever fails and Playwright RETRIES it, the retry lands inside the
 * cooldown window and fails with the "try again in N seconds" message instead of
 * the original cause. The retry's failure is a symptom; read the first attempt's.
 */

const ACCOUNT = "#settings-account";

/** Every /settings section is a disclosure (#101) and they all rest closed. */
async function openAccountSection(page: Page): Promise<void> {
  await page.goto("/settings");
  await waitForShell(page);
  const toggle = page.locator(`[data-section-toggle="${ACCOUNT.slice(1)}"]`);
  await expect(toggle).toBeVisible();
  if ((await toggle.getAttribute("aria-expanded")) !== "true") {
    await toggle.click();
  }
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
}

function control(page: Page) {
  return page
    .locator(ACCOUNT)
    .locator("xpath=ancestor::section")
    .getByRole("link", { name: /download my data/i });
}

test("a member can download their own data as a zip", async ({ page }) => {
  await openAccountSection(page);

  const link = control(page);
  // An anchor with a real href, so the feature does not depend on a bundle
  // loading — the click handler only exists to turn a 429 or a 401 into a
  // sentence. Asserted here because it is the property that cannot be seen from a
  // unit test of the component in isolation.
  await expect(link).toHaveAttribute("href", "/api/export");

  const downloadPromise = page.waitForEvent("download");
  await link.click();
  const download = await downloadPromise;

  // The agreed filename: dlectroflow-export-<user>-<YYYY-MM-DD>.zip, with the
  // user part slugified to characters that are safe in a Content-Disposition
  // header and on a filesystem.
  expect(download.suggestedFilename()).toMatch(
    /^dlectroflow-export-[a-z0-9-]+-\d{4}-\d{2}-\d{2}\.zip$/,
  );

  const stream = await download.createReadStream();
  const chunks: Buffer[] = [];
  for await (const c of stream) chunks.push(Buffer.from(c));
  const zip = Buffer.concat(chunks);

  // A real archive: the local file header signature is what `file(1)` and every
  // extractor look for first.
  expect(zip.subarray(0, 4)).toEqual(Buffer.from([0x50, 0x4b, 0x03, 0x04]));

  // Entry names are stored verbatim in the headers, so a plain byte search is
  // enough to prove all seven files are in there without parsing the format
  // twice (src/lib/zip.test.ts already does that against the specification).
  for (const name of [
    "README.md",
    "tasks.md",
    "tasks.csv",
    "steps.csv",
    "inbox.csv",
    "scheduled.ics",
    "export.json",
  ]) {
    expect(
      zip.includes(Buffer.from(name)),
      `${name} is not in the archive`,
    ).toBe(true);
  }

  // And the reader is told it worked, politely, in the region the control points
  // at — not left guessing whether anything happened.
  const statusId = await link.getAttribute("aria-describedby");
  expect(statusId, "the control must describe its live region").toBeTruthy();
  await expect(page.locator(`#${statusId}`)).toContainText(/downloaded/i);
});
