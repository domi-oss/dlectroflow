import { test, expect, type Locator, type Page } from "@playwright/test";
import {
  DESKTOP,
  MOBILE,
  THEMES,
  setTheme,
  expectThemeApplied,
  waitForShell,
  expandSection,
  expandAllSections,
} from "../helpers";

// #72 — the collapsible sticky "Jump to…" section nav on the two long pages.
// The things worth an end-to-end test are the ones jsdom cannot see: real
// sticky layout (does the bar cover the heading it just jumped to?), the
// viewport-driven collapse default, and real keyboard focus.

const SETTINGS_NAV = 'nav[aria-label="Settings sections"]';
const HELP_NAV = 'nav[aria-label="Help sections"]';
const SHOTS = "test-results/section-nav";

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

/** Open the "Jump to…" panel — collapsed is the resting state at every width. */
async function openPanel(nav: Locator): Promise<void> {
  const toggle = nav.getByRole("button", { name: /jump to/i });
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
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

/**
 * Scroll well INTO a named section, without touching the nav (the tests below
 * are the SCROLL cases, not the jump cases).
 *
 * Derived from the DOM rather than a magic pixel offset. A fixed offset silently
 * stops meaning "inside a section" the moment the page gains one above it —
 * which is exactly what happened when #35 Phase B added the owner-only People
 * section at the top and pushed everything down.
 */
async function scrollIntoSection(page: Page, id: string): Promise<void> {
  await page.evaluate((sectionId) => {
    const heading = document.getElementById(sectionId)!;
    const section = heading.closest("section") ?? heading.parentElement!;
    const rect = section.getBoundingClientRect();
    // A third of the way in: past the heading (so its band is stuck), and
    // comfortably short of the next section's start.
    window.scrollTo(0, window.scrollY + rect.top + rect.height / 3);
  }, id);
  await waitForScrollToSettle(page);
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

// #101 made every /settings section collapsible, which changes section HEIGHTS
// constantly — and heights are what the nav derives `scroll-margin-top` and its
// scroll-spy band from. This is the class of bug #72 already had to fix twice, so
// the four interaction checks that depend on geometry run in BOTH states: the
// page as it lands (one section open, eight closed, so several sections are ~56px
// bands) and with everything open (the pre-#101 page, thousands of pixels tall).
for (const state of ["as it lands", "all expanded"] as const) {
  test.describe(`section nav — desktop (${state})`, () => {
    test.use({ viewport: DESKTOP });

    test.beforeEach(async ({ page }) => {
      await page.goto("/settings");
      await waitForShell(page);
      await waitForNavHydrated(page);
      if (state === "all expanded") await expandAllSections(page);
    });

    test("collapsed by default, and a jump lands the heading clear of the sticky bar", async ({
      page,
    }) => {
      const nav = page.locator(SETTINGS_NAV);
      await openPanel(nav);

      // One entry per section that is actually on the page.
      const links = nav.getByRole("link");
      await expect(links).toHaveCount(
        await page.locator("h2[data-section-target]").count(),
      );

      // Jump to the LAST section — the one that needs the most scrolling, and the
      // one where a wrong scroll-margin is most obvious. #101 moved People here
      // (administration last); this suite runs as the owner, so it is on the page.
      await nav.getByRole("link", { name: "People" }).click();
      const heading = page.locator("#settings-people");
      await expect(heading).toBeFocused();
      // Actually ON SCREEN — toBeVisible() alone passes on an unscrolled page.
      await expect(heading).toBeInViewport();
      await expectClearOfStickyBar(nav, heading);

      // …and the bar is still stuck to the top of the viewport after the scroll.
      expect((await nav.boundingBox())!.y).toBeLessThan(4);
      // The destination lights up, including at the end of the page, where it can
      // never reach the top of the viewport and "topmost wins" would strand it.
      await expect(nav.locator("a[aria-current]")).toHaveText(/People/);
    });

    test("a jump to a section the page cannot scroll to the top still lights THAT one", async ({
      page,
    }) => {
      // #101 — the end-of-page rule used to steal this: jumping to the
      // second-to-last section scrolls the page to its limit, and "at the end of
      // the document ⇒ the last section" then overrode the reader's explicit
      // choice. Collapsing eight sections made the page short enough that this is
      // the common case rather than a corner.
      const nav = page.locator(SETTINGS_NAV);
      await openPanel(nav);
      await nav.getByRole("link", { name: "Demo" }).click();
      await expect(nav.locator("a[aria-current]")).toHaveText(/Demo/);
      await expect(
        page.locator("[data-section-header][data-current]"),
      ).toContainText("Demo");
    });

    test("aria-current follows the section you scrolled to", async ({
      page,
    }) => {
      const nav = page.locator(SETTINGS_NAV);

      // At the top of the page the FIRST section is current — #101 made that the
      // Focus timer (frequency of use descending; People moved to the end). In
      // the all-expanded state this also proves the spy took back over after
      // expandAllSections clicked its way down the page: each header click names
      // its own section, and scrolling home has to release that.
      await expect(nav.locator("a[aria-current]")).toHaveText(/Focus timer/);

      await openPanel(nav);
      await nav.getByRole("link", { name: "Notifications" }).click();
      await expect(nav.locator("a[aria-current]")).toHaveText(/Notifications/);
      // Exactly one, always.
      await expect(nav.locator("a[aria-current]")).toHaveCount(1);
      // The cue is not colour alone.
      await expect(
        nav.locator("a[aria-current] [data-current-marker]"),
      ).toBeVisible();
    });

    test("the current section's heading pins below the bar, highlighted", async ({
      page,
    }) => {
      const nav = page.locator(SETTINGS_NAV);
      // Scroll well into a section (not via the nav — this is the SCROLL case).
      await scrollIntoSection(page, "settings-focus-timer");

      const pinned = page.locator("[data-section-header][data-current]");
      await expect(pinned).toHaveCount(1);

      const navBox = (await nav.boundingBox())!;
      const pinnedBox = (await pinned.boundingBox())!;
      // Pinned directly below the bar — iOS-style, not scrolled away with the
      // content and not hidden underneath the bar.
      expect(Math.round(pinnedBox.y)).toBe(
        Math.round(navBox.y + navBox.height),
      );

      // The nav entry for that same section is the one marked current, so the two
      // layers can never tell the reader two different things.
      const pinnedId = await pinned.locator("h2").getAttribute("id");
      const currentHref = await nav
        .locator("a[aria-current]")
        .getAttribute("href");
      expect(currentHref).toBe(`#${pinnedId}`);

      // Not colour alone: the pinned position plus a marker dot (::before) plus
      // aria-current on the nav entry. Assert the dot actually renders.
      const dot = await pinned.evaluate(
        (el) => getComputedStyle(el, "::before").width,
      );
      expect(dot).not.toBe("auto");
      expect(dot).not.toBe("0px");
    });
  });
}

test.describe("section nav — desktop", () => {
  test.use({ viewport: DESKTOP });

  test("keyboard only: tab into the nav, Enter jumps, focus lands on the heading", async ({
    page,
  }) => {
    await page.goto("/help");
    await waitForShell(page);
    await waitForNavHydrated(page);
    const nav = page.locator(HELP_NAV);
    const toggle = nav.getByRole("button", { name: /jump to/i });

    // The toggle is operable from the keyboard and reports its state.
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await toggle.focus();
    await page.keyboard.press("Enter");
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    await page.keyboard.press(" ");
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await page.keyboard.press("Enter");
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
    await openPanel(nav);
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
    // The elements this regression is about (the disabled model radios, the
    // guest integrations shell) live INSIDE sections, so #101's collapse would
    // otherwise take the repro off the page.
    await expandAllSections(page);
    await openPanel(nav);
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

  test("the pinned header is opaque and above the page's content", async ({
    page,
  }) => {
    await page.goto("/settings");
    await waitForShell(page);
    await waitForNavHydrated(page);
    await expandAllSections(page);
    await scrollIntoSection(page, "settings-focus-timer");

    // A second sticky layer is a second chance for `opacity < 1` elements later
    // in the page to paint over it (see the bar's z-index note).
    const layers = await page.evaluate(() => {
      const nav = document.querySelector(
        'nav[aria-label="Settings sections"]',
      )!;
      const band = document.querySelector(
        "[data-section-header][data-current]",
      )!;
      const box = band.getBoundingClientRect();
      const mid = Math.round(window.innerWidth / 2);
      const atBar = document.elementFromPoint(mid, 3);
      const atBand = document.elementFromPoint(
        mid,
        Math.round(box.y + box.height / 2),
      );
      return {
        bar: atBar ? nav.contains(atBar) || atBar === nav : false,
        band: atBand ? band.contains(atBand) || atBand === band : false,
      };
    });
    expect(layers).toEqual({ bar: true, band: true });
  });

  test("the save indicator keeps its own colour inside a highlighted band", async ({
    page,
  }) => {
    // Review finding on !162: the band forces its inline badges to inherit its
    // magenta foreground so they stay legible, but the save indicator's colour
    // IS its meaning — green saved, red failed. Forcing it to inherit made the
    // two states identical at a glance for exactly the section you are reading.
    await page.goto("/settings");
    await waitForShell(page);
    await waitForNavHydrated(page);
    // Jump to Aging so ITS band is the lit one — the aging inputs live inside
    // that section, and it is not the section that is current on load (#101 put
    // the Focus timer first). Open it too: since #101 the inputs are behind the
    // section's own disclosure, and this test is about what a save looks like
    // INSIDE a highlighted band.
    await openPanel(page.locator(SETTINGS_NAV));
    await page
      .locator(SETTINGS_NAV)
      .getByRole("link", { name: "Aging & reminder" })
      .click();
    await expandSection(page, "settings-aging");
    await expect(
      page.locator("[data-section-header][data-current]"),
    ).toHaveText(/Aging & reminder/);

    const threshold = page.getByLabel("Aging threshold (minutes)");
    const original = await threshold.inputValue();
    await threshold.fill(String(Number(original) + 1));

    const indicator = page.locator("[data-save-status]");
    await expect(indicator).toBeVisible({ timeout: 15_000 });

    const paint = await page.evaluate(() => {
      const band = document.querySelector(
        "[data-section-header][data-current]",
      )!;
      const chip = document.querySelector("[data-save-status]")!;
      const chipStyle = getComputedStyle(chip);
      return {
        insideBand: band.contains(chip),
        bandForeground: getComputedStyle(band).color,
        chipForeground: chipStyle.color,
        chipBackground: chipStyle.backgroundColor,
      };
    });

    expect(paint.insideBand).toBe(true);
    // It did NOT inherit the band's foreground…
    expect(paint.chipForeground).not.toBe(paint.bandForeground);
    // …and it sits on an opaque chip, so its own colour is readable rather than
    // ~1.3:1 green-on-magenta.
    expect(paint.chipBackground).not.toBe("rgba(0, 0, 0, 0)");
    expect(paint.chipBackground).not.toBe("transparent");

    // Leave the workspace as we found it — other specs read these settings.
    await threshold.fill(original);
    await expect(page.locator("[data-save-status]")).toBeVisible({
      timeout: 15_000,
    });
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

test.describe("section nav — mobile budget", () => {
  test.use({ viewport: MOBILE });

  test("both sticky layers together stay a small slice of a phone screen", async ({
    page,
  }) => {
    await page.goto("/settings");
    await waitForShell(page);
    await waitForNavHydrated(page);
    await scrollIntoSection(page, "settings-focus-timer");

    const nav = (await page.locator(SETTINGS_NAV).boundingBox())!;
    const band = (await page
      .locator("[data-section-header][data-current]")
      .boundingBox())!;
    const combined = nav.height + band.height;

    // Measured at 390x844: 61px bar + 56px header = 117px, 14% of the viewport.
    // (#101 grew the header from 40px: its title is now a 44px-tall disclosure
    // trigger, because a 16px chevron is not a touch target.) Budget it at 20% so
    // a future change that doubles it fails here rather than quietly eating the
    // screen.
    expect(combined).toBeLessThan(MOBILE.height * 0.2);
  });
});

// Screenshots for review. Not assertions — the owner wants to eyeball this one.
// Three states x two viewports x both themes: the collapsed resting bar, the
// expanded "Jump to" panel, and mid-scroll with a section header pinned.
test.describe("section nav — screenshots", () => {
  for (const [size, viewport] of [
    ["desktop", DESKTOP],
    ["mobile", MOBILE],
  ] as const) {
    for (const theme of THEMES) {
      test(`captures ${size} / ${theme}`, async ({ page }) => {
        await page.setViewportSize(viewport);
        // setTheme's addInitScript must run before the first goto.
        await setTheme(page, theme);

        for (const route of ["settings", "help"] as const) {
          await page.goto(`/${route}`);
          await waitForShell(page);
          await waitForNavHydrated(page);
          // Guard the precondition: a silently-light "dark" screenshot is worse
          // than no screenshot, because it looks like it was reviewed.
          await expectThemeApplied(page, theme);
          const nav = page.locator(`nav[aria-label$="sections"]`);

          // 1. resting state: the collapsed one-line bar.
          await expect(
            nav.getByRole("button", { name: /jump to/i }),
          ).toHaveAttribute("aria-expanded", "false");
          await page.screenshot({
            path: `${SHOTS}/${route}-${size}-${theme}-collapsed.png`,
          });

          // 2. the expanded map.
          await openPanel(nav);
          await page.screenshot({
            path: `${SHOTS}/${route}-${size}-${theme}-expanded.png`,
          });
        }

        // 3. mid-scroll on Settings, with a section header pinned under the bar.
        await page.goto("/settings");
        await waitForShell(page);
        await waitForNavHydrated(page);
        await scrollIntoSection(page, "settings-focus-timer");
        await expect(
          page.locator("[data-section-header][data-current]"),
        ).toBeVisible();
        await page.screenshot({
          path: `${SHOTS}/settings-${size}-${theme}-pinned.png`,
        });
      });
    }
  }
});
