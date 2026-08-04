import { test, expect } from "@playwright/test";
import { GUEST_COOKIE } from "../../src/lib/auth/session";
import { MEMBER_BASE_URL } from "../constants";
import { expandSection, waitForShell } from "../helpers";

/**
 * #154 — the calendar subscription feed, in a production build, all the way to a
 * fetch that carries no cookies.
 *
 * Runs in the `member` Playwright project (`MEMBER_SPECS` in
 * `playwright.config.ts`): the feed belongs to a signed-in account, and guests
 * deliberately cannot have one.
 *
 * ── What only this spec can prove ────────────────────────────────────────────
 *
 * Every layer below has its own tests — the token and its shape check as unit
 * tests, the whole lifecycle against real Postgres in
 * `calendar-feed.integration.test.ts`, the route's headers with a real
 * `Response`, the middleware's classification in `proxy.test.ts`, the card's
 * states in jsdom. What none of them touch is the property the whole feature
 * rests on: **that a request with no cookie at all, through the real middleware,
 * in a real production build, is served a calendar** — and that the same URL
 * stops working the moment it is regenerated.
 *
 * The requests are made from a `request` context that is NOT the signed-in
 * page's, so no session travels with them. If any of this passed because the
 * browser sent a cookie, it would be proving the opposite of the claim, which is
 * why the context's own cookie jar is asserted to be empty afterwards.
 */

const INTEGRATIONS = "settings-integrations";

test("a member's calendar feed serves an ICS to a caller with no session", async ({
  page,
  playwright,
}) => {
  await page.goto("/settings");
  await waitForShell(page);
  await expandSection(page, INTEGRATIONS);

  const card = page.getByTestId("calendar-feed-card");
  await expect(card).toBeVisible();

  // Create it if this run is the first. The suite shares one member account, so
  // a retry — or a future spec — may find one already there, and `create` is
  // idempotent by design anyway.
  const create = card.getByRole("button", { name: /create a calendar feed/i });
  if (await create.isVisible()) {
    await create.click();
  }

  const field = card.getByLabel(/calendar feed url/i);
  await expect(field).toBeVisible();
  const url = await field.inputValue();
  expect(url).toMatch(/\/api\/ics\/feed\/[A-Za-z0-9_-]{43}$/);

  // The caveat is on screen at the point of copying, not merely in the source.
  const warningId = await field.getAttribute("aria-describedby");
  expect(warningId, "the field must describe its warning").toBeTruthy();
  await expect(page.locator(`#${warningId!.split(" ")[0]}`)).toContainText(
    /anyone who has it/i,
  );

  // A brand-new context: no cookies, no storage, nothing this session has.
  const anonymous = await playwright.request.newContext();
  try {
    const res = await anonymous.get(url);
    expect(res.status()).toBe(200);
    expect(res.headers()["content-type"]).toContain("text/calendar");
    // No shared cache may hold one person's schedule served without a cookie.
    expect(res.headers()["cache-control"]).toContain("no-store");
    expect(await res.text()).toContain("BEGIN:VCALENDAR");

    // The feed is a PUBLIC path, so the middleware returns before minting a
    // guest sandbox. A calendar client polls forever; creating a workspace on
    // every poll for somebody who is not using the app would be a slow leak.
    const jar = (await anonymous.storageState()).cookies;
    expect(jar, "a feed poll must set no cookie at all").toEqual([]);

    // Regenerating invalidates the old URL immediately — not on a schedule, and
    // not once something expires.
    await card.getByRole("button", { name: /regenerate url/i }).click();
    await card.getByRole("button", { name: /yes, regenerate/i }).click();
    await expect(field).not.toHaveValue(url);

    const stale = await anonymous.get(url);
    expect(stale.status()).toBe(404);

    // The control: the NEW URL works, so the 404 above is a revocation rather
    // than the endpoint having broken.
    const fresh = await anonymous.get(await field.inputValue());
    expect(fresh.status()).toBe(200);
  } finally {
    await anonymous.dispose();
  }
});

test("the per-task ICS download is still session-scoped", async ({
  playwright,
}) => {
  // `/api/ics/feed` is public; `/api/ics` is not. A task id is guessable in a
  // way a 256-bit token is not, so opening the whole prefix would have been the
  // quiet mistake this feature could most easily have made.
  //
  // Asserted on the COOKIE rather than the status code: an unknown task id is a
  // 404 either way, so the status proves nothing about the gate. A minted guest
  // sandbox is what "the middleware treated this as private" actually looks like.
  const anonymous = await playwright.request.newContext({
    baseURL: MEMBER_BASE_URL,
  });
  try {
    await anonymous.get("/api/ics/some-task-id");
    const jar = (await anonymous.storageState()).cookies;
    expect(jar.map((c) => c.name)).toContain(GUEST_COOKIE);
  } finally {
    await anonymous.dispose();
  }
});
