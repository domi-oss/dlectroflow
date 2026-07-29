import { test, expect, type Page } from "@playwright/test";
import {
  DESKTOP,
  MOBILE,
  THEMES,
  setTheme,
  expectThemeApplied,
  waitForShell,
  sectionToggle,
  expandSection,
  expandAllSections,
} from "../helpers";

// #101 — every section of /settings is a disclosure, in a new order, with a
// chevron before its title.
//
// What only a real browser can answer, and jsdom cannot:
//  • the SERVER's HTML already has the right eight collapsed and one open, so
//    there is no expanded-then-collapsed flash on hydration;
//  • the chevron really rotates (a computed transform, not a class name);
//  • the trigger really is a 44px row rather than a 16px glyph;
//  • whitespace in the built page. !175 shipped "rolling 30 dayswindow" to a
//    screenshot because vitest's JSX transform and `next build`'s disagree about
//    trimming — this suite runs against `npm run start`, which is where that
//    class of bug is visible.
//
// The section-nav interaction under collapse (jump, scroll-spy, pinned header,
// focus handover) is checked in e2e/smoke/section-nav.spec.ts, which #101
// extended to run its checks in both the landing and all-expanded states.

/** The page's section ids, in the order SETTINGS_SECTIONS lists them. */
const SECTION_IDS = [
  "settings-focus-timer",
  "settings-appearance",
  "settings-notifications",
  "settings-voice",
  "settings-aging",
  "settings-breakdown-model",
  "settings-integrations",
  // #118 Phase C — your own account (the per-user LLM key). Signed-in only, and
  // this suite runs as the owner, so it is on the page.
  "settings-account",
  "settings-demo",
  "settings-people",
] as const;

/** The one section the page opens on arrival (owner's call). */
const OPEN_ON_ARRIVAL = "settings-focus-timer";

const SETTINGS_NAV = 'nav[aria-label="Settings sections"]';
const SHOTS = "test-results/settings-disclosure";

/**
 * Wait for a chevron's rotation to come to rest.
 *
 * Screenshots taken the instant `aria-expanded` flips catch the chevron a few
 * degrees in, which makes a review shot look like a rendering bug. Found by
 * looking at the shots rather than by a failing assertion.
 */
async function waitForChevronSettled(page: Page, id: string): Promise<void> {
  await expect
    .poll(() =>
      page.evaluate((sectionId) => {
        const svg = document
          .querySelector(`[data-section-toggle="${sectionId}"]`)!
          .querySelector("svg")!;
        const rotate = getComputedStyle(svg).rotate;
        return rotate && rotate !== "none" ? Math.round(parseFloat(rotate)) : 0;
      }, id),
    )
    .toBe(180);
}

/**
 * Wait for a (smooth) scroll to come to rest.
 *
 * The nav opts the document into `scroll-smooth` while it is mounted, so a
 * `window.scrollTo` ANIMATES — a screenshot taken straight after it catches the
 * page still at the top. Found by looking at a shot that had not moved.
 */
async function waitForScrollToSettle(page: Page): Promise<void> {
  await page.waitForFunction(
    () =>
      new Promise<boolean>((resolve) => {
        let last = window.scrollY;
        let still = 0;
        const tick = () => {
          if (window.scrollY === last) {
            if (++still > 3) return resolve(true);
          } else {
            still = 0;
            last = window.scrollY;
          }
          requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      }),
  );
}

async function waitForNavHydrated(page: Page): Promise<void> {
  await expect
    .poll(() =>
      page.evaluate(() =>
        document.documentElement.classList.contains("scroll-smooth"),
      ),
    )
    .toBe(true);
}

test.describe("settings disclosure — the landing state", () => {
  test.use({ viewport: DESKTOP });

  test("every section is a disclosure, and exactly one of them is open", async ({
    page,
  }) => {
    await page.goto("/settings");
    await waitForShell(page);

    // One trigger per section on the page, and the page's order is the nav's.
    const ids = await page
      .locator("[data-section-toggle]")
      .evaluateAll((els) =>
        els.map((el) => el.getAttribute("data-section-toggle")),
      );
    expect(ids).toEqual([...SECTION_IDS]);

    for (const id of SECTION_IDS) {
      await expect(sectionToggle(page, id)).toHaveAttribute(
        "aria-expanded",
        id === OPEN_ON_ARRIVAL ? "true" : "false",
      );
    }
  });

  test("the collapsed page reads as a list of titles, not as a wall", async ({
    page,
  }) => {
    await page.goto("/settings");
    await waitForShell(page);

    // Each closed section costs a header row and nothing else. Measured at 56px
    // (a 44px trigger plus the band's padding); budgeted at 80 so a change that
    // doubles it fails here.
    for (const id of SECTION_IDS.filter((s) => s !== OPEN_ON_ARRIVAL)) {
      const section = page.locator(`#${id}`).locator("xpath=ancestor::section");
      const box = (await section.boundingBox())!;
      expect(box.height, `${id} is ${box.height}px closed`).toBeLessThan(80);
    }
  });

  test("expansion is remembered for the visit but never persisted", async ({
    page,
  }) => {
    await page.goto("/settings");
    await waitForShell(page);
    await expandSection(page, "settings-people");

    // Same visit, navigate away and back — this is a fresh render either way, so
    // what is asserted is the DEFAULT, which !162's precedent says must not be a
    // state the reader has forgotten they left.
    await page.reload();
    await waitForShell(page);
    await expect(sectionToggle(page, "settings-people")).toHaveAttribute(
      "aria-expanded",
      "false",
    );
  });

  test("the SERVER's html is already collapsed — no hydration flash", async ({
    page,
  }) => {
    // Before any JavaScript runs. If a section were expanded server-side and
    // collapsed on hydration, its body would arrive without `hidden`.
    const res = await page.request.get("/settings");
    const html = await res.text();

    for (const id of SECTION_IDS) {
      const tag = new RegExp(`<button[^>]*data-section-toggle="${id}"[^>]*>`);
      const match = tag.exec(html);
      expect(match, `no trigger for ${id} in the server HTML`).not.toBeNull();

      const expanded = id === OPEN_ON_ARRIVAL;
      expect(match![0], id).toContain(`aria-expanded="${expanded}"`);

      const controls = /aria-controls="([^"]+)"/.exec(match![0]);
      expect(controls, `${id} controls nothing`).not.toBeNull();
      // The body is present in that same first response, and hidden (or not)
      // exactly as the trigger claims.
      const body = new RegExp(`id="${controls![1]}"( hidden="")? class=`);
      const bodyTag = body.exec(html);
      expect(bodyTag, `no body for ${id}`).not.toBeNull();
      expect(Boolean(bodyTag![1]), `${id} hidden attribute`).toBe(!expanded);
    }
  });

  test("the built page's copy is intact — no JSX whitespace trimming", async ({
    page,
  }) => {
    // The !175 regression, guarded in the only place it is visible: the produced
    // build. Both halves of the sentence and the space between them.
    await page.goto("/settings");
    await waitForShell(page);
    await expandSection(page, "settings-people");
    await expect(page.getByText(/rolling 30 days window/i)).toBeVisible();
  });
});

test.describe("settings disclosure — the chevron affordance", () => {
  test.use({ viewport: DESKTOP });

  /**
   * The computed rotation of a trigger's chevron, in degrees.
   *
   * Tailwind v4's `rotate-*` utilities set the standalone `rotate` PROPERTY, not
   * a `transform: rotate(...)` — so reading `transform` here returns "none" and
   * proves nothing. Both are checked, because "the class is applied" is what a
   * unit test can see and "it actually rotated" is why this spec exists.
   */
  async function chevronRotation(page: Page, id: string): Promise<number> {
    return page.evaluate((sectionId) => {
      const svg = document
        .querySelector(`[data-section-toggle="${sectionId}"]`)!
        .querySelector("svg")!;
      const style = getComputedStyle(svg);
      const rotate = style.rotate;
      if (rotate && rotate !== "none") return Math.round(parseFloat(rotate));
      const t = style.transform;
      if (!t || t === "none") return 0;
      // matrix(a, b, c, d, e, f) — the rotation is atan2(b, a).
      const [a, b] = t
        .slice(t.indexOf("(") + 1, -1)
        .split(",")
        .map(Number);
      return Math.round((Math.atan2(b, a) * 180) / Math.PI);
    }, id);
  }

  test("sits before the title, and rotates rather than swapping glyph", async ({
    page,
  }) => {
    await page.goto("/settings");
    await waitForShell(page);

    const trigger = sectionToggle(page, "settings-appearance");
    // Left of the title, physically — the standard accordion affordance.
    const geometry = await trigger.evaluate((el) => {
      const svg = el.querySelector("svg")!;
      const label = el.querySelector("span")!;
      return {
        chevron: svg.getBoundingClientRect().right,
        title: label.getBoundingClientRect().left,
        chevronWidth: svg.getBoundingClientRect().width,
      };
    });
    expect(geometry.chevron).toBeLessThanOrEqual(geometry.title);
    expect(geometry.chevronWidth).toBeGreaterThan(8);

    // Collapsed points down; expanded points up. One element, rotated.
    expect(await chevronRotation(page, "settings-appearance")).toBe(0);
    await expandSection(page, "settings-appearance");
    // Polled: the rotation is a real CSS transition, so reading it the instant
    // aria-expanded flips catches it a degree or two in.
    await expect
      .poll(async () =>
        Math.abs(await chevronRotation(page, "settings-appearance")),
      )
      .toBe(180);
  });

  test("is decorative — a screen reader is never told about a caret", async ({
    page,
  }) => {
    await page.goto("/settings");
    await waitForShell(page);
    const trigger = sectionToggle(page, "settings-appearance");
    // The accessible name is the section, and nothing else.
    await expect(trigger).toHaveAccessibleName("Appearance");
    expect(await trigger.locator("svg").getAttribute("aria-hidden")).toBe(
      "true",
    );
  });

  test("does not animate when the reader asked for less motion", async ({
    page,
  }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto("/settings");
    await waitForShell(page);
    // globals.css forces every transition to ~0 under the reduce query (0.01ms,
    // deliberately not 0, so one-shot transitionend handlers still fire), so the
    // rotation is instant rather than removed — the state stays legible.
    const seconds = await page.evaluate(() => {
      const svg = document
        .querySelector('[data-section-toggle="settings-appearance"]')!
        .querySelector("svg")!;
      // Chromium serialises 0.01ms as "1e-05s", so parse rather than compare text.
      return parseFloat(getComputedStyle(svg).transitionDuration);
    });
    expect(seconds).toBeLessThan(0.001);
  });

  test("the whole header row is the target, at 44px, on a phone", async ({
    page,
  }) => {
    await page.setViewportSize(MOBILE);
    await page.goto("/settings");
    await waitForShell(page);

    for (const id of SECTION_IDS) {
      const trigger = sectionToggle(page, id);
      const box = (await trigger.boundingBox())!;
      // #73 had to fix an 11x20px hit box for exactly this reason.
      expect(
        box.height,
        `${id} trigger is ${box.height}px tall`,
      ).toBeGreaterThanOrEqual(44);
      // The row, not the glyph: it spans most of the header's width.
      const band = (await page
        .locator(`#${id}`)
        .locator("xpath=ancestor::*[@data-section-header][1]")
        .boundingBox())!;
      expect(
        box.width,
        `${id} trigger is only ${box.width}px wide`,
      ).toBeGreaterThan(band.width / 2);
    }
  });

  test("tapping the far END of the row toggles it, not just the chevron", async ({
    page,
  }) => {
    await page.setViewportSize(MOBILE);
    await page.goto("/settings");
    await waitForShell(page);

    const trigger = sectionToggle(page, "settings-voice");
    const box = (await trigger.boundingBox())!;
    // The empty space past the title — as far from the 16px glyph as the row
    // goes, and the part a thumb actually lands on. Playwright fails this click
    // if anything (the sticky bar, another pinned band) intercepts it.
    await trigger.click({
      position: { x: box.width - 8, y: box.height / 2 },
    });
    await expect(trigger).toHaveAttribute("aria-expanded", "true");
  });
});

test.describe("settings disclosure — clicking a header highlights that section", () => {
  test.use({ viewport: DESKTOP });

  test("the clicked section becomes the current one, on both layers", async ({
    page,
  }) => {
    // Owner request: "clicking other section headers should highlight the section
    // title". It reuses !162's magenta current-section treatment, so the pinned
    // band, the nav's aria-current and the marker dot must all agree.
    await page.goto("/settings");
    await waitForShell(page);
    await waitForNavHydrated(page);

    // On arrival the first section is current.
    await expect(page.locator(`${SETTINGS_NAV} a[aria-current]`)).toHaveText(
      /Focus timer/,
    );

    await sectionToggle(page, "settings-appearance").click();

    const pinned = page.locator("[data-section-header][data-current]");
    await expect(pinned).toHaveCount(1);
    await expect(pinned).toContainText("Appearance");
    // The nav agrees — two "you are here" cues can never name different sections.
    await expect(page.locator(`${SETTINGS_NAV} a[aria-current]`)).toHaveText(
      /Appearance/,
    );
    // The collapsed bar is the nav's resting state, and it answers "where am I?"
    // in WORDS there.
    await expect(page.locator(SETTINGS_NAV)).toContainText("Appearance");
    // …and once the map is open, the cue is still not colour alone: aria-current
    // plus the drawn dot in the pill, plus the ::before dot on the band.
    await page
      .locator(SETTINGS_NAV)
      .getByRole("button", { name: /jump to/i })
      .click();
    await expect(
      page.locator(`${SETTINGS_NAV} a[aria-current] [data-current-marker]`),
    ).toBeVisible();
    const dot = await pinned.evaluate(
      (el) => getComputedStyle(el, "::before").width,
    );
    expect(dot).not.toBe("0px");
  });

  test("closing a section highlights it too — the click is what matters", async ({
    page,
  }) => {
    await page.goto("/settings");
    await waitForShell(page);
    await waitForNavHydrated(page);

    await sectionToggle(page, "settings-notifications").click(); // open
    await expect(
      page.locator("[data-section-header][data-current]"),
    ).toContainText("Notifications");
    await sectionToggle(page, "settings-notifications").click(); // close again
    await expect(
      page.locator("[data-section-header][data-current]"),
    ).toContainText("Notifications");
  });

  test("a section near the BOTTOM keeps the highlight it was given", async ({
    page,
  }) => {
    // The end-of-page rule ("last section wins when the page is scrolled to its
    // limit") exists because the last section can never reach the top. Applied to
    // a section the reader explicitly clicked it is simply wrong — and #101 put
    // Integrations and Demo down there, so this is an everyday case now.
    await page.goto("/settings");
    await waitForShell(page);
    await waitForNavHydrated(page);

    await sectionToggle(page, "settings-integrations").scrollIntoViewIfNeeded();
    await sectionToggle(page, "settings-integrations").click();

    await expect(
      page.locator("[data-section-header][data-current]"),
    ).toContainText("Integrations");
    await expect(page.locator(`${SETTINGS_NAV} a[aria-current]`)).toHaveText(
      /Integrations/,
    );
  });

  test("scrolling away hands the highlight back to the scroll-spy", async ({
    page,
  }) => {
    await page.goto("/settings");
    await waitForShell(page);
    await waitForNavHydrated(page);

    await sectionToggle(page, "settings-demo").scrollIntoViewIfNeeded();
    await sectionToggle(page, "settings-demo").click();
    await expect(
      page.locator("[data-section-header][data-current]"),
    ).toContainText("Demo");

    // Back to the top: nothing sticky is left claiming to be current down there.
    await page.evaluate(() => window.scrollTo(0, 0));
    await expect(page.locator(`${SETTINGS_NAV} a[aria-current]`)).toHaveText(
      /Focus timer/,
      { timeout: 10_000 },
    );
    await expect(
      page.locator("[data-section-header][data-current]"),
    ).toHaveCount(1);
  });
});

// Screenshots for review. Not assertions — the owner wants to eyeball this one.
// The states that matter: the collapsed landing page, one section mid-expand, the
// chevron in both states, and a chevron inside the pinned magenta band.
test.describe("settings disclosure — screenshots", () => {
  for (const [size, viewport] of [
    ["desktop", DESKTOP],
    ["mobile", MOBILE],
  ] as const) {
    for (const theme of THEMES) {
      test(`captures ${size} / ${theme}`, async ({ page }) => {
        await page.setViewportSize(viewport);
        await setTheme(page, theme);
        await page.goto("/settings");
        await waitForShell(page);
        await waitForNavHydrated(page);
        // Guard the precondition: a silently-light "dark" screenshot is worse
        // than no screenshot, because it looks like it was reviewed.
        await expectThemeApplied(page, theme);

        // 1. The landing state: Focus timer open, the other eight closed.
        await page.screenshot({
          path: `${SHOTS}/${size}-${theme}-landing.png`,
          fullPage: true,
        });

        // 2. The chevron in BOTH states in one frame: the open section's header
        //    pinned at the top (pointing up) above the next section's closed
        //    header (pointing down). Scrolled to the seam between the two rather
        //    than expanding anything, so the comparison is like for like.
        await page.evaluate(() => {
          const heading = document.getElementById("settings-appearance")!;
          const section = heading.closest("section")!;
          const rect = section.getBoundingClientRect();
          // Put the closed header a third of the way down the viewport, with the
          // open section's pinned header still above it.
          window.scrollTo(
            0,
            window.scrollY + rect.top - window.innerHeight / 3,
          );
        });
        await waitForScrollToSettle(page);
        await page.screenshot({
          path: `${SHOTS}/${size}-${theme}-chevron-both-states.png`,
        });
        await page.evaluate(() => window.scrollTo(0, 0));
        await waitForScrollToSettle(page);

        // 3. Mid-expand, and with the clicked header pinned + magenta, which is
        //    where the chevron has to inherit `currentColor` legibly (!175 found
        //    a 1.16:1 composite in that band).
        await expandSection(page, "settings-notifications");
        await waitForChevronSettled(page, "settings-notifications");
        await expect(
          page.locator("[data-section-header][data-current]"),
        ).toContainText("Notifications");
        await page.screenshot({
          path: `${SHOTS}/${size}-${theme}-pinned-band-chevron.png`,
        });

        // 4. Everything open — the old page, for comparison.
        await expandAllSections(page);
        await page.screenshot({
          path: `${SHOTS}/${size}-${theme}-all-expanded.png`,
          fullPage: true,
        });
      });
    }
  }
});
