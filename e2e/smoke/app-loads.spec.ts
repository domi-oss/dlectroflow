import { test, expect } from "@playwright/test";
import { CAPTURE_PLACEHOLDER } from "../helpers";
import { OWNER_HANDLE } from "../constants";

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

// #35 Phase A — the trap guard.
//
// The forged session in e2e/global-setup.ts now names a real account, and the
// app resolves that id against the database. If it ever stops matching a real
// User row, the cookie still verifies, currentUser() returns null, and the WHOLE
// suite silently runs as an anonymous visitor — every other spec above keeps
// passing, because guests can capture and browse too. So assert the signed-in
// state explicitly, from the outside, on something only a signed-in account
// sees, and on the ABSENCE of the guest sandbox banner.
//
// #100 made that guard STRICTER rather than replacing it. It used to look for the
// anonymous word "Account"; the header now names the account, so the guard can
// assert the suite is signed in as the RIGHT one — a token resolving to some
// other row would show a different handle and fail here instead of quietly
// running against another workspace's data.
test("the suite really is signed in, as the forged owner (guards against a silently anonymous run)", async ({
  page,
}) => {
  await page.goto("/");

  const identity = page
    .locator("header")
    .getByRole("button", { name: `Account: ${OWNER_HANDLE}` });
  await expect(identity).toBeVisible();

  // Sign out moved into the identity popover (#100) — still reachable, still a
  // POST form, and still something no guest is offered.
  await identity.click();
  await expect(
    page.getByRole("dialog", { name: "Account" }).getByRole("button", {
      name: "Sign out",
    }),
  ).toBeVisible();

  // A guest would be offered sign-in and shown the sandbox banner instead.
  await expect(page.getByRole("link", { name: /^sign in$/i })).toHaveCount(0);
  await expect(page.getByText(/sandbox/i)).toHaveCount(0);
});
