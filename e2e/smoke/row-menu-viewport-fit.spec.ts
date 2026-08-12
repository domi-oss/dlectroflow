import { test, expect, type Locator, type Page } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import { MOBILE, NARROW, waitForShell } from "../helpers";
import { OWNER_WS_ID } from "../constants";

// #92 — row-action popups must stay inside the viewport at phone width.
//
// Two independent, reproduced faults, both invisible to every other spec
// because none of them measured a popup's box:
//
//  1. LEFT-EDGE OVERFLOW, UNRECOVERABLE. The 📥 Move-to menu was
//     `absolute right-0 min-w-40`, anchored to its own trigger. At 390 that
//     trigger is the leftmost control of a wide end cluster (which also holds
//     the "Connect Google →" link), so it sat at x≈73 and the 160px menu was
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
  test("the Move-to menu, nested in the 🔽 popup, stays inside the viewport", async ({
    page,
  }) => {
    const marker = `${SEED_MARKER} move`;
    const prisma = await seedRows(marker);
    try {
      await page.goto("/");
      await waitForShell(page);

      const row = seededRow(page, marker, 0);
      await expect(row).toBeVisible();
      // The 📥 really is gone from the row, so this cannot pass by finding the old
      // inline trigger if a rebase brought it back.
      await expect(
        row.getByRole("button", { name: "Move to", exact: true }),
      ).toHaveCount(0);
      await row.getByRole("button", { name: "All options" }).click();
      const trigger = page.getByRole("button", { name: "Move to…" });
      await expect(trigger).toBeVisible();
      await trigger.click();
      const menu = page.getByRole("menu").filter({ visible: true }).first();
      await expect(menu).toBeVisible();
      expectInsideViewport(await measure(menu), "nested Move-to menu");
    } finally {
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
    const prisma = await seedRows(marker);
    try {
      await page.goto("/");
      await waitForShell(page);

      // #253 — via the 🔽 list, since the compact 📥 went with the end cluster.
      // The property under test is unchanged: a row popup must not lock document
      // scroll, and a scroll must not dismiss it.
      const row = seededRow(page, marker, 0);
      await expect(row).toBeVisible();
      await row.getByRole("button", { name: "All options" }).click();
      await page.getByRole("button", { name: "Move to…" }).click();
      const menu = page.getByRole("menu").filter({ visible: true }).first();
      await expect(menu).toBeVisible();

      // The page must still scroll — Base UI's Menu `modal` default (true)
      // locks document scroll, which would strand a user whose popup is only
      // partly reachable and generally make the page feel broken.
      const before = await page.evaluate(() => window.scrollY);
      await page.evaluate(() => window.scrollBy(0, 200));
      await page.waitForTimeout(150);
      const after = await page.evaluate(() => window.scrollY);
      expect(
        after,
        "page still scrolls while a row popup is open",
      ).toBeGreaterThan(before);

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

  test("the 🔽 popup's nested Move-to menu still dispatches a move", async ({
    page,
  }) => {
    const marker = `${SEED_MARKER} nested`;
    const prisma = await seedRows(marker);
    try {
      await page.goto("/");
      await waitForShell(page);

      const row = seededRow(page, marker, 0);
      await expect(row).toBeVisible();
      await row.getByRole("button", { name: "All options" }).click();
      // Nested floating elements: the 🔽 popup must not treat a press inside
      // its own child menu as an outside press and unmount it mid-click.
      await page.getByRole("button", { name: "Move to…" }).click();
      const nested = page.getByRole("menu").filter({ visible: true }).first();
      await expect(nested).toBeVisible();
      expectInsideViewport(await measure(nested), "nested Move-to menu");
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
      // credential — covered at 390 by e2e/smoke/schedule-ics.spec.ts.
      for (const name of ["Add as single task to do", "Move to…", "Delete"]) {
        await expect(
          popup.getByRole("button", { name }),
          `"${name}" is not in the ▾ list`,
        ).toBeVisible();
      }

      for (const entry of await popup.getByRole("button").all()) {
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
});
