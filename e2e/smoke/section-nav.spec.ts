import { test, expect, type Locator, type Page } from "@playwright/test";

// #72 — the collapsible sticky "Jump to…" section nav on the two long pages.
// The things worth an end-to-end test are the ones jsdom cannot see: real
// sticky layout (does the bar cover the heading it just jumped to?), the
// viewport-driven collapse default, and real keyboard focus.

const SETTINGS_NAV = 'nav[aria-label="Settings sections"]';
const HELP_NAV = 'nav[aria-label="Help sections"]';
const SHOTS = "test-results/section-nav";

const MOBILE = { width: 390, height: 844 }; // iPhone 14-ish
const DESKTOP = { width: 1280, height: 900 };

async function waitForShell(page: Page): Promise<void> {
  await expect(page.getByRole("link", { name: "dlectroflow" })).toBeVisible();
}

/**
 * The bar is server-rendered, so it is on screen BEFORE React hydrates — and
 * every client-side behaviour (the smooth-scroll opt-in, the collapse default,
 * aria-current) only exists after. Wait for the opt-in the nav performs on
 * mount, or the geometry assertions below race hydration.
 */
async function waitForNavHydrated(page: Page): Promise<void> {
  await expect
    .poll(() =>
      page.evaluate(() =>
        document.documentElement.classList.contains("scroll-smooth"),
      ),
    )
    .toBe(true);
}

/** Wait for a (possibly smooth-animated) scroll to come to rest. */
async function waitForScrollToSettle(page: Page): Promise<void> {
  await page.waitForFunction(
    () =>
      new Promise<boolean>((resolve) => {
        let last = window.scrollY;
        let stillFor = 0;
        const tick = () => {
          if (window.scrollY === last) {
            if (++stillFor > 3) return resolve(true);
          } else {
            stillFor = 0;
            last = window.scrollY;
          }
          requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      }),
  );
}

/** The heading must sit BELOW the sticky bar, not underneath it. */
async function expectClearOfStickyBar(
  nav: Locator,
  heading: Locator,
): Promise<void> {
  await waitForScrollToSettle(heading.page());
  const navBox = await nav.boundingBox();
  const headingBox = await heading.boundingBox();
  expect(navBox, "nav has no box").not.toBeNull();
  expect(headingBox, "heading has no box").not.toBeNull();
  // 1px of slack for sub-pixel rounding.
  expect(headingBox!.y).toBeGreaterThanOrEqual(navBox!.y + navBox!.height - 1);
}

test.describe("section nav — desktop", () => {
  test.use({ viewport: DESKTOP });

  test("expanded by default, and a jump lands the heading clear of the sticky bar", async ({
    page,
  }) => {
    await page.goto("/settings");
    await waitForShell(page);

    await waitForNavHydrated(page);

    const nav = page.locator(SETTINGS_NAV);
    const toggle = nav.getByRole("button", { name: /jump to/i });
    await expect(toggle).toHaveAttribute("aria-expanded", "true");

    // One entry per section that is actually on the page.
    const links = nav.getByRole("link");
    await expect(links).toHaveCount(
      await page.locator("h2[data-section-target]").count(),
    );

    // Jump to the LAST section — the one that needs the most scrolling, and the
    // one where a wrong scroll-margin is most obvious.
    await nav.getByRole("link", { name: "Integrations" }).click();
    const heading = page.locator("#settings-integrations");
    await expect(heading).toBeFocused();
    // Actually ON SCREEN — toBeVisible() alone passes on an unscrolled page.
    await expect(heading).toBeInViewport();
    await expectClearOfStickyBar(nav, heading);

    // …and the bar is still stuck to the top of the viewport after the scroll.
    expect((await nav.boundingBox())!.y).toBeLessThan(4);
    // The last entry lights up at the end of the page (it can never reach the
    // top of the viewport, so plain "topmost wins" would strand it).
    await expect(nav.locator("a[aria-current]")).toHaveText(/Integrations/);
  });

  test("aria-current follows the section you scrolled to", async ({ page }) => {
    await page.goto("/settings");
    await waitForShell(page);
    await waitForNavHydrated(page);
    const nav = page.locator(SETTINGS_NAV);

    // At the top of the page the first section is current.
    await expect(nav.locator("a[aria-current]")).toHaveText(/Aging & reminder/);

    await nav.getByRole("link", { name: "Focus timer" }).click();
    await expect(nav.locator("a[aria-current]")).toHaveText(/Focus timer/);
    // Exactly one, always.
    await expect(nav.locator("a[aria-current]")).toHaveCount(1);
    // The cue is not colour alone.
    await expect(
      nav.locator("a[aria-current] [data-current-marker]"),
    ).toBeVisible();
  });

  test("keyboard only: tab into the nav, Enter jumps, focus lands on the heading", async ({
    page,
  }) => {
    await page.goto("/help");
    await waitForShell(page);
    await waitForNavHydrated(page);
    const nav = page.locator(HELP_NAV);
    const toggle = nav.getByRole("button", { name: /jump to/i });

    // The toggle is operable from the keyboard and reports its state.
    await toggle.focus();
    await page.keyboard.press("Enter");
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await page.keyboard.press(" ");
    await expect(toggle).toHaveAttribute("aria-expanded", "true");

    // Tab moves into the link list…
    await page.keyboard.press("Tab");
    const first = nav.getByRole("link").first();
    await expect(first).toBeFocused();
    // …with a VISIBLE focus indicator (the shared focus-visible ring).
    const ring = await first.evaluate(
      (el) => getComputedStyle(el).boxShadow ?? "none",
    );
    expect(ring).not.toBe("none");

    // Walk to a later entry and activate it with the keyboard.
    await page.keyboard.press("Tab");
    await page.keyboard.press("Tab");
    const third = nav.getByRole("link").nth(2);
    await expect(third).toBeFocused();
    await page.keyboard.press("Enter");

    const heading = page.locator("#help-task-breakdown");
    await expect(heading).toBeFocused();
    await expectClearOfStickyBar(nav, heading);
  });

  test("the sticky bar never traps focus — tabbing continues into the page", async ({
    page,
  }) => {
    await page.goto("/help");
    await waitForShell(page);
    await waitForNavHydrated(page);
    const nav = page.locator(HELP_NAV);
    const links = await nav.getByRole("link").count();

    await nav.getByRole("button", { name: /jump to/i }).focus();
    for (let i = 0; i < links + 1; i++) await page.keyboard.press("Tab");

    // One Tab past the last nav link, focus has left the nav entirely.
    const insideNav = await page.evaluate(
      (selector) =>
        document.querySelector(selector)?.contains(document.activeElement) ??
        false,
      HELP_NAV,
    );
    expect(insideNav).toBe(false);
  });

  test("the stuck bar stays opaque — page content never paints over it", async ({
    page,
  }) => {
    await page.goto("/settings");
    await waitForShell(page);
    await waitForNavHydrated(page);
    const nav = page.locator(SETTINGS_NAV);
    await nav.getByRole("link", { name: "Appearance" }).click();
    await waitForScrollToSettle(page);

    // Regression: `position: sticky` alone does not win the paint order.
    // Anything later in the page with opacity < 1 (the disabled model radios)
    // forms its own stacking context and used to render straight THROUGH the
    // stuck bar. Hit-test the bar's own top edge.
    const onTop = await page.evaluate((selector) => {
      const el = document.elementFromPoint(window.innerWidth / 2, 3);
      return Boolean(el?.closest(selector));
    }, SETTINGS_NAV);
    expect(onTop).toBe(true);
  });

  test("the header's app menu still opens OVER the bar", async ({ page }) => {
    // The flip side of the z-index above: the bar must not bury the global
    // menu, which drops down from the header right on top of it.
    await page.goto("/settings");
    await waitForShell(page);
    await waitForNavHydrated(page);
    await page.getByRole("button", { name: "Menu" }).click();

    const menu = page.locator('nav[aria-label="Main"]');
    await expect(menu).toBeVisible();
    const box = (await menu.boundingBox())!;
    const onTop = await page.evaluate(
      ({ x, y, width, height }) => {
        const el = document.elementFromPoint(x + width / 2, y + height - 10);
        return Boolean(el?.closest('nav[aria-label="Main"]'));
      },
      { x: box.x, y: box.y, width: box.width, height: box.height },
    );
    expect(onTop).toBe(true);
  });

  test("opts into smooth scrolling (reduced motion is handled separately)", async ({
    page,
  }) => {
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await page.goto("/settings");
    await waitForShell(page);
    await waitForNavHydrated(page);
    const behavior = await page.evaluate(
      () => getComputedStyle(document.documentElement).scrollBehavior,
    );
    expect(behavior).toBe("smooth");
  });
});

test.describe("section nav — prefers-reduced-motion", () => {
  test.use({ viewport: DESKTOP });

  test("does not smooth-scroll when the user asked for less motion", async ({
    page,
  }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto("/settings");
    await waitForShell(page);
    // Wait for the nav to ASK for smooth scrolling before asserting it did not
    // get it — otherwise this passes trivially on an un-hydrated page.
    await waitForNavHydrated(page);
    // globals.css forces scroll-behavior:auto under the reduce query, which
    // beats the nav's opt-in `scroll-smooth` class.
    const behavior = await page.evaluate(
      () => getComputedStyle(document.documentElement).scrollBehavior,
    );
    expect(behavior).toBe("auto");
  });
});

test.describe("section nav — mobile", () => {
  test.use({ viewport: MOBILE });

  test("collapsed by default, expands on tap, and steps aside once you pick", async ({
    page,
  }) => {
    await page.goto("/settings");
    await waitForShell(page);

    await waitForNavHydrated(page);

    const nav = page.locator(SETTINGS_NAV);
    const toggle = nav.getByRole("button", { name: /jump to/i });
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await expect(nav.getByRole("link").first()).toBeHidden();

    // Collapsed, the bar is one compact row that costs almost no height.
    const collapsed = (await nav.boundingBox())!.height;
    expect(collapsed).toBeLessThan(80);

    // Every control clears the 44px touch-target minimum.
    expect((await toggle.boundingBox())!.height).toBeGreaterThanOrEqual(44);

    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    const firstLink = nav.getByRole("link").first();
    await expect(firstLink).toBeVisible();
    expect((await firstLink.boundingBox())!.height).toBeGreaterThanOrEqual(44);

    // Picking a section collapses the bar again — an expanded map would eat a
    // third of a phone screen while you read the section you just jumped to.
    await nav.getByRole("link", { name: "Notifications" }).click();
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    const heading = page.locator("#settings-notifications");
    await expect(heading).toBeFocused();
    await expect(heading).toBeInViewport();
    await expectClearOfStickyBar(nav, heading);
    expect((await nav.boundingBox())!.height).toBeLessThan(80);
  });
});

// Screenshots for review. Not assertions — the owner wants to eyeball this one.
test.describe("section nav — screenshots", () => {
  for (const [name, viewport] of [
    ["desktop", DESKTOP],
    ["mobile", MOBILE],
  ] as const) {
    test(`captures /settings and /help (${name})`, async ({ page }) => {
      await page.setViewportSize(viewport);
      for (const route of ["settings", "help"]) {
        await page.goto(`/${route}`);
        await waitForShell(page);
        await expect(page.locator(`nav[aria-label$="sections"]`)).toBeVisible();
        await waitForNavHydrated(page);
        await page.screenshot({ path: `${SHOTS}/${route}-${name}.png` });
      }
      // The bar stuck to the top mid-page — the state a reviewer wants to see.
      await page.goto("/settings");
      await waitForShell(page);
      await waitForNavHydrated(page);
      const bar = page.locator(SETTINGS_NAV);
      const barToggle = bar.getByRole("button", { name: /jump to/i });
      // Narrow viewports start collapsed — open the map before picking from it.
      if ((await barToggle.getAttribute("aria-expanded")) === "false") {
        await barToggle.click();
      }
      await bar.getByRole("link", { name: "Appearance" }).click();
      await waitForScrollToSettle(page);
      await page.screenshot({ path: `${SHOTS}/settings-stuck-${name}.png` });

      // …and the mobile bar in its expanded state, which is the one that needed
      // a deliberate decision.
      if (name === "mobile") {
        await page.goto("/settings");
        await waitForShell(page);
        await waitForNavHydrated(page);
        await page.locator(SETTINGS_NAV).getByRole("button").click();
        await page.screenshot({
          path: `${SHOTS}/settings-mobile-expanded.png`,
        });
      }
    });
  }
});
