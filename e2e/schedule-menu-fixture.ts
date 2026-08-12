import { expect, type Page } from "@playwright/test";
import type { PrismaClient } from "@prisma/client";
import { OWNER_WS_ID, OWNER_USER_ID } from "./constants";
import { ROW_MENU_SCHEDULE } from "./helpers";
import { seedConnectedGoogle, clearGoogleTokens } from "./google-credential";

/**
 * The seeded workspace state the Schedule menu needs, shared by the two specs
 * that drive that menu (#247).
 *
 * Extracted rather than duplicated because the two specs live in different
 * Playwright PROJECTS and Playwright refuses to let one spec file import
 * another ("test file … should not import test file …"), so a shared module is
 * the only way for them to agree:
 *
 *   * `e2e/smoke/schedule-menu.spec.ts` (`chromium`, retries inherited) — the
 *     build-level behaviour: the summary sentence, the .ics path, the 390px
 *     layout, the screenshots.
 *   * `e2e/a11y/axe-schedule-menu.spec.ts` (`a11y`, `retries: 0`) — the WCAG
 *     assertions, which used to live in the file above and were retry-masked
 *     there. #222's document-title race hid behind exactly that retry.
 *
 * Both call `seed` in `beforeAll` and `remove` in `afterAll`, so the window in
 * which the owner reads as Google-connected is one spec file at a time. The
 * suite runs serially (`config/playwright.config.ts`: `workers: 1`,
 * `fullyParallel: false`) and the `a11y` project completes before `chromium`
 * starts (`dependencies: ["a11y"]`), so the two windows cannot overlap.
 *
 * Nothing here can reach Google. The token is a dummy string that would not
 * survive decryption, and neither spec ever presses Schedule.
 */

export const MARKER = "e2e-schedule-menu";
export const TASK_ID = "e2e-schedule-menu-task";
export const ITEM_ID = "e2e-schedule-menu-item";

/**
 * 30 + 45 + 60 = 135 working minutes, none of them below the 30-minute floor, so
 * the summary's total is exactly "2h15m" whatever day the suite runs on.
 */
export const STEPS = [
  { id: "e2e-sm-s1", order: 1, text: "draft the outline", estMinutes: 30 },
  { id: "e2e-sm-s2", order: 2, text: "write it up", estMinutes: 45 },
  { id: "e2e-sm-s3", order: 3, text: "read it back", estMinutes: 60 },
];

/**
 * #118 Phase C — the credential is keyed on the ACTING USER (OWNER_USER_ID here),
 * not on a singleton row id. `userId` is the only handle on it: the row's own id is
 * a generated cuid, so `where: { id: "singleton" }` no longer matches anything and
 * this fixture's 📅 silently rendered "Connect Google" instead of "Schedule".
 */
export async function removeScheduleMenuFixture(
  client: PrismaClient,
): Promise<void> {
  await client.step.deleteMany({ where: { taskId: TASK_ID } });
  await client.brainDumpItem.deleteMany({ where: { id: ITEM_ID } });
  await client.task.deleteMany({ where: { id: TASK_ID } });
  // Back to "configured but not connected" — the state every other spec expects.
  // Scoped to the OWNER, so the member's own credential (seeded by global-setup
  // for the member project) is untouched.
  await clearGoogleTokens(client, OWNER_USER_ID);
}

/**
 * The triaged multi-step task, plus a decryptable Google token for the owner.
 *
 * Removes first: a previous interrupted run must not leave the fixtures behind.
 */
export async function seedScheduleMenuFixture(
  client: PrismaClient,
): Promise<void> {
  await removeScheduleMenuFixture(client);
  await client.workspace.upsert({
    where: { id: OWNER_WS_ID },
    create: { id: OWNER_WS_ID, kind: "user" },
    update: {},
  });
  await client.task.create({
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
  await client.brainDumpItem.create({
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
  // other key reads as "reconnect needed" and every 📅 falls back to .ics.
  await seedConnectedGoogle(
    client,
    OWNER_USER_ID,
    "e2e-not-a-real-google-token",
  );
}

/** The seeded row in the Multi-step bucket. */
export function multiStepRow(page: Page) {
  return page
    .locator('[data-bucket="multiStep"]')
    .getByRole("listitem")
    .filter({ hasText: MARKER });
}

/**
 * Open the seeded row's Schedule dialog and wait for it to be readable.
 *
 * `exact` on `ROW_MENU_SCHEDULE`: the marker is the task title, so "Drag <title>" /
 * "Edit <title>" also contain it, and #253 renamed this entry to a string the
 * DIALOG's own "Schedule" submit button is a substring of — so once the dialog is
 * open a loose match resolves to two controls. The dialog is portaled into the row,
 * so a row-scoped query still finds it (#92's idiom).
 *
 * #253 — two presses, not one. The 📅 icon went with the row's trailing icon
 * cluster and Schedule is a ▾-list entry now; the entry opens the SAME #106 dialog,
 * which is the property this fixture and `axe-schedule-menu.spec.ts` exist to
 * check. (That equivalence is not incidental: the `isMenu` branch used to return
 * before the dialog branch, so #253 had to reorder them or delete #106 from every
 * inbox row by accident.)
 */
export async function openScheduleDialog(page: Page) {
  const row = multiStepRow(page);
  await expect(row).toBeVisible();
  await row.getByRole("button", { name: "All options" }).click();
  await row
    .getByRole("button", { name: ROW_MENU_SCHEDULE, exact: true })
    .click();
  // Named, not bare. #253 put the ▾ list in the row and Base UI renders it as a
  // `dialog` too, so `getByRole("dialog")` inside a row now resolves to two
  // elements and fails Playwright's strict mode. Naming it is also the stronger
  // assertion: it pins WHICH dialog opened.
  const dialog = row.getByRole("dialog", { name: `Schedule ${MARKER}` });
  await expect(dialog).toBeVisible();
  return dialog;
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
 * amber colour pair, which is what the contrast scan is actually there to look at.
 */
export function passedDeadlineInputValue(): string {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
