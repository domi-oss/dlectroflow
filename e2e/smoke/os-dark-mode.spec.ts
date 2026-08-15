import { test, expect, type Page } from "@playwright/test";
import {
  DESKTOP,
  expandSection,
  expectThemeApplied,
  setOsColorScheme,
  setTheme,
  waitForShell,
} from "../helpers";

/**
 * #85 — the OS preference drives the FIRST PAINT.
 *
 * The jsdom suite (`src/lib/theme.test.ts`) executes the bootstrap string and
 * proves the logic. It cannot prove the two things that actually decide whether
 * this shipped working, because both are properties of a real browser parsing a
 * real document:
 *
 *  1. That the script runs before anything is painted, so there is no flash. A
 *     hook, an effect or a deferred script would all satisfy every unit test in
 *     the repo and still show the light default for a frame.
 *  2. That `prefers-color-scheme` is genuinely consulted end-to-end — through
 *     Next's `<head>`, the standalone server, and hydration — rather than in a
 *     module nothing calls.
 *
 * Runs against the real build, like every spec in this directory.
 */

/**
 * The proof of "no flash", and the reason it is shaped like this.
 *
 * A screenshot cannot show the absence of a one-frame flash: by the time
 * Playwright can take one, the corrected theme is already painted. So instead of
 * sampling the result, record every mutation to `<html>`'s `class` and
 * `data-theme` from BEFORE the page's own scripts run, and check WHEN the theme
 * arrived.
 *
 * `document.body === null` is the load-bearing part. The bootstrap sits in
 * `<head>`, so if the `dark` class is added while `<body>` has not yet been
 * parsed, the browser cannot have painted any of the app's own background —
 * there is nothing to paint yet. That is a stronger statement than "dark by the
 * time the test looked", which is what a post-load assertion gives you and what
 * a broken implementation would also satisfy.
 *
 * `MutationObserver` is attached to `document` rather than to
 * `document.documentElement`, because at init-script time the latter may not
 * exist yet — observing the document with `subtree: true` catches the attribute
 * changes either way.
 */
async function recordThemeMutations(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const log: {
      dark: boolean;
      preference: string | null;
      bodyExists: boolean;
      readyState: string;
    }[] = [];
    (window as unknown as { __themeLog: typeof log }).__themeLog = log;
    new MutationObserver((records) => {
      for (const record of records) {
        if (record.target !== document.documentElement) continue;
        log.push({
          dark: document.documentElement.classList.contains("dark"),
          preference: document.documentElement.getAttribute("data-theme"),
          bodyExists: Boolean(document.body),
          readyState: document.readyState,
        });
      }
    }).observe(document, {
      subtree: true,
      attributes: true,
      attributeFilter: ["class", "data-theme"],
    });
  });
}

function readThemeLog(page: Page) {
  return page.evaluate(
    () =>
      (
        window as unknown as {
          __themeLog: {
            dark: boolean;
            preference: string | null;
            bodyExists: boolean;
            readyState: string;
          }[];
        }
      ).__themeLog,
  );
}

test.describe("#85 the OS colour scheme decides the first paint", () => {
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize(DESKTOP);
  });

  test("a first visit on a dark OS paints DARK, before <body> exists", async ({
    page,
  }) => {
    await setOsColorScheme(page, "dark");
    await recordThemeMutations(page);
    await page.goto("/");
    await waitForShell(page);

    // The theme is dark, and the app knows it got there by following the OS
    // rather than by a stored choice — which is the state a first visit, and
    // every launch of the installed home-screen app, actually starts in.
    await expectThemeApplied(page, "dark", "system");

    const log = await readThemeLog(page);
    const firstDark = log.find((entry) => entry.dark);
    expect(
      firstDark,
      `nothing ever added the dark class. Mutation log: ${JSON.stringify(log)}`,
    ).toBeDefined();

    // ⚠️ The no-flash assertion. Set in <head>, while <body> is still unparsed,
    // so no app background has been painted in either theme.
    expect(
      firstDark!.bodyExists,
      `the dark class arrived AFTER <body> existed (readyState ${firstDark!.readyState}), ` +
        `so the light default was paintable first — that is the flash #85 is about. ` +
        `Mutation log: ${JSON.stringify(log)}`,
    ).toBe(false);
    expect(firstDark!.readyState).toBe("loading");

    // And nothing took it back off again: hydration must not reset <html>'s
    // class list, which is what #75 was and what ThemeSync could reintroduce.
    const wentLightAfter = log
      .slice(log.indexOf(firstDark!) + 1)
      .some((entry) => !entry.dark);
    expect(
      wentLightAfter,
      `the dark class was removed again after being set. Mutation log: ${JSON.stringify(log)}`,
    ).toBe(false);
  });

  test("a first visit on a light OS paints LIGHT", async ({ page }) => {
    await setOsColorScheme(page, "light");
    await page.goto("/");
    await waitForShell(page);
    await expectThemeApplied(page, "light", "system");
  });

  // The control for the test above: without it, "light on a light OS" is also
  // what a completely broken implementation returns, since light is what the app
  // did unconditionally before this change.
  //
  // ⚠️ Comparing the two END STATES is not enough, and this comment used to claim
  // it was ("the pair is what distinguishes 'follows the OS' from 'still always
  // light'"). MEASURED: with the `matchMedia` clause deleted from
  // THEME_BOOTSTRAP_SCRIPT — the exact #85 defect restored, `<head>` back to
  // `k=p==="dark"` — this test PASSED, and so did nine of the other ten in this
  // file. `ThemeSync` re-adds the class on mount, so the end state is identical
  // and only the ARRIVAL TIME differs; the mutation log on that build read
  // `[{dark:false,readyState:"loading"},{dark:true,readyState:"complete"}]`,
  // which is the one-frame flash this issue is about.
  //
  // So this asserts WHEN as well as WHETHER: on the dark device the class must
  // land before `<body>` is parsed, which nothing but the `<head>` script can do.
  // That keeps a second route (/help) covered by a first-paint assertion rather
  // than leaving the whole property resting on the single test above.
  test("the two OS settings actually differ on the same route, and dark lands before <body>", async ({
    browser,
  }) => {
    const results: boolean[] = [];
    for (const scheme of ["light", "dark"] as const) {
      const context = await browser.newContext({ colorScheme: scheme });
      const page = await context.newPage();
      await recordThemeMutations(page);
      await page.goto("/help");
      await waitForShell(page);
      results.push(
        await page.evaluate(() =>
          document.documentElement.classList.contains("dark"),
        ),
      );
      if (scheme === "dark") {
        const log = await readThemeLog(page);
        const firstDark = log.find((entry) => entry.dark);
        expect(
          firstDark,
          `nothing ever added the dark class on /help. Mutation log: ${JSON.stringify(log)}`,
        ).toBeDefined();
        expect(
          firstDark!.bodyExists,
          `on /help the dark class arrived only AFTER <body> existed (readyState ` +
            `${firstDark!.readyState}), so the <head> script did not resolve the OS ` +
            `and something later corrected it: the end state is right and the first ` +
            `paint is not. Mutation log: ${JSON.stringify(log)}`,
        ).toBe(false);
      }
      await context.close();
    }
    expect(results).toEqual([false, true]);
  });

  // An explicit choice is an override. Both directions, because only one of them
  // can be right by accident.
  for (const [choice, os] of [
    ["light", "dark"],
    ["dark", "light"],
  ] as const) {
    test(`an explicit ${choice} choice beats an OS set to ${os}`, async ({
      page,
    }) => {
      // setTheme already pins the OS to the opposite of the choice, which is
      // exactly this case — so this test is also the direct proof that every
      // both-themes gate in the suite is measuring the theme it names.
      await setTheme(page, choice);
      await page.goto("/");
      await waitForShell(page);
      await expectThemeApplied(page, choice, choice);
    });
  }

  test("switching the OS mid-session follows, with no reload", async ({
    page,
  }) => {
    await setOsColorScheme(page, "light");
    await page.goto("/");
    await waitForShell(page);
    await expectThemeApplied(page, "light", "system");

    // What macOS and iOS do on their own schedule at sunset — which is the
    // "automatic with time of day" this issue was opened asking for.
    await page.emulateMedia({ colorScheme: "dark" });
    await expect
      .poll(() =>
        page.evaluate(() =>
          document.documentElement.classList.contains("dark"),
        ),
      )
      .toBe(true);

    await page.emulateMedia({ colorScheme: "light" });
    await expect
      .poll(() =>
        page.evaluate(() =>
          document.documentElement.classList.contains("dark"),
        ),
      )
      .toBe(false);
  });

  // An explicit override must NOT move when the OS does, or the setting is
  // advisory rather than a choice.
  test("an explicit choice does not move when the OS does", async ({
    page,
  }) => {
    await setTheme(page, "dark");
    await page.goto("/");
    await waitForShell(page);
    await expectThemeApplied(page, "dark", "dark");

    await page.emulateMedia({ colorScheme: "light" });
    // Give the listener the same opportunity the passing case gets, so this is
    // a real "nothing happened" rather than a race that has not resolved yet.
    await page.waitForTimeout(250);
    await expectThemeApplied(page, "dark", "dark");
  });

  // /privacy renders OUTSIDE the (app) route group and therefore has no header
  // and no theme control. It follows the OS because ThemeSync is mounted in the
  // ROOT layout; a listener in the header would leave this page stuck on
  // whatever the OS said when it loaded.
  test("a page outside the (app) group follows the OS too", async ({
    page,
  }) => {
    await setOsColorScheme(page, "dark");
    await page.goto("/privacy");
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    await expectThemeApplied(page, "dark", "system");

    await page.emulateMedia({ colorScheme: "light" });
    await expect
      .poll(() =>
        page.evaluate(() =>
          document.documentElement.classList.contains("dark"),
        ),
      )
      .toBe(false);
  });
});

test.describe("#85 Settings > Appearance is where `system` lives", () => {
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize(DESKTOP);
  });

  test("comes up on Follow my system for someone who never chose", async ({
    page,
  }) => {
    await setOsColorScheme(page, "dark");
    await page.goto("/settings");
    await waitForShell(page);
    await expandSection(page, "settings-appearance");

    await expect(
      page.getByRole("radio", { name: "Follow my system" }),
    ).toBeChecked();
    // The header offers the OTHER theme, i.e. it read the resolved theme rather
    // than the stored preference.
    await expect(
      page
        .locator("header")
        .getByRole("button", { name: "Switch to light mode" }),
    ).toBeVisible();
  });

  test("choosing Dark overrides a light OS, and Follow my system takes it back", async ({
    page,
  }) => {
    await setOsColorScheme(page, "light");
    await page.goto("/settings");
    await waitForShell(page);
    await expandSection(page, "settings-appearance");
    await expectThemeApplied(page, "light", "system");

    await page.getByRole("radio", { name: "Dark", exact: true }).click();
    await expectThemeApplied(page, "dark", "dark");

    // Reversible — the thing the two-state toggle could not do, and the reason
    // this became a radiogroup.
    await page.getByRole("radio", { name: "Follow my system" }).click();
    await expectThemeApplied(page, "light", "system");
  });

  test("the choice survives a reload", async ({ page }) => {
    await setOsColorScheme(page, "light");
    await page.goto("/settings");
    await waitForShell(page);
    await expandSection(page, "settings-appearance");
    await page.getByRole("radio", { name: "Dark", exact: true }).click();
    await expectThemeApplied(page, "dark", "dark");

    await page.reload();
    await waitForShell(page);
    await expectThemeApplied(page, "dark", "dark");
    await expandSection(page, "settings-appearance");
    await expect(
      page.getByRole("radio", { name: "Dark", exact: true }),
    ).toBeChecked();
  });
});
