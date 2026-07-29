import { test, expect, type Page, type BrowserContext } from "@playwright/test";
import { signUserSession, OWNER_COOKIE } from "../../src/lib/auth/session";
import {
  BASE_URL,
  MEMBER_HANDLE,
  MEMBER_USER_ID,
  MEMBER_WS_ID,
  OWNER_HANDLE,
  SESSION_SECRET,
} from "../constants";
import {
  DESKTOP,
  MOBILE,
  THEMES,
  expectThemeApplied,
  setTheme,
  waitForShell,
} from "../helpers";

// #100 — "the header gives no indication of who you are signed in as".
//
// This is the spec that runs against a REAL build, and three of its claims can
// only be answered by a browser:
//
//  1. The measured HIT TARGET. `min-h-11 min-w-11` is only a class name in
//     jsdom; a flex parent squeezing the trigger would pass the unit test and
//     fail the user (the #103 lesson).
//  2. The BAR STILL FITS. Naming the account is the third text control the
//     header has held, and the previous arrangement ("Account" + "Sign out")
//     measured wider than a 390px viewport. Only a layout can say so.
//  3. The popover is really REACHABLE — Base UI mounts and positions it against
//     the viewport, which jsdom does not do at all.
//
// It also covers all three identity states end to end, and the member state is
// the one that needs a session: `global-setup.ts` already seeds an ordinary
// member account and its workspace, so this signs the same token shape the OAuth
// callback signs, exactly as global-setup does for the owner. No auth-bypass path
// is added to application code.

const MIN_TARGET = 44;

/** The header's identity trigger, located the way an AT user reaches it. */
const identityTrigger = (page: Page) =>
  page.locator("header").getByRole("button", { name: /^Account: / });

/** Its popover. Base UI renders `Popover.Popup` as a dialog. */
const accountPopup = (page: Page) =>
  page.getByRole("dialog", { name: "Account" });

/** Sign this context in as the seeded MEMBER account (not the owner). */
async function signInAsMember(context: BrowserContext): Promise<void> {
  const token = await signUserSession(
    { kind: "user", userId: MEMBER_USER_ID, wsId: MEMBER_WS_ID },
    SESSION_SECRET,
  );
  const url = new URL(BASE_URL);
  await context.addCookies([
    {
      name: OWNER_COOKIE,
      value: token,
      domain: url.hostname,
      path: "/",
      httpOnly: true,
      secure: url.protocol === "https:",
      sameSite: "Lax",
      expires: Math.floor(Date.now() / 1000) + 3600,
    },
  ]);
}

// ── State 1: the owner (the suite's default forged session) ─────────────────

for (const [label, viewport] of [
  ["phone (390)", MOBILE],
  ["desktop (1280)", DESKTOP],
] as const) {
  test.describe(`#100 header identity — owner, ${label}`, () => {
    test.beforeEach(async ({ page }) => {
      await page.setViewportSize(viewport);
    });

    // Measured on /help rather than the inbox, for #105's reason: the inbox
    // re-renders out of a hydration bailout, and a single boundingBox() read on
    // the old handle comes back null. The header is byte-identical on every
    // route, so nothing is lost.
    test(`names the account, hit-targetable, and the bar still fits (${label})`, async ({
      page,
    }) => {
      await page.goto("/help");
      await waitForShell(page);

      const trigger = identityTrigger(page);
      await expect(trigger).toBeVisible();
      // The owner's literal request: a name in the corner, without a click.
      await expect(trigger).toContainText(OWNER_HANDLE);
      // WCAG 2.5.3 — the visible words are contained in the accessible name.
      await expect(trigger).toHaveAccessibleName(`Account: ${OWNER_HANDLE}`);
      // #74 on hover: the provider, without opening anything.
      await expect(trigger).toHaveAttribute(
        "title",
        `Signed in as ${OWNER_HANDLE} (GitLab)`,
      );

      const box = await trigger.boundingBox();
      expect(box, "the identity trigger has no layout box").not.toBeNull();
      expect(
        Math.round(box!.width),
        "hit target too narrow (WCAG 2.5.5)",
      ).toBeGreaterThanOrEqual(MIN_TARGET);
      expect(
        Math.round(box!.height),
        "hit target too short (WCAG 2.5.5)",
      ).toBeGreaterThanOrEqual(MIN_TARGET);

      // The constraint #100 set: naming the account must not push the bar past
      // the viewport. The arrangement it replaced did exactly that at 390px.
      const scrollWidth = await page.evaluate(
        () => document.documentElement.scrollWidth,
      );
      expect(
        scrollWidth,
        "the header overflows the viewport",
      ).toBeLessThanOrEqual(viewport.width);
      expect(box!.x + box!.width).toBeLessThanOrEqual(viewport.width);
    });

    // #74's obligation, at the width where it matters most: the provider has to
    // be reachable from the page you are actually looking at when the workspace
    // comes up empty — the inbox — not only from Settings.
    test(`the popover names the provider and the role, from the inbox (${label})`, async ({
      page,
    }) => {
      await page.goto("/");
      await waitForShell(page);

      await identityTrigger(page).click();
      const popup = accountPopup(page);
      await expect(popup).toBeVisible();
      await expect(popup).toContainText(OWNER_HANDLE);
      await expect(popup).toContainText("Owner · signed in with GitLab");

      // …and the popup itself is on screen, not clipped past an edge (#92).
      const box = await popup.boundingBox();
      expect(box).not.toBeNull();
      expect(box!.x).toBeGreaterThanOrEqual(0);
      expect(box!.x + box!.width).toBeLessThanOrEqual(viewport.width);
    });
  });
}

test.describe("#100 header identity — owner, behaviour", () => {
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize(DESKTOP);
  });

  test("the popover holds what the header used to: Account settings + Sign out", async ({
    page,
  }) => {
    await page.goto("/help");
    await waitForShell(page);
    await identityTrigger(page).click();

    const popup = accountPopup(page);
    const settings = popup.getByRole("link", { name: "Account settings" });
    await expect(settings).toHaveAttribute("href", "/settings#account");

    // Still a POST form, not a link (#21 P5 batch B) — moving it into a popup
    // must not turn a state change into something a cross-site GET can trigger.
    const signOut = popup.getByRole("button", { name: "Sign out" });
    await expect(signOut).toBeVisible();
    await expect(
      popup.locator('form[method="post"][action="/api/auth/logout"]'),
    ).toHaveCount(1);

    // Both entries clear the 44px minimum in real layout.
    for (const control of [settings, signOut]) {
      const box = await control.boundingBox();
      expect(box).not.toBeNull();
      expect(Math.round(box!.height)).toBeGreaterThanOrEqual(MIN_TARGET);
    }
  });

  test("opens and closes from the keyboard alone", async ({ page }) => {
    await page.goto("/help");
    await waitForShell(page);

    const trigger = identityTrigger(page);
    await trigger.focus();
    await expect(trigger).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(accountPopup(page)).toBeVisible();

    await page.keyboard.press("Escape");
    await expect(accountPopup(page)).toHaveCount(0);
    await expect(trigger).toHaveAttribute("aria-expanded", "false");
  });

  test("signing out from the popover really signs you out", async ({
    page,
  }) => {
    await page.goto("/help");
    await waitForShell(page);
    await identityTrigger(page).click();
    await accountPopup(page).getByRole("button", { name: "Sign out" }).click();

    // Back to the guest header: offered sign-in, and no identity control.
    await waitForShell(page);
    await expect(page.getByRole("link", { name: /^sign in$/i })).toBeVisible();
    await expect(identityTrigger(page)).toHaveCount(0);
  });
});

// ── State 2: an ordinary member ─────────────────────────────────────────────

test.describe("#100 header identity — member", () => {
  // Start with NO session, then mint the member's own.
  test.use({ storageState: { cookies: [], origins: [] } });

  test.beforeEach(async ({ context, page }) => {
    await signInAsMember(context);
    await page.setViewportSize(MOBILE);
  });

  test("a member sees their OWN handle and is named a member, not an owner", async ({
    page,
  }) => {
    await page.goto("/help");
    await waitForShell(page);

    const trigger = identityTrigger(page);
    await expect(trigger).toContainText(MEMBER_HANDLE);
    await expect(trigger).toHaveAccessibleName(`Account: ${MEMBER_HANDLE}`);

    await trigger.click();
    const popup = accountPopup(page);
    await expect(popup).toContainText("Member · signed in with GitLab");
    await expect(popup).not.toContainText("Owner");
  });

  // Requirement: a member must not be able to see another user's details. The
  // header is a new place identity is rendered, so assert the obvious failure
  // mode directly — the owner's handle must appear nowhere on a member's page,
  // header or popover.
  test("a member is shown nothing about the owner's account", async ({
    page,
  }) => {
    await page.goto("/help");
    await waitForShell(page);
    await identityTrigger(page).click();
    await expect(accountPopup(page)).toBeVisible();

    const body = await page.locator("body").innerText();
    expect(body).toContain(MEMBER_HANDLE);
    expect(body).not.toContain(OWNER_HANDLE);
  });

  test("a member still gets no People admin, and no other account's handle", async ({
    page,
  }) => {
    await page.goto("/settings");
    await waitForShell(page);

    // Positive control: the page really rendered (the owner gets nine sections,
    // a member eight — People is owner-only).
    await expect(page.locator("[data-section-toggle]")).toHaveCount(8);
    await expect(page.locator("#settings-people")).toHaveCount(0);
    expect(await page.locator("body").innerText()).not.toContain(OWNER_HANDLE);
  });

  // A member is signed in, so the guest sandbox banner must not appear — the
  // #35 Phase A distinction, re-asserted from the identity side now that the
  // header tells the two apart out loud.
  test("a member is not treated as a guest", async ({ page }) => {
    await page.goto("/");
    await waitForShell(page);
    await expect(page.getByText(/you're in guest mode/i)).toHaveCount(0);
    await expect(page.getByRole("link", { name: /^sign in$/i })).toHaveCount(0);
  });
});

// ── State 3: a guest ────────────────────────────────────────────────────────

test.describe("#100 header identity — guest", () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test("a guest gets no handle and no identity popover", async ({ page }) => {
    await page.setViewportSize(MOBILE);
    await page.goto("/");
    await waitForShell(page);

    // Precondition: really a guest (the middleware mints a guest sandbox).
    await expect(page.getByRole("link", { name: /^sign in$/i })).toBeVisible();

    await expect(identityTrigger(page)).toHaveCount(0);
    await expect(accountPopup(page)).toHaveCount(0);
    const body = await page.locator("body").innerText();
    expect(body).not.toContain(OWNER_HANDLE);
    expect(body).not.toContain(MEMBER_HANDLE);
    expect(body).not.toContain("signed in with");
  });

  test("a guest's header still fits at 390px", async ({ page }) => {
    await page.setViewportSize(MOBILE);
    await page.goto("/help");
    await waitForShell(page);
    const scrollWidth = await page.evaluate(
      () => document.documentElement.scrollWidth,
    );
    expect(scrollWidth).toBeLessThanOrEqual(MOBILE.width);
  });
});

// ── Screenshots ─────────────────────────────────────────────────────────────
//
// The repo's convention (section-nav.spec.ts, settings-disclosure.spec.ts):
// captures live with the feature's own spec and write to test-results/, so the
// frames a reviewer eyeballs are reproducible from a real production build
// rather than pasted in once. All three identity states × both themes × both
// widths — the full matrix, because #73 shipped a 2.44:1 dark-mode banner that
// only a human looking at a dark screenshot caught.

const SHOTS = "test-results/header-identity";

/**
 * The header band plus the space the popover opens into.
 *
 * Clipped from the HEADER's own top edge rather than from y=0: a guest carries
 * the sandbox banner above the bar, which at 390px is tall enough to push the
 * header out of a fixed top-of-page crop entirely (the first pass of these
 * captures produced four guest frames with no header in them).
 */
async function captureHeader(
  page: Page,
  name: string,
  width: number,
): Promise<void> {
  // `.first()` because /help's page heading is a <header> too — the app bar is
  // the first one in the document.
  const box = await page.locator("header").first().boundingBox();
  expect(box, "the header has no layout box to clip to").not.toBeNull();
  await page.screenshot({
    path: `${SHOTS}/${name}.png`,
    clip: {
      x: 0,
      y: Math.max(0, Math.round(box!.y) - 8),
      width,
      height: 260,
    },
  });
}

for (const [size, viewport] of [
  ["desktop", DESKTOP],
  ["mobile", MOBILE],
] as const) {
  for (const theme of THEMES) {
    test.describe(`#100 header identity — screenshots, ${size}/${theme}`, () => {
      test(`owner: bar at rest, and the popover open (${size}/${theme})`, async ({
        page,
      }) => {
        await page.setViewportSize(viewport);
        await setTheme(page, theme);
        await page.goto("/help");
        await waitForShell(page);
        // Guard the precondition: a silently-light "dark" screenshot is worse
        // than no screenshot, because it looks like it was reviewed (#73).
        await expectThemeApplied(page, theme);

        await captureHeader(page, `owner-${size}-${theme}-bar`, viewport.width);
        await identityTrigger(page).click();
        await expect(accountPopup(page)).toBeVisible();
        await captureHeader(
          page,
          `owner-${size}-${theme}-open`,
          viewport.width,
        );
      });

      test(`guest: bar at rest (${size}/${theme})`, async ({ browser }) => {
        // A fresh context with NO storage state IS a first-time visitor — the
        // same opt-out the guest specs above use.
        const context = await browser.newContext({
          storageState: { cookies: [], origins: [] },
          viewport,
        });
        const page = await context.newPage();
        await setTheme(page, theme);
        await page.goto("/help");
        await waitForShell(page);
        await expectThemeApplied(page, theme);
        await expect(
          page.getByRole("link", { name: /^sign in$/i }),
        ).toBeVisible();
        await captureHeader(page, `guest-${size}-${theme}-bar`, viewport.width);
        await context.close();
      });

      test(`member: bar at rest, and the popover open (${size}/${theme})`, async ({
        browser,
      }) => {
        const context = await browser.newContext({
          storageState: { cookies: [], origins: [] },
          viewport,
        });
        await signInAsMember(context);
        const page = await context.newPage();
        await setTheme(page, theme);
        await page.goto("/help");
        await waitForShell(page);
        await expectThemeApplied(page, theme);

        await captureHeader(
          page,
          `member-${size}-${theme}-bar`,
          viewport.width,
        );
        await identityTrigger(page).click();
        await expect(accountPopup(page)).toBeVisible();
        await captureHeader(
          page,
          `member-${size}-${theme}-open`,
          viewport.width,
        );
        await context.close();
      });
    });
  }
}
