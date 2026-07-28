import { test, expect } from "@playwright/test";
import { CAPTURE_PLACEHOLDER, captureItem, needsReviewRow } from "../helpers";

// #35 Phase A — guests must be completely unaffected by the accounts change.
//
// Every other spec in this suite runs with the forged signed-in storageState,
// so nothing else would notice if the guest path regressed. These run with NO
// cookies at all: the middleware mints a fresh guest sandbox exactly as it does
// for a first-time visitor in production.
//
// This matters because Phase A touched every seam a guest passes through — the
// session payload, guest minting in the middleware, the workspace resolver, the
// guest/AI banner gate in the layout, and the "is this a guest?" predicate that
// used to be a string comparison against a magic workspace id.
test.use({ storageState: { cookies: [], origins: [] } });

test("a guest still gets a sandbox and can capture into it", async ({
  page,
}) => {
  await page.goto("/");

  // The app shell renders for an anonymous visitor — no redirect to /login.
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByRole("link", { name: "dlectroflow" })).toBeVisible();

  // And the sandbox is writable: this is a real workspace, lazily created.
  await captureItem(page, "guest sandbox still works");
  await expect(needsReviewRow(page, "guest sandbox still works")).toBeVisible();
});

test("a guest still sees the sandbox banner with its AI allowance", async ({
  page,
}) => {
  await page.goto("/");

  const banner = page.getByText(/you're in guest mode/i);
  await expect(banner).toBeVisible();
  // The allowance is interpolated from the enforced quota, so its presence is
  // what proves the guest AI cap is still wired up for guests.
  await expect(banner).toContainText(/AI assisted task breakdowns/i);
});

test("a guest is offered sign-in, never Account or Sign out", async ({
  page,
}) => {
  await page.goto("/");

  await expect(page.getByRole("link", { name: /^sign in$/i })).toBeVisible();
  await expect(page.getByRole("link", { name: /^account$/i })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /sign out/i })).toHaveCount(0);
});

test("a guest is refused an authenticated-only path", async ({ page }) => {
  // AUTHENTICATED_PREFIXES is new in Phase A: a valid GUEST session must not be
  // enough. The route itself does not exist yet (Phase C/D add /api/account/*),
  // so what is asserted is the middleware decision — redirected to /login,
  // never a 404 from the route layer, which would mean the gate did not run.
  const res = await page.goto("/api/account/export");
  expect(res?.status()).toBe(200); // followed the redirect
  await expect(page).toHaveURL(/\/login/);
});

test("a guest sees NOTHING of the People admin — no card, no heading, no empty section", async ({
  page,
}) => {
  // #35 Phase B — the People panel is owner-only administration UI, and this is
  // the design's "usage numbers only, never content" guarantee from the other
  // direction: a guest glimpsing account handles would be a leak of a different
  // kind. Three independent gates: the page renders nothing, the section nav
  // lists nothing, and loadPeopleAdmin returns null for a non-owner whatever the
  // caller does.
  //
  // Asserted EXPLICITLY rather than left to #90's guest contrast gate to notice.
  // That gate now scans guest /settings, so if a guest could see this panel the
  // gate would be quietly scanning owner administration UI and passing.
  await page.goto("/settings");

  // POSITIVE CONTROL first. Every assertion below is an absence, and #101 gave
  // absences a second way to be vacuous: "not visible" is also what a COLLAPSED
  // section looks like, and a page that failed to render at all would pass every
  // one of them. So prove the settings page really is here, with its other eight
  // sections, before proving this one is not.
  await expect(page.locator("[data-section-toggle]")).toHaveCount(8);
  await expect(
    page.locator('[data-section-toggle="settings-appearance"]'),
  ).toBeVisible();

  // Not the section, not the heading, and not a collapsed shell of either.
  await expect(page.locator("#settings-people")).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "People" })).toHaveCount(0);
  await expect(
    page.locator('[data-section-toggle="settings-people"]'),
  ).toHaveCount(0);
  // No summary line either — "N accounts" is itself information about the
  // instance that a guest has no business reading.
  await expect(page.getByText(/\d+ account/)).toHaveCount(0);
  await expect(page.getByText(/invitations? pending/i)).toHaveCount(0);

  // None of the controls, whether or not a disclosure is hiding them.
  await expect(page.getByLabel(/invite a username or email/i)).toHaveCount(0);
  await expect(page.getByRole("list", { name: /accounts/i })).toHaveCount(0);
  await expect(page.getByRole("list", { name: /invitations/i })).toHaveCount(0);
  await expect(page.locator("[data-person-label]")).toHaveCount(0);

  // And nothing about the accounts that DO exist: both handles are seeded by
  // global-setup, so this would catch a leak of real identity data.
  await expect(page.getByText("e2e-owner")).toHaveCount(0);
  await expect(page.getByText("e2e-member")).toHaveCount(0);

  const nav = page.locator('nav[aria-label="Settings sections"]');
  await nav.getByRole("button", { name: /jump to/i }).click();
  await expect(nav.getByRole("link", { name: "People" })).toHaveCount(0);
});

test("a guest's /settings HTML never carries the People panel at all", async ({
  page,
}) => {
  // The stronger version of the assertion above. `hidden` markup is still IN the
  // document, so "not visible" would not prove the panel was never SENT — and
  // since the panel became a collapsed disclosure, "not visible" is exactly what
  // an owner's own page looks like too. For a guest it must not be in the
  // response at all: loadPeopleAdmin returns null before it queries anything, so
  // the component is never rendered.
  const res = await page.request.get("/settings");
  const html = await res.text();

  // Positive control: the response really is the settings page (#101 — otherwise
  // every `not.toContain` below passes on an error page just as happily).
  expect(html).toContain('data-section-toggle="settings-appearance"');

  expect(html).not.toContain("settings-people");
  expect(html).not.toContain("data-person-label");
  // The panel's own copy, which exists nowhere else in the app — the check that
  // survives any future rename of the id or the section hook.
  expect(html).not.toMatch(/never anyone.s tasks, notes or other content/i);
  expect(html).not.toMatch(/send invitation/i);
  // The seeded handles, straight out of the database.
  expect(html).not.toContain("e2e-owner");
  expect(html).not.toContain("e2e-member");
});

test("a guest's sandbox is separate from the signed-in account's workspace", async ({
  page,
}) => {
  // The signed-in specs seed content into the e2e account's workspace. A guest
  // must see none of it — the capture bar is present and the board is theirs.
  await page.goto("/");
  await expect(page.getByPlaceholder(CAPTURE_PLACEHOLDER)).toBeVisible();
  await expect(page.getByText("a11y-lib-pill 0")).toHaveCount(0);
});
