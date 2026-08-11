import { test, expect, type Page } from "@playwright/test";
import {
  DESKTOP,
  THEMES,
  setTheme,
  expectThemeApplied,
  waitForShell,
  sectionToggle,
  expandSection,
} from "../helpers";
import { scanColorContrast, expectNoContrastViolations } from "./axe-helpers";

/**
 * The owner-only People panel's contrast gate.
 *
 * ── Why the panel needs its own scan (#35 / !175) ────────────────────────────
 * `e2e/a11y-contrast.spec.ts` scans owner `/settings` with ZERO tolerance, and
 * that scan used to see the whole People panel. Collapsing it by default took
 * ~1900px of controls out of the scanned DOM: the selects, the number inputs,
 * the status pills and the destructive Revoke button all sit behind a `hidden`
 * attribute, which axe correctly skips. Both themes, because that is the axis
 * contrast actually varies on — and the lesson from #90 is that a surface
 * nothing looks at is where the 2.7:1 text lives.
 *
 * ── Why it lives here rather than in the smoke spec (#247) ───────────────────
 * These three tests were in `e2e/smoke/people-admin.spec.ts`, which runs in the
 * `chromium` project, where the suite-wide `retries` applies. #127 gave the
 * `a11y` project `retries: 0` because a retried AA assertion is
 * indistinguishable from a flake — and these calls were outside it, because that
 * guard is keyed on the FILE and an a11y assertion is a CALL.
 *
 * The behavioural half of the panel — the invite → pending → withdraw round trip
 * against a real database, the sticky-nav geometry, the owner's own row offering
 * no way to lock themselves out — stays in the smoke spec and keeps its retry.
 * Only the WCAG assertions move.
 *
 * `src/lib/e2e-project-split.test.ts` fails if an a11y helper becomes reachable
 * from a retrying project again.
 */

const PEOPLE_SECTION = "settings-people";

/** Open the panel (it rests collapsed) and wait for its body to be on screen. */
async function openPeople(page: Page): Promise<void> {
  await expandSection(page, PEOPLE_SECTION);
  await expect(page.getByRole("list", { name: /accounts/i })).toBeVisible();
}

for (const theme of THEMES) {
  test.describe(`People panel color-contrast — ${theme}`, () => {
    test.use({ viewport: DESKTOP });

    test.beforeEach(async ({ page }) => {
      await setTheme(page, theme);
    });

    test(`zero color-contrast violations: collapsed (${theme})`, async ({
      page,
    }) => {
      await page.goto("/settings");
      await waitForShell(page);
      await expectThemeApplied(page, theme);
      // The resting state: the trigger (the section title, `text-lg
      // font-semibold`) and its muted `text-sm` summary line are the only People
      // UI on the page. Since #101 every other section is collapsed here too, so
      // this scan also covers eight more triggers and chevrons.
      await expect(sectionToggle(page, PEOPLE_SECTION)).toBeVisible();
      expectNoContrastViolations(await scanColorContrast(page));
    });

    test(`zero color-contrast violations: expanded (${theme})`, async ({
      page,
    }) => {
      await page.goto("/settings");
      await waitForShell(page);
      await expectThemeApplied(page, theme);
      await openPeople(page);
      expectNoContrastViolations(await scanColorContrast(page));
    });

    test(`zero color-contrast violations: mid-revoke confirmation (${theme})`, async ({
      page,
    }) => {
      // The destructive branch renders copy no other state does, on a
      // `bg-destructive` button — the one place in this panel where colour is
      // carrying meaning, and the state a scan of the resting page never reaches.
      await page.goto("/settings");
      await waitForShell(page);
      await expectThemeApplied(page, theme);
      await openPeople(page);
      // The seeded member (e2e/constants.ts) — the owner's own card carries no
      // revoke control by design, so this needs the OTHER account. Opening the
      // confirmation is enough; deliberately never confirmed, so the shared
      // fixture is not mutated for the specs that run after this one.
      const target = page.locator('[data-person-label="e2e-member"]');
      await target.getByRole("button", { name: "Revoke e2e-member" }).click();
      await expect(
        target.getByRole("button", { name: "Yes, revoke e2e-member" }),
      ).toBeVisible();
      expectNoContrastViolations(await scanColorContrast(page));
    });
  });
}
