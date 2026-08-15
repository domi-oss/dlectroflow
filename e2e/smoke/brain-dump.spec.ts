import { test, expect } from "@playwright/test";
import { captureItem, needsReviewRow, ROW_MENU_ADD_TODO } from "../helpers";

// Flow 2: brain-dump capture (Enter to submit) then triage into a to-do.
// The capture bar has no submit button. New items land in "Needs review";
// `ROW_MENU_ADD_TODO` (a ▾-list entry since #253) moves the item into the
// single-task bucket.
test("brain-dump item triages into a single-task to-do", async ({ page }) => {
  const label = `E2E buy milk ${Date.now()}`;
  await page.goto("/");

  await captureItem(page, label);

  // Item appears in the Needs review bucket; triage it.
  const row = needsReviewRow(page, label);
  await expect(row).toBeVisible();
  // #253 — Add to-do moved off the row into its ▾ list, under the full label.
  await row.getByRole("button", { name: "All options" }).click();
  await row.getByRole("button", { name: ROW_MENU_ADD_TODO }).click();

  // It now lives in the single-task bucket with a Start Focus affordance.
  const singleTask = page.locator('[data-bucket="singleTask"]');
  await expect(singleTask).toContainText(label);
  await expect(
    singleTask
      .getByRole("listitem")
      .filter({ hasText: label })
      .getByRole("button", { name: /Start Focus/ }),
  ).toBeVisible();
});

/**
 * #175 — the offline capture queue, end to end.
 *
 * ⚠️ **The one thing no unit test in this repo can show.** Every spec around the
 * queue drives a `fetch` double; this drives the real browser's real network
 * stack through `context.setOffline(true)`, which is the condition the feature
 * exists for and the only way to know that `POST /api/braindump` genuinely fails
 * the way the queue assumes rather than in some way it mishandles.
 *
 * Offline is set on the CONTEXT rather than the page, and after the first load:
 * the app is a server-rendered Next route, so going offline before `goto` would
 * fail the navigation instead of the capture, and the spec would pass for the
 * wrong reason.
 *
 * The strip never says "offline" — `navigator.onLine` reads true on a captive
 * portal, in a lift and at the edge of coverage, so the app is not entitled to
 * assert it. The assertion is on what is true: N waiting to save.
 */
test("a capture made offline is held, then saves itself on reconnect", async ({
  page,
  context,
}) => {
  const label = `E2E offline ${Date.now()}`;
  await page.goto("/");
  // The capture bar is present and the page is warm before the network goes.
  await expect(page.getByPlaceholder(/Brain dump/i)).toBeVisible();

  await context.setOffline(true);
  await captureItem(page, label);

  // Held, named as waiting, and readable: the words are recoverable by eye even
  // while nothing can reach the server.
  const strip = page.getByTestId("capture-queue-strip");
  await expect(strip).toBeVisible();
  await expect(
    strip.getByRole("button", { name: /1 waiting to save/ }),
  ).toBeVisible();
  await expect(page.getByText("captured ✓")).toHaveCount(0);
  await strip.getByRole("button", { name: /waiting to save/ }).click();
  await expect(strip).toContainText(label);

  // Durable, which is the promise and the reason the design is not an in-memory
  // guard: Chrome discards background tabs under memory pressure and a discarded
  // tab fires no unload event, so there is no later moment to write. Asserted by
  // reading the store, because that is the property — the words are on disk, not
  // in a component's state.
  //
  // ⚠️ **Deliberately NOT `page.reload()` here.** An earlier version of this spec
  // reloaded while offline to show the words surviving the tab, and it failed with
  // `net::ERR_INTERNET_DISCONNECTED` — correctly. This is a server-rendered Next
  // route and #175 puts an offline *reload* explicitly out of scope: "Only capture
  // is insured." So that assertion was asserting a feature the design does not
  // claim, and passing it would have needed route caching nobody has built. The
  // reload below happens once the connection is back, where it tests something
  // real: that the capture ended up on the server rather than merely leaving the
  // strip.
  const stored = await page.evaluate(() =>
    JSON.parse(window.localStorage.getItem("df-capture-queue") ?? "[]"),
  );
  expect(stored.map((c: { text: string }) => c.text)).toEqual([label]);

  // `online` is an opportunistic hint, so coming back is enough — no press.
  await context.setOffline(false);

  // The strip empties because the capture reached the server, and the row appears
  // in the inbox: the list is refreshed rather than left claiming nothing
  // happened, which would read as the words having been destroyed.
  await expect(page.getByTestId("capture-queue-strip")).toHaveCount(0);
  await expect(needsReviewRow(page, label)).toBeVisible();

  // And it is genuinely on the server, not just gone from the strip — the one
  // thing a client-side assertion cannot distinguish.
  await page.reload();
  await expect(needsReviewRow(page, label)).toBeVisible();
  await expect(page.getByTestId("capture-queue-strip")).toHaveCount(0);
});

/**
 * The other half of the same promise: a Discard is final, and it does NOT reach
 * the server. A capture that was never saved cannot be "deleted" — the copy says
 * so, and this asserts the behaviour behind it.
 */
test("a discarded offline capture is gone from the browser and never saved", async ({
  page,
  context,
}) => {
  const label = `E2E discard ${Date.now()}`;
  await page.goto("/");
  await expect(page.getByPlaceholder(/Brain dump/i)).toBeVisible();

  await context.setOffline(true);
  await captureItem(page, label);
  const strip = page.getByTestId("capture-queue-strip");
  await strip.getByRole("button", { name: /waiting to save/ }).click();

  // Two-step, so the confirm is made against words the user can read.
  //
  // Exact-string names, deliberately NOT `new RegExp(...)`: the label carries a
  // timestamp, so interpolating it into a pattern is the unescaped-input shape
  // `regexp-source-hygiene` stands in for (#234, CWE-185). The accessible names
  // are exactly these, because the strip builds them as "<action>: <text>".
  await strip.getByRole("button", { name: `Discard: ${label}` }).click();
  await strip
    .getByRole("button", { name: `Discard for good: ${label}` })
    .click();

  await expect(page.getByTestId("capture-queue-strip")).toHaveCount(0);

  // Back online, and nothing sends it: an explicit refusal is not a deferral.
  await context.setOffline(false);
  await page.reload();
  await expect(page.getByTestId("capture-queue-strip")).toHaveCount(0);
  await expect(page.locator("body")).not.toContainText(label);
});
