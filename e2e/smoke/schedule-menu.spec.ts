import { test, expect } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import {
  waitForShell,
  setTheme,
  expectThemeApplied,
  settledFocusLabel,
  THEMES,
  MOBILE,
  DESKTOP,
} from "../helpers";
import {
  MARKER,
  TASK_ID,
  seedScheduleMenuFixture,
  removeScheduleMenuFixture,
  multiStepRow,
  passedDeadlineInputValue,
} from "../schedule-menu-fixture";

/**
 * The Schedule menu in a production build (#106).
 *
 * Why a build-level gate at all: the menu's summary line is a sentence assembled
 * from JSX, and `next build`'s whitespace trimming differs from vitest's. That
 * class of bug shipped `"rolling 30 dayswindow"` once. jsdom cannot see it.
 *
 * ── Making the Google path reachable ────────────────────────────────────────
 * The #104 plan said the Google path was unreachable in e2e. That is true for
 * PUSHING, and it is not true for OPENING the menu — but it takes more than the
 * two client env vars: `scheduleState` (inbox-view.tsx) returns "connect" unless
 * Google is BOTH configured AND connected, and `getGoogleStatus().connected` is
 * whether this user's stored `accessToken` DECRYPTS — not whether the column is
 * populated. (It was `Boolean(auth.accessToken)` when this note was written; #119
 * changed it so a key rotation stops the UI claiming "Connected" while every push
 * fails. !200 is what happens when the fixture gets that key wrong.)
 *
 * So: playwright.config.ts supplies the dummy client id/secret for the whole run
 * (which on its own changes nothing — no token, still "connect"), and the shared
 * fixture seeds the token row and removes it again. Seeding per spec file rather
 * than in global-setup is deliberate: `connected: true` changes the 📅 control on
 * EVERY row while it is in place, and only the two schedule-menu specs want that.
 * The suite runs serially (playwright.config.ts: workers 1, fullyParallel false),
 * so each file's window is its own.
 *
 * Nothing can reach Google. The token is a dummy string that would not survive
 * decryption, and the spec never presses Schedule — it opens the popover, reads
 * it, and closes it.
 *
 * ── What is NOT here ────────────────────────────────────────────────────────
 * The menu's WCAG assertions moved to `e2e/a11y/axe-schedule-menu.spec.ts`
 * (#247). This file runs in the `chromium` project, which keeps the suite-wide
 * `retries` — right for two standalone servers and a real Postgres, wrong for an
 * accessibility assertion, because a retried AA failure is indistinguishable
 * from a real regression that happens to be timing-dependent. #127 removed the
 * retry from the `a11y` project and could not see these calls, because it guards
 * a project and an a11y assertion is a call. The shared fixture is what lets both
 * files drive the same menu: Playwright refuses to let one spec import another.
 */

const SHOTS = "test-results/schedule-menu";

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

test("the Schedule menu opens, reads correctly, and closes on Escape", async ({
  page,
}) => {
  await page.goto("/");
  await waitForShell(page);

  const row = multiStepRow(page);
  await expect(row).toBeVisible();
  // Configured AND connected, so the row's control is the Google one.
  // `exact`: the marker is the task title, so "Drag <title>" / "Edit <title>"
  // also contain it — only the Schedule control is named exactly "Schedule".
  //
  // #253 — reached from the ▾ list; the 📅 icon went with the trailing icon
  // cluster, and the entry opens the same #106 dialog.
  await row.getByRole("button", { name: "All options" }).click();
  const trigger = row.getByRole("button", { name: "Schedule", exact: true });
  await trigger.click();

  // Portaled into the row, so a row-scoped query still finds it (#92's idiom).
  // #253 — named, because the ▾ list Base UI renders is a `dialog` as well.
  const dialog = row.getByRole("dialog", { name: `Schedule ${MARKER}` });
  await expect(dialog).toBeVisible();
  await expect(dialog).toHaveAccessibleName(`Schedule ${MARKER}`);

  // The summary line, assembled from JSX — the exact bug class this guards.
  // Read the RAW textContent: Playwright's text matchers normalise whitespace,
  // which would make a collapsed-seam assertion vacuous.
  const summary = await dialog
    .getByRole("status")
    .evaluate((el) => el.textContent ?? "");
  expect(summary).toMatch(
    /^3 steps · 2h15m of blocks, spread in order before \w{3} \d{1,2} \w{3}$/,
  );

  // Prefilled from the shared defaults: nothing has been persisted for this task.
  await expect(dialog.getByLabel("Done by")).toBeVisible();
  await expect(dialog.getByLabel("Priority")).toHaveValue("high");
  await expect(dialog.getByRole("radio", { name: "Work" })).toBeChecked();

  // The mechanical WCAG gate over this same open dialog lives in
  // e2e/a11y/axe-schedule-menu.spec.ts, where it runs with no retry (#247). The
  // accessible-name assertion above stays here because it is a behavioural
  // claim about the summary the menu renders, not a baseline-relative axe scan.

  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  // Focus comes back to the control that opened it, not to the document.
  await expect(trigger).toBeFocused();
  // …and it STAYS there, which `toBeFocused()` above cannot tell you: it is a
  // retrying matcher, so it is satisfied by focus that touches the entry for one
  // frame on its way somewhere else. #253 made that distinction matter — the ▾
  // popover this entry lives in re-grabs focus onto its own container a frame
  // after an inner popup closes, so both the "never arrived" and the "arrived and
  // was taken away" shapes are live here. See `settledFocusLabel` and
  // `restoreFocusToTrigger` (src/components/ui/anchored-popup.ts).
  expect(
    await settledFocusLabel(page),
    "focus after the Schedule dialog closes",
  ).toBe("Schedule");
});

test("the menu remembers the choice, and the .ics path keeps its one click", async ({
  page,
}) => {
  // What the owner said last time, persisted by #106's three columns.
  await prisma.task.update({
    where: { id: TASK_ID },
    data: {
      scheduleDueAt: new Date("2026-12-24T17:00:00.000Z"),
      schedulePriority: "critical",
      scheduleHours: "personal",
    },
  });

  await page.goto("/");
  await waitForShell(page);
  const row = multiStepRow(page);
  await row.getByRole("button", { name: "All options" }).click(); // #253
  await row.getByRole("button", { name: "Schedule", exact: true }).click();

  // #253 — named, because the ▾ list Base UI renders is a `dialog` as well.
  const dialog = row.getByRole("dialog", { name: `Schedule ${MARKER}` });
  await expect(dialog.getByLabel("Priority")).toHaveValue("critical");
  await expect(dialog.getByRole("radio", { name: "Personal" })).toBeChecked();
  await expect(dialog.getByLabel("Done by")).toHaveValue("2026-12-24");
  await page.keyboard.press("Escape");

  // The .ics alternative in the ▾ menu still downloads on one press of the entry —
  // no dialog, no second step. A guest has nothing the menu could offer beyond a
  // deadline.
  //
  // No re-open: Escape dismisses the Schedule dialog and leaves the ▾ list
  // standing — one Escape per layer. Asserted here directly rather than inferred
  // from the sibling spec's focus check, which is what the note here used to do:
  // it read that check as evidence the list was open while the check was in fact
  // failing (the entry never kept focus — see `restoreFocusToTrigger`). Two
  // claims about the same behaviour, one of them unverified, and the false one was
  // the one being cited. Pressing the trigger again would have toggled the list
  // shut.
  await expect(row.getByRole("dialog", { name: "All options" })).toBeVisible();
  const downloadPromise = page.waitForEvent("download");
  await row.getByRole("button", { name: "Add to calendar (.ics)" }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(/\.ics$/);
});

test("the menu is usable on a 390px phone screen", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await waitForShell(page);

  const row = multiStepRow(page);
  await row.getByRole("button", { name: "All options" }).click(); // #253
  await row.getByRole("button", { name: "Schedule", exact: true }).click();
  // #253 — named, because the ▾ list Base UI renders is a `dialog` as well.
  const dialog = row.getByRole("dialog", { name: `Schedule ${MARKER}` });
  await expect(dialog).toBeVisible();

  // #92's lesson: an anchored popup near the right edge used to lay out off
  // screen with no scroll to recover with. Every edge must be inside the
  // viewport, and the primary action reachable.
  const box = (await dialog.boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(390);
  expect(box.y).toBeGreaterThanOrEqual(0);

  const go = dialog.getByRole("button", { name: "Schedule", exact: true });
  await expect(go).toBeVisible();
  const goBox = (await go.boundingBox())!;
  expect(goBox.height).toBeGreaterThanOrEqual(44);
});

// The feasibility warning's contrast scan moved to
// e2e/a11y/axe-schedule-menu.spec.ts (#247) — it is a zero-tolerance colour
// assertion, and this project retries.
//
// Screenshots for review. Not assertions — a green suite is not the same evidence
// as the owner's own eyes on a new surface, so this captures the open menu in
// both themes at both widths. (This comment sat above the contrast block until
// #247 separated the two; it always described the screenshots.)
test.describe("schedule menu — screenshots", () => {
  for (const [size, viewport] of [
    ["desktop", DESKTOP],
    ["mobile", MOBILE],
  ] as const) {
    for (const theme of THEMES) {
      test(`captures ${size} / ${theme}`, async ({ page }) => {
        await page.setViewportSize(viewport);
        await setTheme(page, theme);
        await page.goto("/");
        await waitForShell(page);
        // Guard the precondition: a silently-light "dark" screenshot is worse
        // than no screenshot, because it looks like it was reviewed.
        await expectThemeApplied(page, theme);

        const row = multiStepRow(page);
        await expect(row).toBeVisible();
        await row.getByRole("button", { name: "All options" }).click(); // #253
        await row
          .getByRole("button", { name: "Schedule", exact: true })
          .click();
        const dialog = row.getByRole("dialog", {
          name: `Schedule ${MARKER}`,
        }); // #253: named — the ▾ list is a dialog too
        await expect(dialog).toBeVisible();
        await page.screenshot({ path: `${SHOTS}/${size}-${theme}-open.png` });

        // The warning mood, which is the other half of the surface: a deadline
        // already past cannot hold 2h15m of work, and the menu says so without
        // blocking.
        await dialog.getByLabel("Done by").fill(passedDeadlineInputValue());
        await expect(dialog.getByRole("status")).toContainText(/need/i);
        await page.screenshot({
          path: `${SHOTS}/${size}-${theme}-warning.png`,
        });
      });
    }
  }
});
