import { test, expect } from "@playwright/test";
import { captureItem, needsReviewRow } from "../helpers";

/**
 * The .ics schedule path, end to end in a production build (#104).
 *
 * This is the only scheduling method reachable in e2e: there is no
 * GOOGLE_CLIENT_ID and no GoogleAuth row, so `scheduleState` resolves every
 * Google control to `"connect"` and renders it as a "Connect Google →" link
 * (row-actions.tsx). The suite runs as the OWNER, though, and an owner still
 * LEADS with the Google control (`leadSchedulingMethod`) — so the .ics entry is
 * the one in the row's ▾ "All options" menu (`icsMenu` in inbox-view.tsx), not
 * the end-cluster 📅.
 *
 * It guards the wiring — action → buildTaskIcs → Blob download — and the two
 * properties #104 changed in that file: the focus deep-link travels in
 * DESCRIPTION, and events defend their time.
 */
test("scheduling a to-do downloads an .ics with a focus link and busy time", async ({
  page,
}) => {
  const label = `E2E schedule ${Date.now()}`;
  await page.goto("/");
  await captureItem(page, label);

  // The .ics handler needs a linked Task (`icsProps` bails without one), and a
  // fresh capture has none — "Add to-do" is what creates it.
  const row = needsReviewRow(page, label);
  await expect(row).toBeVisible();
  await row.getByRole("button", { name: "Add to-do" }).click();

  const todoRow = page
    .locator('[data-bucket="singleTask"]')
    .getByRole("listitem")
    .filter({ hasText: label });
  await expect(todoRow).toBeVisible();

  // The ▾ popup is portaled into the row, so this stays row-scoped.
  await todoRow.getByRole("button", { name: "All options" }).click();
  // A to-do created this way has no steps, so the entry expands the duration
  // presets (15/30/60) rather than downloading immediately.
  await todoRow.getByRole("button", { name: "Add to calendar (.ics)" }).click();

  const downloadPromise = page.waitForEvent("download");
  await todoRow.getByRole("button", { name: "30 min" }).click();

  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(/\.ics$/);

  const stream = await download.createReadStream();
  const chunks: Buffer[] = [];
  for await (const c of stream) chunks.push(Buffer.from(c));
  const ics = Buffer.concat(chunks).toString("utf8");

  expect(ics).toContain("BEGIN:VEVENT");
  expect(ics).toContain(label);
  // The per-step deep link (#104): a real absolute URL into /focus.
  expect(ics).toMatch(/DESCRIPTION:.*\/focus/);
  // busy, not free — the one place the intent's `busy` flag is literal.
  expect(ics).toContain("TRANSP:OPAQUE");
});
