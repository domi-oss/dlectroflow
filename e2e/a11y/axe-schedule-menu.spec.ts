import { test, expect } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import { waitForShell, setTheme, expectThemeApplied, THEMES } from "../helpers";
import {
  scanA11y,
  scanColorContrast,
  expectNoContrastViolations,
} from "./axe-helpers";
import {
  seedScheduleMenuFixture,
  removeScheduleMenuFixture,
  openScheduleDialog,
  passedDeadlineInputValue,
} from "../schedule-menu-fixture";

/**
 * The Schedule menu's accessibility gate (#247).
 *
 * These three assertions used to live in `e2e/smoke/schedule-menu.spec.ts`,
 * which runs in the `chromium` project — where the suite-wide `retries` applies.
 * #127 gave the `a11y` project `retries: 0` precisely because a retry makes a
 * genuine AA regression indistinguishable from a flake, and these calls sat
 * outside it: the guard is keyed on the file, and an a11y assertion is a call.
 *
 * The cost of that was measured, not hypothetical. #222's `document-title` race
 * was masked at the `scanA11y` call site below for as long as the race existed,
 * so it never surfaced from `chromium`. It then failed in the `a11y` project on
 * `main`, where `deploy_production` was SKIPPED rather than failed, and
 * production sat a commit behind `main` until a third run went green.
 *
 * `src/lib/e2e-project-split.test.ts` now fails if any a11y helper becomes
 * reachable from a project that retries, so this cannot drift back.
 *
 * The behavioural half of the menu — the assembled summary sentence, the .ics
 * one-click path, the 390px layout, the screenshots — stays in the smoke spec
 * and keeps its retry, which is the right default for a spec driving two
 * standalone servers against a real Postgres. Only the WCAG assertions move.
 */

let prisma: PrismaClient;

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  prisma = new PrismaClient();
  try {
    await seedScheduleMenuFixture(prisma);
  } catch (err) {
    // Own the client's lifecycle on the seed path: a throw here means afterAll
    // never runs against a usable client, which would leak the connection.
    await prisma.$disconnect();
    throw err;
  }
});

test.afterAll(async () => {
  try {
    await removeScheduleMenuFixture(prisma);
  } finally {
    await prisma.$disconnect();
  }
});

test("the open Schedule menu has no WCAG violations", async ({ page }) => {
  await page.goto("/");
  await waitForShell(page);

  const dialog = await openScheduleDialog(page);
  // The precondition the scan depends on: a Popover.Popup is a `dialog`, so an
  // accessible name is required, and asserting it here means a scan that passes
  // because the dialog never opened cannot be mistaken for a clean gate.
  await expect(dialog).toHaveAccessibleName(/^Schedule /);
  await expect(dialog.getByLabel("Done by")).toBeVisible();

  // The mechanical WCAG gate, on a real accessibility tree rather than jsdom's
  // approximation of one: every control in the dialog must be labelled and
  // legible. Baseline-relative, like every other scanA11y call — see
  // e2e/a11y/axe-baseline.json.
  await scanA11y(page, "/ (schedule menu open)");
});

// The warning is the menu's one NEW colour pair (`text-amber-700
// dark:text-amber-400`), and it only exists once a deadline cannot hold the work —
// so the resting scan above never sees it. Both themes, zero tolerance, the same
// gate e2e/a11y-contrast.spec.ts applies to the core routes.
test.describe("the feasibility warning's contrast", () => {
  test.use({ contextOptions: { reducedMotion: "reduce" } });

  for (const theme of THEMES) {
    test(`no contrast violations with the warning showing — ${theme}`, async ({
      page,
    }) => {
      await setTheme(page, theme);
      await page.goto("/");
      await waitForShell(page);
      await expectThemeApplied(page, theme);

      const dialog = await openScheduleDialog(page);
      // A deadline that has already passed cannot hold 2h15m of work, at any
      // hour — see passedDeadlineInputValue for why "today" was not that.
      await dialog.getByLabel("Done by").fill(passedDeadlineInputValue());
      await expect(dialog.getByRole("status")).toContainText(/need/i);

      expectNoContrastViolations(await scanColorContrast(page));
    });
  }
});
