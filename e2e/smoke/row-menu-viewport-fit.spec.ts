import { test, expect, type Locator, type Page } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import {
  MOBILE,
  NARROW,
  ROW_MENU_ADD_TODO,
  settledFocusLabel,
  waitForShell,
} from "../helpers";
import { OWNER_WS_ID, OWNER_USER_ID } from "../constants";
import { seedConnectedGoogle, clearGoogleTokens } from "../google-credential";

// #92 — row-action popups must stay inside the viewport at phone width.
//
// Two independent, reproduced faults, both invisible to every other spec
// because none of them measured a popup's box:
//
//  1. LEFT-EDGE OVERFLOW, UNRECOVERABLE. The 📥 Move-to menu was
//     `absolute right-0 min-w-40`, anchored to its own trigger. At 390 that
//     trigger is the leftmost control of a wide end cluster (which also holds
//     the "Connect Google →" link that #253 has since replaced with a settings
//     entry), so it sat at x≈73 and the 160px menu was
//     laid out from left:-43. `document.scrollWidth === 390`, so there is no
//     horizontal scroll to recover with — the first entry ("Needs review") was
//     permanently unreachable.
//  2. BELOW-FOLD CLIPPING. The 🔽 All-options popup is ~288px tall, so any
//     trigger below ≈y=556 at 390 hung past the bottom edge.
//
// A width/height-aware assertion is the only thing that catches this class, so
// that is what these tests are: open the popup, read its bounding box, and
// require it to be inside the viewport. They are deliberately measurement
// tests, not screenshot tests — a pixel baseline would go stale on every
// unrelated style change and would not say *why* it failed.
//
// Every test here pins its own seeded row by text and polls coordinates rather
// than reading them once. Both matter: the suite shares one workspace, so a
// `.first()` row belongs to whichever spec ran last, and the inbox re-sorts as
// items age, so a node can detach between "is it visible?" and "where is it?".
//
// Non-regression, asserted below and easy to lose: opening a row popup must NOT
// lock page scroll, and scrolling must NOT dismiss it. That is what made fault
// 2 merely wrong rather than unrecoverable, and Base UI's `modal` default
// (true, on Menu) would have taken it away.

const SEED_MARKER = "menu-fit-92";

/** Enough rows that the phone viewport scrolls — fault 2 needs a trigger that
 *  can be parked near the bottom edge, which needs a page taller than 844. */
const SEED_COUNT = 10;

async function seedRows(marker: string): Promise<PrismaClient> {
  const prisma = new PrismaClient();
  try {
    await prisma.workspace.upsert({
      where: { id: OWNER_WS_ID },
      create: { id: OWNER_WS_ID, kind: "user" },
      update: {},
    });
    await prisma.brainDumpItem.createMany({
      data: Array.from({ length: SEED_COUNT }, (_, i) => ({
        text: `${marker} ${i}`,
        // triaged + no task → the Single-task bucket, whose rows carry the full
        // end cluster (📥 move / 📅 schedule / 🗑 delete / 🔽 all options).
        status: "triaged",
        estMinutes: 10,
        workspaceId: OWNER_WS_ID,
      })),
    });
  } catch (err) {
    await prisma.$disconnect();
    throw err;
  }
  return prisma;
}

/**
 * The same rows, COMPLETED — the Done bucket, whose action line is hand-rolled and
 * carries the inline 📥 (`MoveToMenu`) rather than a ▾ list.
 *
 * #253 is why this exists. The nested-`Menu` specs below used to reach `MoveToMenu`
 * through a "Move to…" entry in a row's ▾; that entry is gone, because the ▾ now
 * names its destinations as ordinary entries and a submenu offering the same buckets
 * was a second route one tap deeper. `MoveToMenu` itself still ships, on this bucket
 * and on the idle Saved row — so the nested-popup properties #92 exists for are still
 * live behaviour and are still asserted, just from the trigger that still opens it.
 *
 * That returns those specs to #92's ORIGINAL fault, which was this exact
 * composition: an inline 📥 sitting far from the right edge, laying its 160px menu
 * out from a negative left offset with no horizontal scroll to recover with.
 */
async function seedDoneRows(marker: string): Promise<PrismaClient> {
  const prisma = new PrismaClient();
  try {
    await prisma.workspace.upsert({
      where: { id: OWNER_WS_ID },
      create: { id: OWNER_WS_ID, kind: "user" },
      update: {},
    });
    await prisma.brainDumpItem.createMany({
      data: Array.from({ length: SEED_COUNT }, (_, i) => ({
        text: `${marker} ${i}`,
        status: "triaged",
        estMinutes: 10,
        completedAt: new Date(),
        workspaceId: OWNER_WS_ID,
      })),
    });
  } catch (err) {
    await prisma.$disconnect();
    throw err;
  }
  return prisma;
}

async function cleanupSeed(prisma: PrismaClient, marker: string) {
  try {
    await prisma.brainDumpItem.deleteMany({
      where: { workspaceId: OWNER_WS_ID, text: { startsWith: marker } },
    });
  } finally {
    await prisma.$disconnect();
  }
}

type Box = {
  left: number;
  right: number;
  top: number;
  bottom: number;
  offLeft: number;
  offRight: number;
  offTop: number;
  offBottom: number;
  vw: number;
  vh: number;
  /** The popup's own first focusable entry — the one fault 1 cut off. */
  firstEntryInside: boolean | null;
};

/** Measure a popup against the visual viewport, the way a thumb experiences it. */
async function measure(popup: Locator): Promise<Box> {
  return popup.evaluate((node: HTMLElement) => {
    const b = node.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const first = node.querySelector<HTMLElement>(
      'button, a, [role="menuitem"]',
    );
    const fb = first?.getBoundingClientRect();
    return {
      left: Math.round(b.left),
      right: Math.round(b.right),
      top: Math.round(b.top),
      bottom: Math.round(b.bottom),
      offLeft: Math.max(0, Math.round(-b.left)),
      offRight: Math.max(0, Math.round(b.right - vw)),
      offTop: Math.max(0, Math.round(-b.top)),
      offBottom: Math.max(0, Math.round(b.bottom - vh)),
      vw,
      vh,
      firstEntryInside: fb
        ? fb.left >= 0 && fb.right <= vw && fb.top >= 0 && fb.bottom <= vh
        : null,
    };
  });
}

function expectInsideViewport(box: Box, what: string) {
  expect(box.offLeft, `${what}: px off the LEFT edge`).toBe(0);
  expect(box.offRight, `${what}: px off the RIGHT edge`).toBe(0);
  expect(box.offTop, `${what}: px off the TOP edge`).toBe(0);
  expect(box.offBottom, `${what}: px off the BOTTOM edge`).toBe(0);
  expect(box.firstEntryInside, `${what}: first entry fully on screen`).toBe(
    true,
  );
}

/** One seeded row, addressed by its own text. Deliberately not `.first()`: the
 *  suite shares one workspace, so "the first 📥 on the page" is whatever an
 *  earlier spec happened to leave behind — a row that may be mid-re-sort (the
 *  inbox re-sorts as items age), which is how a `.first()` version of this spec
 *  produced a null bounding box in CI while passing locally. */
function seededRow(page: Page, marker: string, index: number): Locator {
  return page
    .locator('[data-bucket="singleTask"]')
    .getByRole("listitem")
    .filter({ hasText: `${marker} ${index}` });
}

/** The same lookup in the Done bucket — see {@link seedDoneRows}. */
function seededDoneRow(page: Page, marker: string, index: number): Locator {
  return page
    .locator('[data-bucket="completed"]')
    .getByRole("listitem")
    .filter({ hasText: `${marker} ${index}` });
}

/** A locator's on-screen x/y, polled: an inbox re-render between "is it
 *  visible?" and "where is it?" detaches the node and `boundingBox()` returns
 *  null, so read it as a retrying assertion rather than a one-shot `!`. */
function triggerCoord(el: Locator, axis: "x" | "y") {
  return expect.poll(async () => (await el.boundingBox())?.[axis] ?? null);
}

/** Scroll so `el` sits `fromBottom` px above the viewport bottom — the position
 *  a real user's last row occupies when they reach for its menu. */
async function parkNearBottom(page: Page, el: Locator, fromBottom = 60) {
  const vh = page.viewportSize()!.height;
  for (let i = 0; i < 8; i++) {
    const b = await el.boundingBox();
    // null = detached mid-re-render; retry rather than give up, or the caller's
    // "is it really near the bottom?" precondition silently stops holding.
    if (!b) {
      await page.waitForTimeout(120);
      continue;
    }
    const delta = b.y - (vh - fromBottom);
    if (Math.abs(delta) < 8) return;
    await page.evaluate((d) => window.scrollBy(0, d), delta);
    await page.waitForTimeout(120);
  }
}

test.describe("#92 row-action popups fit the phone viewport", () => {
  test.use({ viewport: MOBILE });

  // Light mode only, on purpose. What these tests measure is geometry — a
  // bounding box against the viewport — and the popup box is identical in both
  // themes (same border, padding and min-width; only the palette differs), so a
  // dark re-run would re-measure the same numbers. It would also inherit #98, a
  // pre-existing intermittent hydration mismatch that strips the pre-hydration
  // `dark` class, which made an earlier theme-swept version of this spec fail
  // ~1 run in 10 for a reason that has nothing to do with popup positioning.
  // Dark mode at 390 is covered for appearance by e2e/a11y-contrast.spec.ts.
  // #253 — fault 1's original repro is gone with the compact 📥 it was about, but
  // the menu it opened is not: it is now reached from inside the 🔽 popup, one
  // floating element anchored to another. That is a HARDER case than the original,
  // not an easier one, so the measurement is kept and re-pointed rather than
  // deleted. The left-edge precondition goes with the cluster — the trigger is a
  // full-width entry in the popup now, so "is it near the left edge?" no longer
  // describes anything.
  // #253 — driven from the Done bucket's INLINE 📥, which is where `MoveToMenu` still
  // lives (see `seedDoneRows`). This is #92's original composition and its original
  // fault: a 📥 far from the right edge laying a 160px menu out from a negative left
  // offset with no horizontal scroll to recover with.
  //
  // The `RowActions` half of the pair is asserted too, in the opposite direction: a
  // single-task row must carry NEITHER an inline 📥 nor a nested "Move to…" entry,
  // because its ▾ names the destinations directly now. Both absences in one place, so
  // a rebase that restores either fails here.
  test("the Move-to menu opened from a row's 📥 stays inside the viewport", async ({
    page,
  }) => {
    const marker = `${SEED_MARKER} move`;
    const prisma = await seedDoneRows(marker);
    const rowsMarker = `${SEED_MARKER} moverow`;
    const rowsPrisma = await seedRows(rowsMarker);
    try {
      await page.goto("/");
      await waitForShell(page);

      // Neither shape of Move-to survives on a `RowActions` row.
      const listRow = seededRow(page, rowsMarker, 0);
      await expect(listRow).toBeVisible();
      await expect(
        listRow.getByRole("button", { name: "Move to", exact: true }),
      ).toHaveCount(0);
      await listRow.getByRole("button", { name: "All options" }).click();
      await expect(
        page.getByRole("button", { name: "Move to…" }),
        "the nested Move-to picker is back in a ▾ list",
      ).toHaveCount(0);
      await page.keyboard.press("Escape");

      const row = seededDoneRow(page, marker, 0);
      await expect(row).toBeVisible();
      const trigger = row.getByRole("button", { name: "Move to", exact: true });
      await expect(trigger).toBeVisible();
      await trigger.click();
      const menu = page.getByRole("menu").filter({ visible: true }).first();
      await expect(menu).toBeVisible();
      expectInsideViewport(await measure(menu), "Move-to menu from a row 📥");
    } finally {
      await cleanupSeed(rowsPrisma, rowsMarker);
      await cleanupSeed(prisma, marker);
    }
  });

  test("the 🔽 All-options popup opened near the bottom edge stays inside the viewport", async ({
    page,
  }) => {
    const marker = `${SEED_MARKER} overflow`;
    const prisma = await seedRows(marker);
    try {
      await page.goto("/");
      await waitForShell(page);

      // The last seeded row: low on the page to begin with, then parked right
      // against the bottom edge.
      const trigger = seededRow(page, marker, SEED_COUNT - 1).getByRole(
        "button",
        { name: "All options" },
      );
      await expect(trigger).toBeVisible();
      await parkNearBottom(page, trigger);

      // Guard the repro precondition: an unflipped 288px popup from here
      // could not possibly fit, so a pass means collision handling ran.
      await triggerCoord(trigger, "y").toBeGreaterThan(MOBILE.height * 0.6);

      await trigger.click();
      const popup = page
        .getByRole("dialog", { name: "All options" })
        .filter({ visible: true })
        .first();
      await expect(popup).toBeVisible();
      expectInsideViewport(await measure(popup), "🔽 All-options popup");
    } finally {
      await cleanupSeed(prisma, marker);
    }
  });

  test("opening a row popup neither locks page scroll nor is dismissed by it", async ({
    page,
  }) => {
    const marker = `${SEED_MARKER} scroll`;
    const prisma = await seedDoneRows(marker);
    try {
      await page.goto("/");
      await waitForShell(page);

      // #253 — from the Done bucket's inline 📥, the trigger `MoveToMenu` still has.
      // The property under test is unchanged: a row popup must not lock document
      // scroll, and a scroll must not dismiss it.
      const row = seededDoneRow(page, marker, 0);
      await expect(row).toBeVisible();
      await row.getByRole("button", { name: "Move to", exact: true }).click();
      const menu = page.getByRole("menu").filter({ visible: true }).first();
      await expect(menu).toBeVisible();

      // The page must still scroll — Base UI's Menu `modal` default (true) locks
      // document scroll, which would strand a user whose popup is only partly
      // reachable and generally make the page feel broken.
      //
      // ⚠️ UPWARDS, and the direction is not arbitrary. #253 moved this spec onto the
      // Done bucket's inline 📥, which is where `MoveToMenu` still lives — and Done is
      // the LAST section on the board, so a row in it sits at or near maximum scroll
      // and `scrollBy(0, 200)` is a no-op for want of anywhere to go. That would fail
      // for the wrong reason: "the page did not move" read as "scroll is locked".
      // Scrolling back up exercises the same lock with room to prove it.
      const before = await page.evaluate(() => window.scrollY);
      expect(
        before,
        "precondition: the page is scrolled down, so there is room to scroll up",
      ).toBeGreaterThan(0);
      await page.evaluate(() => window.scrollBy(0, -200));
      await page.waitForTimeout(150);
      const after = await page.evaluate(() => window.scrollY);
      expect(
        after,
        "page still scrolls while a row popup is open",
      ).toBeLessThan(before);

      // And scrolling must not dismiss it (pre-#92 behaviour, worth keeping).
      await expect(menu).toBeVisible();
      // Still fully on screen after the scroll: the popup tracks its anchor.
      expectInsideViewport(
        await measure(menu),
        "Move-to menu after a page scroll",
      );
    } finally {
      await cleanupSeed(prisma, marker);
    }
  });

  // #253 — the Done bucket's 📥. Its menu is still portaled into the component's own
  // wrapper, so the press-inside-a-portal property this spec was written for is still
  // the thing under test; what changed is that the enclosing layer is the row rather
  // than a ▾ popup.
  test("the Move-to menu opened from a row's 📥 still dispatches a move", async ({
    page,
  }) => {
    const marker = `${SEED_MARKER} nested`;
    const prisma = await seedDoneRows(marker);
    try {
      await page.goto("/");
      await waitForShell(page);

      const row = seededDoneRow(page, marker, 0);
      await expect(row).toBeVisible();
      await row.getByRole("button", { name: "Move to", exact: true }).click();
      const nested = page.getByRole("menu").filter({ visible: true }).first();
      await expect(nested).toBeVisible();
      expectInsideViewport(await measure(nested), "Move-to menu from a row 📥");
      await nested.getByRole("menuitem", { name: /Multi-step/ }).click();

      await expect(
        page
          .locator('[data-bucket="multiStep"]')
          .getByRole("listitem")
          .filter({ hasText: `${marker} 0` }),
      ).toBeVisible();
    } finally {
      await cleanupSeed(prisma, marker);
    }
  });
});

// The duration presets shared the exact shape of the two popups above
// (`absolute right-0` on their own trigger) while they lived in the 📅 icon's
// popover. **#253 deleted that surface from every row**: the row's only Schedule
// affordance is the `menu` variant, which expands its presets in normal flow
// inside the ▾ popup, so there is no second floating element left to clip. The
// icon variant survives only in the task working view
// (`breakdown/task-schedule.tsx`), off this file's route.
//
// The fault class did not vanish with it, it MOVED: the ▾ popup now GROWS in
// place when the presets expand, and it does so from a row that may already be
// parked against the bottom edge — which is fault 2 arriving from the inside
// rather than fault 1. So the measurement is kept and re-aimed at the popup,
// after expanding it, instead of being deleted along with the element it used to
// find.
//
// For a SIGNED-IN account Schedule only appears with Google CONNECTED, and no spec
// in this file seeds a credential — the two that want one (schedule-menu.spec.ts
// here, member-google.spec.ts in the other project) seed it per file and hand it
// back. But a GUEST's primary control is the .ics one in its `needs_duration`
// form, so the same presets are reachable with no cookies at all. (!200: this used
// to say the server boots with no GOOGLE_CLIENT_ID — it does not; `bootGuardEnv`
// has set one since #106.)
test.describe("#92/#253 the expanded duration presets fit the phone viewport", () => {
  test.use({ viewport: MOBILE, storageState: { cookies: [], origins: [] } });

  test("opened near the bottom edge it stays inside the viewport", async ({
    page,
  }) => {
    await page.goto("/");
    await waitForShell(page);

    const capture = page.getByPlaceholder(
      "Brain dump anything… (Enter to save)",
    );
    for (let i = 0; i < 6; i++) {
      await capture.fill(`${SEED_MARKER} ics ${i}`);
      await capture.press("Enter");
      await expect(
        page
          .getByRole("listitem")
          .filter({ hasText: `${SEED_MARKER} ics ${i}` }),
      ).toBeVisible();
    }

    const row = page
      .getByRole("listitem")
      .filter({ hasText: `${SEED_MARKER} ics 0` });
    const overflow = row.getByRole("button", { name: "All options" });
    await expect(overflow).toBeVisible();
    // The precondition fault 2 needs: the trigger is parked low, so a popup that
    // grows downward from here cannot fit without collision handling.
    await parkNearBottom(page, overflow);
    await triggerCoord(overflow, "y").toBeGreaterThan(MOBILE.height * 0.6);
    await overflow.click();

    const popup = page
      .getByRole("dialog", { name: "All options" })
      .filter({ visible: true })
      .first();
    await expect(popup).toBeVisible();
    const collapsed = (await popup.boundingBox())!.height;

    // Expanding the presets is the growth this now guards. A guest to-do with no
    // steps gets the duration form rather than an immediate download.
    await popup.getByRole("button", { name: "Add to calendar (.ics)" }).click();
    await expect(popup.getByRole("button", { name: "30 min" })).toBeVisible();

    // Guard the precondition: it really did grow, or "it still fits" is a
    // measurement of the collapsed list wearing the expanded list's name.
    const expanded = (await popup.boundingBox())!.height;
    expect(
      expanded,
      `popup did not grow when the presets expanded (${collapsed}px → ${expanded}px)`,
    ).toBeGreaterThan(collapsed);

    // Polled, not read once, and this is the finding the re-aim produced. Base UI
    // DOES re-position on a content resize — `useAnchorPositioning` passes
    // floating-ui `autoUpdate` `elementResize: true` — but it runs from a
    // ResizeObserver callback a frame after the presets mount. A one-shot read
    // therefore races the reflow it is measuring and reported this popup 14px off
    // the right edge and 88px off the bottom while the settled layout was clean.
    // Same reason `triggerCoord` above is a poll.
    //
    // Worth stating because the first fix written for those numbers was a
    // `max-w-40` + `flex-wrap` cap in `row-actions.tsx`; with the poll in place
    // this spec passes without it, so the cap was removed rather than shipped with
    // a comment claiming it fixed an overflow it never fixed.
    //
    // The final `expectInsideViewport` still runs, for its per-edge message.
    await expect
      .poll(
        async () => {
          const b = await measure(popup);
          return b.offLeft + b.offRight + b.offTop + b.offBottom;
        },
        { message: "the expanded ▾ list never came back inside the viewport" },
      )
      .toBe(0);
    expectInsideViewport(await measure(popup), "▾ list with presets expanded");
  });

  // The same presets, on the way OUT. Collapsing them is a focus hand-off inside
  // the ▾ list, and it belongs to the class described on the sibling test
  // "dismissing the nested Move-to menu hands focus back to the entry" — the
  // pressed preset unmounts, and the enclosing popover claims the loose focus for
  // its own container unless the control that opened the presets takes it first.
  //
  // This route is the one with no popup of its own, so it is easy to miss: the
  // presets are ordinary flow content, and nothing about them looks like a
  // dismissal. Reached by pressing ▾ on a stepless to-do, then Add to calendar
  // (.ics), then a duration — which is a guest's ONLY way to schedule anything.
  test("collapsing the presets hands focus back to the entry that opened them", async ({
    page,
  }) => {
    await page.goto("/");
    await waitForShell(page);

    const capture = page.getByPlaceholder(
      "Brain dump anything… (Enter to save)",
    );
    await capture.fill(`${SEED_MARKER} focus`);
    await capture.press("Enter");
    const row = page
      .getByRole("listitem")
      .filter({ hasText: `${SEED_MARKER} focus` });
    await expect(row).toBeVisible();

    await row.getByRole("button", { name: "All options" }).click();
    const popup = page
      .getByRole("dialog", { name: "All options" })
      .filter({ visible: true })
      .first();
    await expect(popup).toBeVisible();

    const entry = popup.getByRole("button", {
      name: "Add to calendar (.ics)",
      exact: true,
    });
    await entry.click();
    const preset = popup.getByRole("button", { name: "30 min" });
    await expect(preset).toBeVisible();
    await preset.click();
    await expect(preset).toBeHidden();

    // The list stays open (the presets are its content, not a layer over it), so
    // the entry is still there to receive focus.
    await expect(popup).toBeVisible();
    expect(
      await settledFocusLabel(page),
      "focus after picking a duration in the ▾ list",
    ).toBe("Add to calendar (.ics)");
  });
});

// ── #44 — the action group grew a third inline button at phone width ────────
//
// The note's collapsed trigger moved INTO the row's action group beside
// Complete (owner request). That group already held two buttons and four icon
// controls, and 390 is the width every layout fault in this project has shown
// up at — so the question is not whether it wraps (it may, by design: the end
// cluster is `ml-auto` + `flex-nowrap` + `shrink-0` precisely so it wraps as
// ONE unit) but whether anything ends up off-screen or squeezed under its
// touch target.
//
// Measured, not eyeballed, for the same reason the rest of this file is.
test.describe("#44 the note trigger fits the phone viewport", () => {
  test.use({ viewport: MOBILE });

  const NOTE_MARKER = "note-fit-44";

  test("every control in a note-bearing row's action group stays on screen", async ({
    page,
  }) => {
    const prisma = new PrismaClient();
    try {
      await prisma.workspace.upsert({
        where: { id: OWNER_WS_ID },
        create: { id: OWNER_WS_ID, kind: "user" },
        update: {},
      });
      // A row with a TASK behind it — that is what shows the note trigger. A
      // task with no steps lands in the Single-task bucket, whose rows carry
      // the full end cluster, so this is the densest action group in the app.
      const task = await prisma.task.create({
        data: { title: `${NOTE_MARKER} row`, workspaceId: OWNER_WS_ID },
      });
      await prisma.brainDumpItem.create({
        data: {
          text: `${NOTE_MARKER} row`,
          status: "triaged",
          triagedAt: new Date(),
          estMinutes: 10,
          workspaceId: OWNER_WS_ID,
          taskId: task.id,
        },
      });

      await page.goto("/");
      await waitForShell(page);

      const row = page
        .getByRole("listitem")
        .filter({ hasText: `${NOTE_MARKER} row` })
        .first();
      await expect(row).toBeVisible();

      const trigger = row.getByRole("button", {
        name: `Note for ${NOTE_MARKER} row`,
      });
      await expect(trigger).toBeVisible();

      // NOTHING in the group may sit outside the viewport — that is the whole
      // question a third inline button raises at 390.
      const group = row.locator("[data-row-actions]").first();
      const controls = await group.getByRole("button").all();
      // #253 — exactly ▶ Start Focus + Complete + the note trigger + ▾. This is a
      // SINGLE-TASK row, which has always carried three inline actions rather than
      // the four a Needs-review row shows (no Save, no Add to-do); what changed is
      // that the group no longer also holds 📥 / 📅 / 🗑. Was
      // `toBeGreaterThan(4)`, which passed on seven; an exact count is the stronger
      // assertion now that the number is agreed, and a re-added inline control fails
      // here rather than quietly making the row taller again.
      expect(
        controls.length,
        "▶ Start Focus + Complete + note trigger + ▾",
      ).toBe(4);
      for (const control of controls) {
        const box = await control.evaluate((n: HTMLElement) => {
          const b = n.getBoundingClientRect();
          return {
            left: b.left,
            right: b.right,
            vw: window.innerWidth,
            label: n.getAttribute("aria-label") ?? n.textContent?.trim() ?? "",
          };
        });
        expect(
          box.left,
          `"${box.label}" off the LEFT edge`,
        ).toBeGreaterThanOrEqual(0);
        expect(
          box.right,
          `"${box.label}" off the RIGHT edge`,
        ).toBeLessThanOrEqual(box.vw);
      }

      // EVERY control in the group is a 44x44 target, measured in real layout.
      //
      // This was scoped to the note trigger alone until #184, with a comment
      // saying a blanket assertion had been tried and failed on "▶ Start Focus"
      // at 24px — "a real pre-existing gap across every row in the app, filed
      // rather than fixed here". #184 fixed it, so that comment had become a
      // description of the previous release, and the narrow assertion was
      // guarding one control out of six. Widened rather than reworded.
      //
      // The citation it carried was also wrong and is not repeated: 44x44 is
      // **2.5.5 Target Size (Enhanced), AAA**. **2.5.8 (Minimum) is the AA one
      // and asks for 24x24**, which these controls already met. The app exceeds
      // its own AA bar here deliberately — a house convention (`touchTarget` in
      // `@/lib/utils`), not a conformance requirement.
      //
      // The unit spec in `inbox-view.test.tsx` asserts the CLASSES, because
      // jsdom computes no layout. This is the half that can see pixels, and it
      // is the one that matters for a filled pill whose painted box grows with
      // the target.
      for (const control of controls) {
        const size = await control.evaluate((n: HTMLElement) => {
          const b = n.getBoundingClientRect();
          return {
            h: b.height,
            w: b.width,
            label: n.getAttribute("aria-label") ?? n.textContent?.trim() ?? "",
          };
        });
        expect(
          size.h,
          `"${size.label}" is ${size.h}px tall`,
        ).toBeGreaterThanOrEqual(44);
        expect(
          size.w,
          `"${size.label}" is ${size.w}px wide`,
        ).toBeGreaterThanOrEqual(44);
      }

      // And the page itself must not have gained horizontal scroll.
      const scrollWidth = await page.evaluate(
        () => document.documentElement.scrollWidth,
      );
      expect(scrollWidth).toBeLessThanOrEqual(MOBILE.width);

      // Expanding opens the editor BELOW the action line, inside the same row —
      // the association the trigger's old placement was buying.
      await trigger.click();
      const box = row.getByRole("textbox", {
        name: `Note for ${NOTE_MARKER} row`,
      });
      await expect(box).toBeVisible();
      const below = await box.evaluate((n: HTMLElement) => {
        const group = n.closest("li")?.querySelector("[data-row-actions]");
        // Narrow rather than cast. `querySelector` is genuinely nullable, and a
        // cast would turn a layout change into `getBoundingClientRect` of null
        // — an opaque TypeError from inside evaluate(). Returning false instead
        // would be worse still: the assertion below would then fail with "the
        // editor opens below the action line", confidently blaming the editor's
        // position for a group that is not there at all.
        if (!group) {
          throw new Error(
            "no [data-row-actions] in the note row — the row layout changed, so " +
              "this check is measuring against an element that no longer exists",
          );
        }
        // No cast: getBoundingClientRect is defined on Element, not just
        // HTMLElement, so narrowing is all this ever needed.
        return (
          n.getBoundingClientRect().top >= group.getBoundingClientRect().top
        );
      });
      expect(below, "the editor opens below the action line").toBe(true);
    } finally {
      await prisma.brainDumpItem.deleteMany({
        where: { workspaceId: OWNER_WS_ID, text: { startsWith: NOTE_MARKER } },
      });
      await prisma.task.deleteMany({
        where: { workspaceId: OWNER_WS_ID, title: { startsWith: NOTE_MARKER } },
      });
      await prisma.$disconnect();
    }
  });
});

// ── #253 — the action line is COMPACT at 360px ───────────────────────────────
//
// The issue is a height complaint, raised from a phone screenshot: one
// Needs-review row occupied roughly seven stacked bands, and two of them were the
// action line — the inline buttons wrapped onto a second row of text, and the
// trailing 📥 / 📅 / 🗑 cluster took a third band of its own because it is
// `ml-auto shrink-0` and cannot be squeezed.
//
// Everything above measures popups against the viewport. Nothing measured the
// resting ROW, which is why "the bar is too tall" was a thing somebody had to
// remember rather than something CI could see. This is that half.
//
// ── Why lines and not pixels ─────────────────────────────────────────────────
//
// A pixel cap on the row would go stale on any unrelated type or spacing change
// and would not say why it failed. What the complaint is actually about is how
// many BANDS of controls the line wraps into, so that is what is counted: the
// distinct vertical positions the group's own controls occupy. The number is read
// out of the live layout rather than hard-coded, so the assertion stays true
// through a font change and false the moment a fourth control is put back.
//
// Measured on this branch at 360×780: the group's controls sit at **2** distinct
// tops (Break into steps · Save · Complete, then Note · ▾), against **3** before
// (two text bands plus the icon cluster). The cap is 2.
//
// 360 rather than `MOBILE` (390) for the reason `NARROW` was added in #252: a bar
// that fits at 390 tells you nothing about 360, and 30px is most of one gap.
test.describe("#253 the row action line is compact at 360px", () => {
  test.use({ viewport: NARROW });

  const COMPACT_MARKER = "compact-253";

  /** The tallest control in the group, from the live layout — the unit a "band"
   *  is measured in, so nothing here depends on a font metric. */
  const BANDS = async (group: Locator) =>
    group.evaluate((node: HTMLElement) => {
      const controls = Array.from(
        node.querySelectorAll<HTMLElement>(
          ":scope > button, :scope > * > button",
        ),
      ).filter((c) => c.offsetParent !== null);
      const tops = new Set(
        controls.map((c) => Math.round(c.getBoundingClientRect().top)),
      );
      return {
        count: controls.length,
        bands: tops.size,
        groupHeight: Math.round(node.getBoundingClientRect().height),
        tallest: Math.max(
          ...controls.map((c) => Math.round(c.getBoundingClientRect().height)),
        ),
        labels: controls.map(
          (c) => c.getAttribute("aria-label") ?? c.textContent?.trim() ?? "",
        ),
      };
    });

  test("a Needs-review row's controls wrap into at most two bands, still 44px, no horizontal scroll", async ({
    page,
  }) => {
    const prisma = new PrismaClient();
    try {
      await prisma.workspace.upsert({
        where: { id: OWNER_WS_ID },
        create: { id: OWNER_WS_ID, kind: "user" },
        update: {},
      });
      // Untriaged: the Needs-review bucket, whose row is the one in the owner's
      // screenshot and the widest action line in the app (main CTA + Save +
      // Complete + Note + ▾).
      await prisma.brainDumpItem.create({
        data: {
          text: `${COMPACT_MARKER} row`,
          status: "inbox",
          workspaceId: OWNER_WS_ID,
        },
      });

      await page.goto("/");
      await waitForShell(page);

      const row = page
        .getByRole("listitem")
        .filter({ hasText: `${COMPACT_MARKER} row` })
        .first();
      await expect(row).toBeVisible();
      const group = row.locator("[data-row-actions]").first();
      await expect(group).toBeVisible();

      const m = await BANDS(group);

      // The precondition, so a pass cannot come from measuring an empty group or
      // a row that never rendered its actions.
      expect(m.count, `controls found: ${m.labels.join(" · ")}`).toBe(5);

      // THE assertion. Three bands is the state the issue was raised about.
      expect(
        m.bands,
        `the action line wraps into ${m.bands} bands: ${m.labels.join(" · ")}`,
      ).toBeLessThanOrEqual(2);

      // …and stated as height too, in the same self-calibrating terms: two bands
      // of 44px controls plus one 8px `gap-2` is the whole line. Belt and braces
      // against a control that is short but positioned on a third row by some
      // other mechanism than `flex-wrap`.
      expect(
        m.groupHeight,
        `group is ${m.groupHeight}px tall (tallest control ${m.tallest}px)`,
      ).toBeLessThanOrEqual(2 * m.tallest + 8);

      // 44px survives the narrower viewport — this is a height fix, not a
      // licence to shrink targets (#253's Bar, WCAG 2.5.5).
      for (const control of await group.getByRole("button").all()) {
        const size = await control.evaluate((n: HTMLElement) => {
          const b = n.getBoundingClientRect();
          return {
            h: b.height,
            w: b.width,
            label: n.getAttribute("aria-label") ?? n.textContent?.trim() ?? "",
          };
        });
        expect(
          size.h,
          `"${size.label}" is ${size.h}px tall at ${NARROW.width}`,
        ).toBeGreaterThanOrEqual(44);
        expect(
          size.w,
          `"${size.label}" is ${size.w}px wide at ${NARROW.width}`,
        ).toBeGreaterThanOrEqual(44);
      }

      // Nothing gained horizontal scroll on the way to fitting vertically.
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth),
      ).toBeLessThanOrEqual(NARROW.width);
    } finally {
      await prisma.brainDumpItem.deleteMany({
        where: {
          workspaceId: OWNER_WS_ID,
          text: { startsWith: COMPACT_MARKER },
        },
      });
      await prisma.$disconnect();
    }
  });

  // The other half of the trade: everything the cluster carried has to be
  // reachable from the ▾ list, at 44px, at this width. A compact row that hides
  // an action is not a fix.
  test("every action the cluster carried is in the ▾ list, at 44px, and the popup fits", async ({
    page,
  }) => {
    const prisma = new PrismaClient();
    try {
      await prisma.workspace.upsert({
        where: { id: OWNER_WS_ID },
        create: { id: OWNER_WS_ID, kind: "user" },
        update: {},
      });
      await prisma.brainDumpItem.create({
        data: {
          text: `${COMPACT_MARKER} menu`,
          status: "inbox",
          workspaceId: OWNER_WS_ID,
        },
      });

      await page.goto("/");
      await waitForShell(page);

      const row = page
        .getByRole("listitem")
        .filter({ hasText: `${COMPACT_MARKER} menu` })
        .first();
      await expect(row).toBeVisible();
      await row.getByRole("button", { name: "All options" }).click();

      const popup = page
        .getByRole("dialog", { name: "All options" })
        .filter({ visible: true })
        .first();
      await expect(popup).toBeVisible();

      // Move to and Delete were icons in the deleted cluster; Add to-do was an
      // inline button. Schedule is absent here because this seed has no Google
      // credential, so the calendar group collapses to the single .ics entry —
      // the Google label is covered at 390 by e2e/smoke/schedule-ics.spec.ts.
      //
      // #253 — the move route is `Save for later` rather than a nested "Move to…"
      // picker: the ▾ names its destinations directly now, and this one is a bucket
      // move dispatched through the same `moveItemToBucket` the picker used.
      for (const name of [ROW_MENU_ADD_TODO, "Save for later", "Delete"]) {
        await expect(
          popup.getByRole("button", { name }),
          `"${name}" is not in the ▾ list`,
        ).toBeVisible();
      }

      // `button, a`, not `getByRole("button")`: two `rowMenuEntry` entries render
      // as `<a>` (the Schedule slot is a `<Link>` when Google is not connected),
      // and a role-keyed query left them unmeasured — so the entries most likely
      // to be long were the ones this loop could not see.
      for (const entry of await popup.locator("button, a").all()) {
        const h = await entry.evaluate(
          (n: HTMLElement) => n.getBoundingClientRect().height,
        );
        const label = (await entry.textContent())?.trim() ?? "";
        expect(h, `▾ entry "${label}" is ${h}px tall`).toBeGreaterThanOrEqual(
          44,
        );
      }

      // The list got taller when its entries reached 44px, so it has to be
      // re-measured against the shorter viewport — a compact row that pushes its
      // own menu off the screen would be a straight trade of one height bug for
      // another.
      expectInsideViewport(await measure(popup), "▾ list at 360px");
    } finally {
      await prisma.brainDumpItem.deleteMany({
        where: {
          workspaceId: OWNER_WS_ID,
          text: { startsWith: COMPACT_MARKER },
        },
      });
      await prisma.$disconnect();
    }
  });

  // ── The LAYERED dismissal (WCAG 2.4.3) ─────────────────────────────────────
  //
  // #253's first shape left two ▾ entries that opened a second floating layer of
  // their own — a nested "Move to…" `Menu` and Schedule's #106 dialog — and
  // dismissing that inner layer stranded focus. Base UI's `Popover.Popup` mounts its
  // focus manager with `restoreFocus: "popup"` (row-actions.tsx renders the ▾ list as
  // one), and that handler fires when a descendant loses focus while
  // `document.activeElement` has fallen back to `<body>` — exactly the state an inner
  // popup's own async restoration passes through as it unmounts. It then focuses the
  // popup CONTAINER and re-focuses it a frame later, so it wins the race: focus ended
  // on a `tabindex="-1"` span, on no control at all, with the user's place in the list
  // lost. Fixed in the inner layers, by `restoreFocusToTrigger`
  // (src/components/ui/anchored-popup.ts) handing focus back synchronously.
  //
  // ⚠️ #253 then removed the nested "Move to…" entry altogether — the ▾ names its
  // destinations directly, so a submenu offering the same buckets was a second route
  // one tap deeper. There is no nested layer left inside a ▾ list, which retires the
  // composition this test drove.
  //
  // Re-pointed rather than deleted, because `MoveToMenu` still ships and its focus
  // hand-off is still the fix under test: the Done bucket's inline 📥 opens it, and
  // Escape must land focus back on that trigger rather than on `<body>`. The enclosing
  // layer is the row instead of a ▾ popup; the property is the same one. The other
  // inner layer of the original pair — Schedule's dialog inside a ▾ — is still
  // asserted, by e2e/smoke/schedule-menu.spec.ts. The unit test in
  // move-to-menu.test.tsx cannot see this: it renders the menu with nothing around it.
  test("dismissing the Move-to menu hands focus back to the 📥 that opened it", async ({
    page,
  }) => {
    const marker = `${COMPACT_MARKER} focus`;
    const prisma = await seedDoneRows(marker);
    try {
      await page.goto("/");
      await waitForShell(page);

      const row = seededDoneRow(page, marker, 0);
      await expect(row).toBeVisible();
      const trigger = row.getByRole("button", { name: "Move to", exact: true });
      await trigger.click();
      const menu = page.getByRole("menu").filter({ visible: true }).first();
      await expect(menu).toBeVisible();

      await page.keyboard.press("Escape");
      await expect(menu).toBeHidden();

      // `settledFocusLabel`, not `toBeFocused()`, and that choice is the whole reason
      // this test can see the bug — see the helper: a retrying matcher is satisfied by
      // focus that touches the trigger for one frame on its way somewhere else, which
      // is precisely this failure mode.
      expect(
        await settledFocusLabel(page),
        "focus after dismissing the Move-to menu",
      ).toBe("Move to");
      await expect(trigger).toBeFocused();
    } finally {
      await cleanupSeed(prisma, marker);
    }
  });

  /**
   * ── Screenshots of the open ▾ list at 360px, for review ────────────────────
   *
   * Not assertions, and deliberately so: the ORDER and the grouping in that list
   * are the owner's design call, taken from a rendered phone screenshot rather
   * than from a written list, because the previous ordering was agreed on paper
   * and read badly once it was on screen. A green suite is not the same evidence
   * as their own eyes on the surface. Same reasoning and same shape as
   * `e2e/smoke/schedule-menu.spec.ts`'s screenshot block.
   *
   * The measurement IS an assertion though, and it is the one that matters here.
   * #253 restored four entries that a mid-issue pass had deleted, so the list is
   * longer than anything `expectInsideViewport` had measured before, and 360×780
   * is the smallest viewport the app supports. `popupSurface` carries no
   * max-height on purpose (its own note explains why), so the failure mode if it
   * did not fit would be a popup running off the bottom edge with no scroll to
   * recover with — fault 2 of this file, returning by a different route.
   *
   * Both Google states, because they are different lists: with no credential the
   * calendar group collapses to the single .ics entry (7 rows), and with one it
   * carries both Schedule and .ics (8 rows). The second is what a production user
   * sees and it is the taller of the two.
   */
  test.describe("#253 ▾ list screenshots at 360px", () => {
    const SHOTS = "test-results/row-menu-253";

    /** Open the seeded row's ▾ and hand back the row and the popup. */
    async function openSeededMenu(page: Page, marker: string) {
      const row = page
        .getByRole("listitem")
        .filter({ hasText: marker })
        .first();
      await expect(row).toBeVisible();
      await row.getByRole("button", { name: "All options" }).click();
      const popup = page
        .getByRole("dialog", { name: "All options" })
        .filter({ visible: true })
        .first();
      await expect(popup).toBeVisible();
      return { row, popup };
    }

    /**
     * The entries in document order with their rendered heights and LINE COUNTS,
     * so the shot is captioned by the run rather than by whatever its author
     * remembered — and so a wrapped label is a value a test can assert on.
     *
     * The wrapping matters and is not a nit: `popupSurface` is a flex column with
     * no width of its own, so the widest entry sets the popup's width and every
     * narrower one gets it for free. Take the widest entry away — which is what a
     * workspace with no Google connection does, since "Schedule to calendar (send
     * to Google Tasks)" is that entry — and the column narrows onto the next
     * longest, which could then wrap. `rowMenuEntry` carries no `whitespace-nowrap`
     * and no `truncate`, so nothing prevents it.
     *
     * ⚠️ Two corrections to how this used to work, both of which let a real
     * regression through:
     *
     *  1. `getByRole("button")` MISSED THE LINK ENTRIES. Two `rowMenuEntry`
     *     entries render as `<a>` — the Schedule slot is a `<Link>` when Google is
     *     not connected — so in that state one entry was neither counted nor
     *     height-measured. That is why the not-connected list was recorded as
     *     having 6 entries when it has 7, and it is provable without opening the
     *     screenshot: two lists cannot both be the same height with every entry at
     *     44px if one has six entries and the other seven.
     *  2. NOTHING ASSERTED ON THE RESULT. `rows` was computed, logged and
     *     dropped. The only per-entry bound in the file was `>= 44`, which a
     *     two-line ~62px entry passes comfortably — so the very symptom this
     *     issue exists to remove was measured on every run and never checked.
     *
     * Lines are counted from the distinct tops of the text's own client rects
     * rather than from the box height, deliberately: `min-h-11` pins the box to
     * 44px whatever the text does, so any height-over-line-height arithmetic reads
     * two lines for correct single-line markup.
     */
    async function entryRows(
      popup: Locator,
    ): Promise<Array<{ label: string; height: number; lines: number }>> {
      // `button, a` — see correction 1 above.
      const entries = await popup.locator("button, a").all();
      return Promise.all(
        entries.map(async (e) => ({
          label: (await e.textContent())?.trim() ?? "",
          ...(await e.evaluate((n: HTMLElement) => {
            const range = document.createRange();
            range.selectNodeContents(n);
            const tops = new Set(
              Array.from(range.getClientRects())
                .filter((r) => r.width > 0 && r.height > 0)
                .map((r) => Math.round(r.top)),
            );
            return {
              height: Math.round(n.getBoundingClientRect().height),
              lines: Math.max(1, tops.size),
            };
          })),
        })),
      );
    }

    /**
     * Every entry is one line and no taller than a single-line 44px target.
     *
     * `lines` is the precise statement and the height bound is the belt-and-braces
     * one: an entry that wraps grows past the `min-h-11` floor, so either check
     * catches it, and 48px leaves room for a sub-pixel layout without leaving room
     * for a second 20px line.
     */
    function expectNoWrappedEntries(
      rows: Array<{ label: string; height: number; lines: number }>,
      what: string,
    ) {
      expect(rows.length, `${what}: no entries were measured`).toBeGreaterThan(
        0,
      );
      for (const r of rows) {
        expect(
          r.lines,
          `${what}: "${r.label}" wrapped onto ${r.lines} lines (${r.height}px)`,
        ).toBe(1);
        expect(
          r.height,
          `${what}: "${r.label}" is ${r.height}px tall`,
        ).toBeLessThanOrEqual(48);
      }
    }

    for (const google of [false, true] as const) {
      const suffix = google ? "google-connected" : "google-not-connected";
      test(`captures the Needs-review ▾ list (${suffix})`, async ({ page }) => {
        const prisma = new PrismaClient();
        const marker = `${COMPACT_MARKER} shot ${suffix}`;
        try {
          await prisma.workspace.upsert({
            where: { id: OWNER_WS_ID },
            create: { id: OWNER_WS_ID, kind: "user" },
            update: {},
          });
          // Untriaged: the Needs-review bucket, which is the row the owner
          // screenshotted and the one with the longest ▾ list in the app.
          await prisma.brainDumpItem.create({
            data: { text: marker, status: "inbox", workspaceId: OWNER_WS_ID },
          });
          // The first-run welcome card is ~340 of the 780px and would be most of
          // the frame. Dismissed for the shot and put back afterwards — a review
          // image of a menu should be of the menu.
          await prisma.settings.updateMany({
            where: { workspaceId: OWNER_WS_ID },
            data: { welcomeDismissedAt: new Date() },
          });
          if (google) {
            // `configured` comes from the config's dummy client id; `connected`
            // needs a stored token, which is what this seeds. Nothing reaches
            // Google — the shot opens the list and never presses Schedule.
            await seedConnectedGoogle(prisma, OWNER_USER_ID, "e2e-shot-token");
          }

          await page.goto("/");
          await waitForShell(page);

          // Park the row at the top of the frame so the list opens DOWNWARDS from
          // it. Framing, not geometry: Base UI flips a popup that will not fit
          // below, and a shot of a flipped list sitting ON TOP of the row it
          // belongs to shows the entries but not what they act on. The fit itself
          // is asserted below and holds either way.
          //
          // 20px rather than something more generous because the list is 416px and
          // the ▾ sits ~170px into the row: at 120px from the top it flipped.
          //
          // ⚠️ This said "the taller of the two lists is 497px". There is no taller
          // of the two — both measure 416px, logged below on every run — and 497 is
          // the height of the PRE-#253 not-connected menu, which `strings.ts` and
          // `row-actions.tsx` cite as the shape this issue replaced. The same number
          // was being used with two different meanings in the tree.
          const rowLocator = page
            .getByRole("listitem")
            .filter({ hasText: marker })
            .first();
          await expect(rowLocator).toBeVisible();
          await parkNearBottom(page, rowLocator, NARROW.height - 20);

          const { popup } = await openSeededMenu(page, marker);
          const rows = await entryRows(popup);
          const box = await measure(popup);

          // Printed so the reviewer reading the image has the numbers beside it,
          // and so a CI log records them without anyone opening the PNG. A height
          // past 44 by more than a pixel or two is a wrapped label.
          console.log(
            `[#253] ▾ list (${suffix}) at ${box.vw}×${box.vh}: ` +
              `${rows.length} entries, ` +
              `${box.bottom - box.top}px tall, ` +
              `${box.right - box.left}px wide, ` +
              `top=${box.top} bottom=${box.bottom}\n` +
              rows
                .map((r, i) => `  ${i + 1}. ${r.height}px  ${r.label}`)
                .join("\n"),
          );

          await page.screenshot({
            path: `${SHOTS}/needs-review-360-${suffix}.png`,
          });

          // THE assertion, and the reason this is not a screenshot-only test: the
          // restored entries must not have pushed the list off the smallest
          // supported viewport.
          expectInsideViewport(box, `▾ list at 360px (${suffix})`);

          // And the entries themselves are single-line. This is the check the
          // measurement above was collected for and never fed: a compact row that
          // reaches its actions through a list whose labels wrap has moved the
          // height problem rather than solved it, which is the whole of #253.
          expectNoWrappedEntries(rows, `▾ list at 360px (${suffix})`);

          // No horizontal scroll bought the vertical fit — the longest label
          // ("Schedule to calendar (send to Google Tasks)") is in this list when
          // Google is connected, and `popupSurface`'s width cap plus the
          // positioner's shifting are what have to absorb it.
          expect(
            await page.evaluate(() => document.documentElement.scrollWidth),
          ).toBeLessThanOrEqual(NARROW.width);
        } finally {
          if (google) await clearGoogleTokens(prisma, OWNER_USER_ID);
          await prisma.settings.updateMany({
            where: { workspaceId: OWNER_WS_ID },
            data: { welcomeDismissedAt: null },
          });
          await prisma.brainDumpItem.deleteMany({
            where: { workspaceId: OWNER_WS_ID, text: { startsWith: marker } },
          });
          await prisma.$disconnect();
        }
      });
    }

    /**
     * ── Settles the claim the two shots above were only ever logging ───────────
     *
     * The tree asserted, in prose, that the not-connected list is TALLER than the
     * connected one because removing the longest entry narrows the column and the
     * next-longest label then wraps. That claim is load-bearing: it is the stated
     * justification for dropping `#128`'s OAuth caveat from the row entry
     * (`strings.ts`, same wording in `row-actions.tsx`), i.e. it names the symptom
     * this issue exists to remove. It was never asserted anywhere — the two
     * screenshot tests computed the numbers and `console.log`ged them.
     *
     * One test rather than a comparison stitched across the loop's two runs,
     * because the two states have to be measured against each other and a
     * cross-test module variable would depend on execution order to mean anything.
     *
     * PLAYFUL voice, which nothing else in the suite renders a ▾ list in. Playful
     * labels carry emoji and are the longer of the two variants, so this is the
     * worst case for a width-driven wrap — measuring only `plain` would leave the
     * state most likely to wrap unmeasured, which is the same gap as measuring
     * only the entries that happen to be `<button>`.
     */
    test("neither Google state's ▾ list wraps at 360px, in playful voice", async ({
      page,
    }) => {
      const prisma = new PrismaClient();
      const marker = `${COMPACT_MARKER} wrap probe`;
      const heights: Record<string, number> = {};
      try {
        await prisma.workspace.upsert({
          where: { id: OWNER_WS_ID },
          create: { id: OWNER_WS_ID, kind: "user" },
          update: {},
        });
        await prisma.brainDumpItem.create({
          data: { text: marker, status: "inbox", workspaceId: OWNER_WS_ID },
        });
        await prisma.settings.updateMany({
          where: { workspaceId: OWNER_WS_ID },
          data: { welcomeDismissedAt: new Date(), voice: "playful" },
        });

        for (const google of [false, true] as const) {
          const suffix = google ? "connected" : "not-connected";
          if (google) {
            await seedConnectedGoogle(prisma, OWNER_USER_ID, "e2e-wrap-token");
          }
          await page.goto("/");
          await waitForShell(page);
          const { popup } = await openSeededMenu(page, marker);
          const rows = await entryRows(popup);
          const box = await measure(popup);
          heights[suffix] = box.bottom - box.top;

          console.log(
            `[#253] playful ▾ (${suffix}) at ${box.vw}×${box.vh}: ` +
              `${rows.length} entries, ${heights[suffix]}px tall, ` +
              `${box.right - box.left}px wide\n` +
              rows
                .map(
                  (r, i) =>
                    `  ${i + 1}. ${r.height}px  ${r.lines} line(s)  ${r.label}`,
                )
                .join("\n"),
          );

          expectNoWrappedEntries(rows, `playful ▾ (${suffix}) at 360px`);
          expectInsideViewport(box, `playful ▾ (${suffix}) at 360px`);
          expect(
            await page.evaluate(() => document.documentElement.scrollWidth),
          ).toBeLessThanOrEqual(NARROW.width);
        }

        // With no entry wrapping in either state, the taller list is simply the one
        // with more entries — and the not-connected state has the SAME count, since
        // its Schedule slot is a `<Link>` rather than being absent. So the two
        // heights must agree. Asserted rather than described, because "not-connected
        // is taller" was described for three iterations while being false.
        expect(
          heights["not-connected"],
          `not-connected ${heights["not-connected"]}px vs connected ${heights["connected"]}px`,
        ).toBe(heights["connected"]);
      } finally {
        await clearGoogleTokens(prisma, OWNER_USER_ID);
        await prisma.settings.updateMany({
          where: { workspaceId: OWNER_WS_ID },
          data: { welcomeDismissedAt: null, voice: "plain" },
        });
        await prisma.brainDumpItem.deleteMany({
          where: { workspaceId: OWNER_WS_ID, text: { startsWith: marker } },
        });
        await prisma.$disconnect();
      }
    });

    /**
     * Proves `entryRows`' line counter can report a wrap at all.
     *
     * Needed because every assertion above it is a ZERO — "no entry wrapped" — and
     * a detector that can only ever return 1 would satisfy all of them while seeing
     * nothing. This repo has the rule written down for its file-parsing guards (a
     * pure module plus a test on synthetic input, so the parser can be shown to
     * fail); the equivalent for a layout probe is to force the layout it looks for.
     *
     * ⚠️ CSS injection, not a source edit, and that is the whole technique. The
     * `webServer` serves a PREBUILT bundle and is reused between runs, so editing
     * `rowMenuEntry` and re-running proves nothing — measured: adding `max-w-24` to
     * it left all four measurements unchanged and every entry on one line, because
     * the running server had never seen the change. `addStyleTag` applies to the
     * live document and needs no rebuild.
     */
    test("the wrap detector reports a wrap when one is forced", async ({
      page,
    }) => {
      const prisma = new PrismaClient();
      const marker = `${COMPACT_MARKER} detector control`;
      try {
        await prisma.workspace.upsert({
          where: { id: OWNER_WS_ID },
          create: { id: OWNER_WS_ID, kind: "user" },
          update: {},
        });
        await prisma.brainDumpItem.create({
          data: { text: marker, status: "inbox", workspaceId: OWNER_WS_ID },
        });
        await prisma.settings.updateMany({
          where: { workspaceId: OWNER_WS_ID },
          data: { welcomeDismissedAt: new Date() },
        });

        await page.goto("/");
        await waitForShell(page);
        // Narrow every entry far below its longest label. `!important` because
        // `rowMenuEntry`'s own `w-full` would otherwise win on specificity order.
        await page.addStyleTag({
          content:
            "[data-row-menu] button, [data-row-menu] a { max-width: 88px !important; }",
        });
        const { popup } = await openSeededMenu(page, marker);
        const rows = await entryRows(popup);

        const wrapped = rows.filter((r) => r.lines > 1);
        console.log(
          `[#253] detector control: ${wrapped.length}/${rows.length} entries wrapped\n` +
            rows
              .map((r) => `  ${r.height}px  ${r.lines} line(s)  ${r.label}`)
              .join("\n"),
        );

        // The detector sees multi-line entries…
        expect(
          wrapped.length,
          "no entry wrapped even at max-width 88px — the line counter is blind",
        ).toBeGreaterThan(0);
        // …and the assertion built on it rejects them, rather than passing on a
        // number it never looked at.
        expect(() =>
          expectNoWrappedEntries(rows, "forced-wrap control"),
        ).toThrow(/wrapped onto/);
      } finally {
        await prisma.settings.updateMany({
          where: { workspaceId: OWNER_WS_ID },
          data: { welcomeDismissedAt: null },
        });
        await prisma.brainDumpItem.deleteMany({
          where: { workspaceId: OWNER_WS_ID, text: { startsWith: marker } },
        });
        await prisma.$disconnect();
      }
    });

    /**
     * The LIBRARY row's ▾, same treatment and same measurement discipline.
     *
     * A separate test rather than a third pass of the loop above, because this row
     * is a different surface with a genuinely different list — three entries, no
     * `Move to…`, no calendar pair, no triage entries — and it lives on
     * `/library?tab=plated` rather than the inbox.
     *
     * ⚠️ Measured, not assumed to inherit the inbox's headroom. The inbox pair
     * showed that the popup's width is set by its LONGEST entry, so a renderer whose
     * longest label is shorter gets a narrower column and can wrap where the inbox
     * did not. This list's longest is "Start visual focus timer" — well under
     * "Schedule to calendar (send to Google Tasks)" — so the wrap risk is real and
     * the per-entry heights below are the thing that answers it.
     */
    test("captures a Library single-task row's ▾ list", async ({ page }) => {
      const prisma = new PrismaClient();
      const marker = `${COMPACT_MARKER} library shot`;
      try {
        await prisma.workspace.upsert({
          where: { id: OWNER_WS_ID },
          create: { id: OWNER_WS_ID, kind: "user" },
          update: {},
        });
        // Triaged with no steps → the Library's `plated` (Single-task) tab, which is
        // the `LibraryRows` renderer.
        await prisma.brainDumpItem.create({
          data: {
            text: marker,
            status: "triaged",
            triagedAt: new Date(),
            workspaceId: OWNER_WS_ID,
          },
        });

        await page.goto("/library?tab=plated");
        await waitForShell(page);

        const row = page
          .getByRole("listitem")
          .filter({ hasText: marker })
          .first();
        await expect(row).toBeVisible();
        await parkNearBottom(page, row, NARROW.height - 20);
        await row.getByRole("button", { name: "All options" }).click();
        const popup = page
          .getByRole("dialog", { name: "All options" })
          .filter({ visible: true })
          .first();
        await expect(popup).toBeVisible();

        const rows = await entryRows(popup);
        const box = await measure(popup);
        console.log(
          `[#253] ▾ list (library single-task) at ${box.vw}×${box.vh}: ` +
            `${rows.length} entries, ` +
            `${box.bottom - box.top}px tall, ` +
            `${box.right - box.left}px wide, ` +
            `top=${box.top} bottom=${box.bottom}\n` +
            rows
              .map((r, i) => `  ${i + 1}. ${r.height}px  ${r.label}`)
              .join("\n"),
        );

        await page.screenshot({ path: `${SHOTS}/library-single-task-360.png` });

        expectInsideViewport(box, "library ▾ list at 360px");
        expectNoWrappedEntries(rows, "library ▾ list at 360px");
        expect(
          await page.evaluate(() => document.documentElement.scrollWidth),
        ).toBeLessThanOrEqual(NARROW.width);
      } finally {
        await prisma.brainDumpItem.deleteMany({
          where: { workspaceId: OWNER_WS_ID, text: { startsWith: marker } },
        });
        await prisma.$disconnect();
      }
    });
  });
});

// ── #205 — the two surfaces that carried NO `touchTarget` at all ─────────────
//
// Folded into this MR because #205 rides this spec file and cannot run in a
// sibling worktree without colliding with it. Its scope box asks for the result to
// be checked at 390px and for THIS spec to be extended rather than a parallel one
// added, so that is what this is.
//
// The unit specs (`welcome-card.test.tsx`, `library-multistep.test.tsx`) assert the
// CLASSES, because jsdom computes no layout. This is the half that can see pixels,
// and it is the half that matters for a `min-w-11` on a control whose label is
// short enough that the floor is what sets its width.
//
// 44x44 is **2.5.5 Target Size (Enhanced), AAA**; **2.5.8 (Minimum) is the AA one,
// at 24x24**, which `py-1` already met. A house convention, not a conformance fix
// — the same wording `breakdown/note-field.tsx` records having had to correct.
test.describe("#205 the last two sub-44px surfaces at 390px", () => {
  test.use({ viewport: MOBILE });

  const M205 = "target-205";

  /** Every control's measured box, so a failure names the control and its size. */
  async function measureControls(
    scope: Locator,
    selector: string,
  ): Promise<Array<{ label: string; w: number; h: number }>> {
    const controls = await scope.locator(selector).all();
    return Promise.all(
      controls.map(async (c) =>
        c.evaluate((n: HTMLElement) => {
          const b = n.getBoundingClientRect();
          return {
            label: n.getAttribute("aria-label") ?? n.textContent?.trim() ?? "",
            w: Math.round(b.width),
            h: Math.round(b.height),
          };
        }),
      ),
    );
  }

  function expect44(
    controls: Array<{ label: string; w: number; h: number }>,
    what: string,
    expected: number,
  ) {
    // Guard the guard: an empty list satisfies a `for` loop silently, and the count
    // is the thing that catches a surface which stopped rendering a control.
    expect(controls.length, `${what}: control count`).toBe(expected);
    for (const c of controls) {
      expect(
        c.h,
        `${what}: "${c.label}" is ${c.h}px tall`,
      ).toBeGreaterThanOrEqual(44);
      expect(
        c.w,
        `${what}: "${c.label}" is ${c.w}px wide`,
      ).toBeGreaterThanOrEqual(44);
    }
  }

  /**
   * The first-run welcome card — the worst of the set to leave short, because on
   * first run these three are the only controls on the screen bar the capture box.
   *
   * THREE buttons, not the "2" #205's table records: that is the count of `<button`
   * occurrences in the source, and the voice pair comes out of a `.map`.
   */
  test("the welcome card's three buttons are 44px, and its inline links are not", async ({
    page,
  }) => {
    const prisma = new PrismaClient();
    try {
      await prisma.workspace.upsert({
        where: { id: OWNER_WS_ID },
        create: { id: OWNER_WS_ID, kind: "user" },
        update: {},
      });
      // The card shows until the workspace dismisses it, so un-dismiss for the run.
      await prisma.settings.updateMany({
        where: { workspaceId: OWNER_WS_ID },
        data: { welcomeDismissedAt: null },
      });

      await page.goto("/");
      await waitForShell(page);

      const card = page.getByRole("region", { name: "Welcome" });
      await expect(card).toBeVisible();

      const buttons = await measureControls(card, "button");
      console.log(
        `[#205] welcome card at 390px:\n` +
          buttons.map((b) => `  ${b.w}x${b.h}  ${b.label}`).join("\n"),
      );
      expect44(buttons, "welcome card", 3);

      // The three inline body links stay inline — both criteria carve an explicit
      // exception for a link inside a sentence, and squaring them would break the
      // line box of the paragraph they read as part of. Asserted so that a later
      // "size everything" pass has to argue with a test.
      const links = await measureControls(card, "a");
      expect(links.length, "welcome card inline links").toBe(3);
      for (const l of links) {
        expect(l.h, `"${l.label}" was squared up to ${l.h}px`).toBeLessThan(44);
      }

      expect(
        await page.evaluate(() => document.documentElement.scrollWidth),
      ).toBeLessThanOrEqual(MOBILE.width);
    } finally {
      await prisma.settings.updateMany({
        where: { workspaceId: OWNER_WS_ID },
        data: { welcomeDismissedAt: new Date() },
      });
      await prisma.$disconnect();
    }
  });

  /**
   * The Library Multi-step hub's header controls, in BOTH states — select mode
   * replaces "Select" and hides "Open task", so a check of the resting header alone
   * leaves two of the four unmeasured.
   *
   * "Open task" is a `<Link>`, which is why the selector is `button, a`: #205's
   * table counts `<button>` and cannot see it, yet it is a bordered pill at the same
   * `py-1` as the toggle beside it.
   */
  test("the Multi-step hub's header controls are 44px in both states", async ({
    page,
  }) => {
    const prisma = new PrismaClient();
    try {
      await prisma.workspace.upsert({
        where: { id: OWNER_WS_ID },
        create: { id: OWNER_WS_ID, kind: "user" },
        update: {},
      });
      await prisma.settings.updateMany({
        where: { workspaceId: OWNER_WS_ID },
        data: { welcomeDismissedAt: new Date() },
      });
      // A task with TWO steps → the Multi-step tab, which is the `LibraryMultistep`
      // renderer. One step would not distinguish it from a single-task row.
      const task = await prisma.task.create({
        data: { title: `${M205} multi`, workspaceId: OWNER_WS_ID },
      });
      // `total` and `estMinutes` are both non-null on `Step`, and `total` is the
      // count the collapsed row renders as "n/2 done". No `workspaceId` here —
      // `Step` is scoped through its `Task`, which is the tenancy edge, so it is
      // not enrolled in the workspaceId harness the way `BrainDumpItem` is.
      await prisma.step.createMany({
        data: [
          {
            taskId: task.id,
            order: 1,
            total: 2,
            text: "first",
            estMinutes: 10,
          },
          {
            taskId: task.id,
            order: 2,
            total: 2,
            text: "second",
            estMinutes: 5,
          },
        ],
      });
      await prisma.brainDumpItem.create({
        data: {
          text: `${M205} multi`,
          status: "triaged",
          triagedAt: new Date(),
          breakdownRequestedAt: new Date(),
          workspaceId: OWNER_WS_ID,
          taskId: task.id,
        },
      });

      await page.goto("/library?tab=sorted");
      await waitForShell(page);

      // Addressed BY NAME rather than by a container. The hub's header is an
      // unmarked `<div className="flex items-center justify-between">`, and a
      // `locator("div").filter({ has: … })` for it resolves to an ancestor — the
      // first attempt measured the app header (dlectroflow, Focus Timer, dark mode,
      // Account, Menu) and failed on a 24x24 wordmark that has nothing to do with
      // this issue. Naming each control also puts its label in the failure output,
      // and the named set IS the count guard: `getByRole` throws if one is missing.
      const named = (page_: Page, names: Array<string | RegExp>) =>
        names.map((n) =>
          typeof n === "string" && n === "Open task"
            ? page_.getByRole("link", { name: n })
            : page_.getByRole("button", { name: n }),
        );

      async function measureNamed(
        locators: Locator[],
      ): Promise<Array<{ label: string; w: number; h: number }>> {
        return Promise.all(
          locators.map(async (l) => {
            await expect(l).toBeVisible();
            return l.evaluate((n: HTMLElement) => {
              const b = n.getBoundingClientRect();
              return {
                label:
                  n.getAttribute("aria-label") ?? n.textContent?.trim() ?? "",
                w: Math.round(b.width),
                h: Math.round(b.height),
              };
            });
          }),
        );
      }

      // Open task (a `<Link>`) + the expand/collapse toggle + Select.
      const resting = await measureNamed(
        named(page, ["Open task", /^(Collapse|Expand) all$/, /^Select$/]),
      );
      console.log(
        `[#205] Multi-step header (resting) at 390px:\n` +
          resting.map((c) => `  ${c.w}x${c.h}  ${c.label}`).join("\n"),
      );
      expect44(resting, "Multi-step header at rest", 3);

      await page.getByRole("button", { name: /^Select$/ }).click();
      // The toggle stays (it renders in BOTH states); Select is replaced by
      // Select all + Cancel, and Open task is hidden.
      const selecting = await measureNamed(
        named(page, [/^(Collapse|Expand) all$/, /^Select all$/, /^Cancel$/]),
      );
      console.log(
        `[#205] Multi-step header (select mode) at 390px:\n` +
          selecting.map((c) => `  ${c.w}x${c.h}  ${c.label}`).join("\n"),
      );
      expect44(selecting, "Multi-step header in select mode", 3);
      // Proves the state actually changed, so the three above are a different set
      // from the three already measured rather than the same header re-read.
      await expect(page.getByRole("link", { name: "Open task" })).toBeHidden();
      await expect(page.getByRole("button", { name: /^Select$/ })).toBeHidden();

      expect(
        await page.evaluate(() => document.documentElement.scrollWidth),
      ).toBeLessThanOrEqual(MOBILE.width);
    } finally {
      await prisma.brainDumpItem.deleteMany({
        where: { workspaceId: OWNER_WS_ID, text: { startsWith: M205 } },
      });
      await prisma.task.deleteMany({
        where: { workspaceId: OWNER_WS_ID, title: { startsWith: M205 } },
      });
      await prisma.$disconnect();
    }
  });
});
