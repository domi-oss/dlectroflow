import { test, expect, type Page } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import {
  waitForShell,
  setTheme,
  expectThemeApplied,
  THEMES,
  MOBILE,
  DESKTOP,
} from "../helpers";
import {
  scanA11y,
  scanColorContrast,
  expectNoContrastViolations,
} from "../a11y/axe-helpers";
import { OWNER_WS_ID, OWNER_USER_ID } from "../constants";
import { seedConnectedGoogle, clearGoogleTokens } from "../google-credential";

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
 * (which on its own changes nothing — no token, still "connect"), and this spec
 * seeds the token row itself and removes it again. Seeding here rather than in
 * global-setup is deliberate: `connected: true` changes the 📅 control on EVERY
 * row for the whole suite, and only this file wants that. The suite runs serially
 * (playwright.config.ts: workers 1, fullyParallel false), so the window is this
 * file alone.
 *
 * Nothing can reach Google. The token is a dummy string that would not survive
 * decryption, and the spec never presses Schedule — it opens the popover, reads
 * it, and closes it.
 */

const MARKER = "e2e-schedule-menu";
const TASK_ID = "e2e-schedule-menu-task";
const ITEM_ID = "e2e-schedule-menu-item";
const SHOTS = "test-results/schedule-menu";

// 30 + 45 + 60 = 135 working minutes, none of them below the 30-minute floor, so
// the summary's total is exactly "2h15m" whatever day the suite runs on.
const STEPS = [
  { id: "e2e-sm-s1", order: 1, text: "draft the outline", estMinutes: 30 },
  { id: "e2e-sm-s2", order: 2, text: "write it up", estMinutes: 45 },
  { id: "e2e-sm-s3", order: 3, text: "read it back", estMinutes: 60 },
];

let prisma: PrismaClient;

// #118 Phase C — the credential is keyed on the ACTING USER (OWNER_USER_ID here),
// not on a singleton row id. `userId` is the only handle on it: the row's own id is
// a generated cuid, so `where: { id: "singleton" }` no longer matches anything and
// this spec's 📅 silently rendered "Connect Google" instead of "Schedule".
async function removeFixtures(client: PrismaClient): Promise<void> {
  await client.step.deleteMany({ where: { taskId: TASK_ID } });
  await client.brainDumpItem.deleteMany({ where: { id: ITEM_ID } });
  await client.task.deleteMany({ where: { id: TASK_ID } });
  // Back to "configured but not connected" — the state every other spec expects.
  // Scoped to the OWNER, so the member's own credential (seeded by global-setup
  // for the member-google project) is untouched.
  await clearGoogleTokens(client, OWNER_USER_ID);
}

/**
 * Yesterday, as the date field spells it — a deadline that has already passed,
 * so it can never hold the fixture's 2h15m of work.
 *
 * **This used to be today, and today is not a constant.** `deriveWindows` asks
 * `workingMinutesBetween(now, dueAt)` how much working time is left, so whether
 * today can hold 2h15m depends on what time the suite runs: at 23:34 it cannot
 * and the menu warns, at 06:43 the whole working day is still ahead and it does
 * not. `main` was green on the late run and red on the early one, from the same
 * tree — the comment here claimed "whatever time it is" and that was the bug.
 *
 * A deadline in the past has no such hinge: `workingMinutesBetween` returns 0
 * for an inverted range (`hours.ts`, `to > from` guard), so `availableMin` is 0
 * at every hour of every day and `scheduleSummary` takes its "leaves no working
 * time before the deadline — N steps need …" branch. Same warning mood, same
 * amber colour pair, which is what these two tests are actually here to look at.
 */
function passedDeadlineInputValue(): string {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** The seeded row in the Multi-step bucket. */
function multiStepRow(page: Page) {
  return page
    .locator('[data-bucket="multiStep"]')
    .getByRole("listitem")
    .filter({ hasText: MARKER });
}

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  prisma = new PrismaClient();
  try {
    // A previous interrupted run must not leave the fixtures behind.
    await removeFixtures(prisma);
    await prisma.workspace.upsert({
      where: { id: OWNER_WS_ID },
      create: { id: OWNER_WS_ID, kind: "user" },
      update: {},
    });
    await prisma.task.create({
      data: {
        id: TASK_ID,
        title: MARKER,
        status: "active",
        source: "braindump",
        workspaceId: OWNER_WS_ID,
        steps: { create: STEPS.map((s) => ({ ...s, total: STEPS.length })) },
      },
    });
    // Triaged + >1 step ⇒ the Multi-step bucket (see bucketItems), which is the
    // only inbox bucket whose 📅 reaches `ready_steps`.
    await prisma.brainDumpItem.create({
      data: {
        id: ITEM_ID,
        text: MARKER,
        status: "triaged",
        triagedAt: new Date(),
        taskId: TASK_ID,
        workspaceId: OWNER_WS_ID,
      },
    });
    // Encrypted through the shared fixture (!200), which pins TOKEN_ENC_KEY to
    // the key the server under test decrypts with. `connected` is derived from
    // DECRYPTABILITY, not from ciphertext presence, so a token encrypted with any
    // other key reads as "reconnect needed" and every 📅 below falls back to .ics.
    await seedConnectedGoogle(
      prisma,
      OWNER_USER_ID,
      "e2e-not-a-real-google-token",
    );
  } catch (err) {
    // Own the client's lifecycle on the seed path: a throw here means afterAll
    // never runs against a usable client, which would leak the connection.
    await prisma.$disconnect();
    throw err;
  }
});

test.afterAll(async () => {
  try {
    await removeFixtures(prisma);
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
  // Configured AND connected, so the end-cluster control is the Google one.
  // `exact`: the marker is the task title, so "Drag <title>" / "Edit <title>"
  // also contain it — only the 📅 control is named exactly "Schedule".
  const trigger = row.getByRole("button", { name: "Schedule", exact: true });
  await trigger.click();

  // Portaled into the row, so a row-scoped query still finds it (#92's idiom).
  const dialog = row.getByRole("dialog");
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

  // The mechanical WCAG gate, on a real accessibility tree rather than jsdom's
  // approximation of one: a Popover.Popup is a `dialog`, so it must carry an
  // accessible name, and every control in it must be labelled and legible.
  await scanA11y(page, "/ (schedule menu open)");

  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  // Focus comes back to the control that opened it, not to the document.
  await expect(trigger).toBeFocused();
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
  await row.getByRole("button", { name: "Schedule", exact: true }).click();

  const dialog = row.getByRole("dialog");
  await expect(dialog.getByLabel("Priority")).toHaveValue("critical");
  await expect(dialog.getByRole("radio", { name: "Personal" })).toBeChecked();
  await expect(dialog.getByLabel("Done by")).toHaveValue("2026-12-24");
  await page.keyboard.press("Escape");

  // The .ics alternative in the ▾ menu still downloads on one click — no dialog,
  // no second step. A guest has nothing the menu could offer beyond a deadline.
  await row.getByRole("button", { name: "All options" }).click();
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
  await row.getByRole("button", { name: "Schedule", exact: true }).click();
  const dialog = row.getByRole("dialog");
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

// Screenshots for review. Not assertions — a green suite is not the same evidence
// as the owner's own eyes on a new surface, so this captures the open menu in
// both themes at both widths.
// The warning is the menu's one NEW colour pair (`text-amber-700
// dark:text-amber-400`), and it only exists once a deadline cannot hold the work —
// so the resting scan above never sees it. Both themes, zero tolerance, the same
// gate e2e/a11y-contrast.spec.ts applies to the core routes.
test.describe("schedule menu — the feasibility warning's contrast", () => {
  test.use({ contextOptions: { reducedMotion: "reduce" } });

  for (const theme of THEMES) {
    test(`no contrast violations with the warning showing — ${theme}`, async ({
      page,
    }) => {
      await setTheme(page, theme);
      await page.goto("/");
      await waitForShell(page);
      await expectThemeApplied(page, theme);

      const row = multiStepRow(page);
      await row.getByRole("button", { name: "Schedule", exact: true }).click();
      const dialog = row.getByRole("dialog");
      // A deadline that has already passed cannot hold 2h15m of work, at any
      // hour — see passedDeadlineInputValue for why "today" was not that.
      await dialog.getByLabel("Done by").fill(passedDeadlineInputValue());
      await expect(dialog.getByRole("status")).toContainText(/need/i);

      expectNoContrastViolations(await scanColorContrast(page));
    });
  }
});

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
        await row
          .getByRole("button", { name: "Schedule", exact: true })
          .click();
        await expect(row.getByRole("dialog")).toBeVisible();
        await page.screenshot({ path: `${SHOTS}/${size}-${theme}-open.png` });

        // The warning mood, which is the other half of the surface: a deadline
        // already past cannot hold 2h15m of work, and the menu says so without
        // blocking.
        await row
          .getByRole("dialog")
          .getByLabel("Done by")
          .fill(passedDeadlineInputValue());
        await expect(row.getByRole("dialog").getByRole("status")).toContainText(
          /need/i,
        );
        await page.screenshot({
          path: `${SHOTS}/${size}-${theme}-warning.png`,
        });
      });
    }
  }
});
