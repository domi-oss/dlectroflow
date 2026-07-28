import { test, expect, type Locator, type Page } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import { MOBILE, setTheme, expectThemeApplied, waitForShell } from "../helpers";
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

/** Scroll so `el` sits `fromBottom` px above the viewport bottom — the position
 *  a real user's last row occupies when they reach for its menu. */
async function parkNearBottom(page: Page, el: Locator, fromBottom = 60) {
  const vh = page.viewportSize()!.height;
  for (let i = 0; i < 8; i++) {
    const b = await el.boundingBox();
    if (!b) return;
    const delta = b.y - (vh - fromBottom);
    if (Math.abs(delta) < 8) return;
    await page.evaluate((d) => window.scrollBy(0, d), delta);
    await page.waitForTimeout(120);
  }
}

test.describe("#92 row-action popups fit the phone viewport", () => {
  test.use({ viewport: MOBILE });

  for (const theme of ["light", "dark"] as const) {
    test(`the 📥 Move-to menu stays inside the viewport (${theme})`, async ({
      page,
    }) => {
      const marker = `${SEED_MARKER} move ${theme}`;
      const prisma = await seedRows(marker);
      try {
        await setTheme(page, theme);
        await page.goto("/");
        await waitForShell(page);
        await expectThemeApplied(page, theme);

        const trigger = page.getByRole("button", { name: "Move to" }).first();
        await expect(trigger).toBeVisible();

        // Guard the repro precondition: the trigger really is near the left
        // edge of a wide end cluster. If a layout change ever moves it back to
        // the right, the measurement below stops proving anything.
        const tb = (await trigger.boundingBox())!;
        expect(
          tb.x,
          "📥 trigger sits left of centre (the fault-1 precondition)",
        ).toBeLessThan(MOBILE.width / 2);

        await trigger.click();
        const menu = page.getByRole("menu").filter({ visible: true }).first();
        await expect(menu).toBeVisible();
        expectInsideViewport(await measure(menu), "📥 Move-to menu");
      } finally {
        await cleanupSeed(prisma, marker);
      }
    });

    test(`the 🔽 All-options popup opened near the bottom edge stays inside the viewport (${theme})`, async ({
      page,
    }) => {
      const marker = `${SEED_MARKER} overflow ${theme}`;
      const prisma = await seedRows(marker);
      try {
        await setTheme(page, theme);
        await page.goto("/");
        await waitForShell(page);
        await expectThemeApplied(page, theme);

        const trigger = page
          .getByRole("button", { name: "All options" })
          .first();
        await expect(trigger).toBeAttached();
        await parkNearBottom(page, trigger);

        // Guard the repro precondition: an unflipped 288px popup from here
        // could not possibly fit, so a pass means collision handling ran.
        const tb = (await trigger.boundingBox())!;
        expect(
          tb.y - (await page.evaluate(() => window.scrollY)),
          "🔽 trigger is parked in the bottom third (the fault-2 precondition)",
        ).toBeGreaterThan(MOBILE.height * 0.6);

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
  }

  test("opening a row popup neither locks page scroll nor is dismissed by it", async ({
    page,
  }) => {
    const marker = `${SEED_MARKER} scroll`;
    const prisma = await seedRows(marker);
    try {
      await page.goto("/");
      await waitForShell(page);

      const trigger = page.getByRole("button", { name: "Move to" }).first();
      await expect(trigger).toBeVisible();
      await trigger.click();
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
      expectInsideViewport(await measure(menu), "📥 menu after a page scroll");
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

      const row = page
        .locator('[data-bucket="singleTask"]')
        .getByRole("listitem")
        .filter({ hasText: `${marker} 0` });
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

// The 📅 duration popover shares the exact shape of the two above
// (`absolute right-0` on its own trigger). For the OWNER it only appears with
// Google connected, which this environment has no way to be — but a GUEST's
// primary 📅 is the .ics control in its `needs_duration` form, so the same
// popup is reachable with no cookies at all.
test.describe("#92 the 📅 duration popover fits the phone viewport", () => {
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

    const trigger = page
      .getByRole("button", { name: "Add to calendar (.ics)" })
      .first();
    await expect(trigger).toBeAttached();
    await parkNearBottom(page, trigger);
    await trigger.click();

    const popover = page
      .getByRole("dialog", { name: /duration/i })
      .filter({ visible: true })
      .first();
    await expect(popover).toBeVisible();
    expectInsideViewport(await measure(popover), "📅 duration popover");
  });
});
