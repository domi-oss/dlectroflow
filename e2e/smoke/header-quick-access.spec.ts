import { test, expect, type Locator, type Page } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import {
  DESKTOP,
  MOBILE,
  NARROW,
  expandSection,
  waitForShell,
} from "../helpers";
import { OWNER_HANDLE, OWNER_USER_ID, OWNER_WS_ID } from "../constants";

/**
 * #252 — the header's quick-access cluster, measured in a real browser.
 *
 * `quick-access.test.tsx` proves what renders and what it is called.
 * `layout.test.tsx` proves the gates and the ordering. Neither can answer the
 * question the issue actually raised, because **jsdom has no layout**:
 *
 *  1. **Does the bar still fit?** Up to two more 44px controls join a cluster
 *     that already holds the theme toggle, a name and the menu, on a `max-w-3xl`
 *     row with `px-4`. `min-w-11` is a class name until something measures it,
 *     and #103's lesson was exactly this — a flex parent squeezing a control
 *     passes every unit test and fails the user.
 *  2. **Is the brand still on its line?** `dlectroflow` is one unbreakable word
 *     at `text-lg`, so it cannot wrap; it can only push the row wider than the
 *     viewport, and `document.documentElement.scrollWidth` is the only thing
 *     that sees that.
 *
 * ## Why 360 and not only 390
 *
 * Every existing width assertion in this suite uses `MOBILE` (390). Measured
 * before this change, the signed-in cluster had roughly 18px of slack there —
 * so 390 was already close to the limit and says nothing about the narrowest
 * phones still in use (iPhone SE, Galaxy S8-class), which report 360. Adding two
 * controls and asserting only at 390 would be asserting the wrong width. Hence
 * `NARROW`, and hence both.
 *
 * ## The state is set at both ends
 *
 * Both gates are persisted rows in the database the whole suite shares, and
 * `Settings.focusQuickAccess` defaults to ON, so "the icons are absent" is true
 * on a fresh CI database and false the second time this file runs locally. Every
 * test drives the pair to a known value first, and `afterAll` restores the
 * schema default — otherwise the rest of the suite would inherit an extra header
 * control from this file. Same discipline `e2e/a11y/axe-shopping.spec.ts` states.
 */

const MIN_TARGET = 44;

/** Set both #252 gates on the owner's own workspace. */
async function setGates(gates: {
  shoppingList: boolean;
  focusQuickAccess: boolean;
}): Promise<void> {
  const prisma = new PrismaClient();
  try {
    await prisma.settings.upsert({
      where: { workspaceId: OWNER_WS_ID },
      create: { id: OWNER_WS_ID, workspaceId: OWNER_WS_ID, ...gates },
      update: gates,
    });
  } finally {
    await prisma.$disconnect();
  }
}

/** Set — or clear — the owner's chosen display name. */
async function setDisplayName(displayName: string | null): Promise<void> {
  const prisma = new PrismaClient();
  try {
    await prisma.user.update({
      where: { id: OWNER_USER_ID },
      data: { displayName },
    });
  } finally {
    await prisma.$disconnect();
  }
}

const focusLink = (page: Page) =>
  page.locator("header").getByRole("link", { name: "Focus Timer" });
const shoppingLink = (page: Page) =>
  page.locator("header").getByRole("link", { name: "Shopping list" });
const identityTrigger = (page: Page) =>
  page.locator("header").getByRole("button", { name: /^Account: / });

/** The app bar itself — `.first()`, because /help's page heading is a header too. */
const appBar = (page: Page) => page.locator("header").first();

async function boxOf(locator: Locator, what: string) {
  const box = await locator.boundingBox();
  expect(box, `${what} has no layout box`).not.toBeNull();
  return box!;
}

test.afterAll(async () => {
  // Back to the schema defaults, so no other spec inherits this file's state.
  await setGates({ shoppingList: false, focusQuickAccess: true });
  await setDisplayName(null);
});

// ── Fit ─────────────────────────────────────────────────────────────────────

for (const [label, viewport] of [
  ["narrow (360)", NARROW],
  ["phone (390)", MOBILE],
  ["desktop (1280)", DESKTOP],
] as const) {
  test.describe(`#252 header quick access — fit, ${label}`, () => {
    test.beforeEach(async ({ page }) => {
      await page.setViewportSize(viewport);
      // The worst case the header can be asked to render: both shortcuts, and a
      // signed-in account whose name is on screen.
      await setGates({ shoppingList: true, focusQuickAccess: true });
    });

    // Measured on /help rather than the inbox, for #105's reason: the inbox
    // re-renders out of a hydration bailout and a single boundingBox() read can
    // come back null. The header is byte-identical on every route.
    test(`nothing overflows the viewport with five controls in the bar (${label})`, async ({
      page,
    }) => {
      await page.goto("/help");
      await waitForShell(page);

      // Precondition — this really is the five-control bar. A green "it fits"
      // over a cluster that never rendered the new controls is the zero that
      // means nothing was looked at.
      await expect(focusLink(page)).toBeVisible();
      await expect(shoppingLink(page)).toBeVisible();
      await expect(identityTrigger(page)).toBeVisible();

      const scrollWidth = await page.evaluate(
        () => document.documentElement.scrollWidth,
      );
      expect(
        scrollWidth,
        "the header pushes the document past the viewport",
      ).toBeLessThanOrEqual(viewport.width);
    });

    // The real worst case, and it is NOT the longest possible name: the trigger's
    // label is `truncate`d at a max-width, so a name past the cap renders at
    // exactly the cap. That width is what the 360px budget has to absorb, so it
    // is what gets asserted — measuring a short handle would leave 16px of the
    // margin unexercised, which is the whole margin.
    test(`still fits with the identity label at its truncation cap (${label})`, async ({
      page,
    }) => {
      await setDisplayName("Bartholomew Featherstonehaugh-Cholmondeley");
      try {
        await page.goto("/help");
        await waitForShell(page);
        // Precondition: the label really is clipped, so this is the capped case
        // and not a short string that happens to fit.
        const span = identityTrigger(page).locator("span").first();
        const clipped = await span.evaluate(
          (el) => el.scrollWidth > el.clientWidth,
        );
        expect(clipped, "the label is not truncated — not the worst case").toBe(
          true,
        );

        const scrollWidth = await page.evaluate(
          () => document.documentElement.scrollWidth,
        );
        expect(
          scrollWidth,
          "a capped identity label still overflows the viewport",
        ).toBeLessThanOrEqual(viewport.width);
      } finally {
        await setDisplayName(null);
      }
    });

    test(`the brand stays on one line, left of the cluster (${label})`, async ({
      page,
    }) => {
      await page.goto("/help");
      await waitForShell(page);

      const brand = appBar(page).getByRole("link", { name: /dlectroflow/i });
      await expect(brand).toBeVisible();

      // One line, asserted as one client rect: `dlectroflow` is a single
      // unbreakable word, so a second rect would mean the mark and the word
      // separated onto two lines.
      const rects = await brand.evaluate((el) => el.getClientRects().length);
      expect(rects, "the brand link wrapped onto two lines").toBe(1);

      // …and it does not collide with the control cluster to its right.
      const brandBox = await boxOf(brand, "the brand link");
      const firstControl = await boxOf(focusLink(page), "the focus shortcut");
      expect(
        brandBox.x + brandBox.width,
        "the brand overlaps the header controls",
      ).toBeLessThanOrEqual(firstControl.x);
      expect(brandBox.x).toBeGreaterThanOrEqual(0);
    });

    // WCAG 2.5.5, measured. Both shortcuts, and the theme toggle beside them,
    // because #252's requirement was that the three read and behave as one set.
    test(`every control in the cluster clears 44px (${label})`, async ({
      page,
    }) => {
      await page.goto("/help");
      await waitForShell(page);

      const controls: [string, Locator][] = [
        ["focus shortcut", focusLink(page)],
        ["shopping shortcut", shoppingLink(page)],
        ["theme toggle", appBar(page).getByRole("button", { name: /mode$/ })],
        ["identity trigger", identityTrigger(page)],
        ["menu trigger", appBar(page).getByRole("button", { name: "Menu" })],
      ];

      for (const [what, locator] of controls) {
        const box = await boxOf(locator, what);
        expect(
          Math.round(box.width),
          `${what} is under 44px wide (WCAG 2.5.5)`,
        ).toBeGreaterThanOrEqual(MIN_TARGET);
        expect(
          Math.round(box.height),
          `${what} is under 44px tall (WCAG 2.5.5)`,
        ).toBeGreaterThanOrEqual(MIN_TARGET);
        // Inside the viewport, both edges — an off-screen 44px target is not a
        // target (#92).
        expect(
          box.x,
          `${what} starts left of the viewport`,
        ).toBeGreaterThanOrEqual(0);
        expect(
          box.x + box.width,
          `${what} runs past the right edge`,
        ).toBeLessThanOrEqual(viewport.width);
      }
    });
  });
}

// ── Behaviour ───────────────────────────────────────────────────────────────

test.describe("#252 header quick access — behaviour", () => {
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize(NARROW);
  });

  test("one tap from any page to the focus timer, and to the shopping list", async ({
    page,
  }) => {
    await setGates({ shoppingList: true, focusQuickAccess: true });
    await page.goto("/help");
    await waitForShell(page);

    await focusLink(page).click();
    await expect(page).toHaveURL(/\/focus$/);

    await shoppingLink(page).click();
    await expect(page).toHaveURL(/\/shopping$/);
  });

  test("operable from the keyboard alone, with a visible focus indicator", async ({
    page,
  }) => {
    await setGates({ shoppingList: true, focusQuickAccess: true });
    await page.goto("/help");
    await waitForShell(page);

    const link = focusLink(page);
    await link.focus();
    await expect(link).toBeFocused();
    // WCAG 2.4.7 Focus Visible — the UA outline is removed (`outline-none`), so
    // the ring has to paint. axe cannot see this; a computed style can. (Cited as
    // 2.4.11 until #258, which is Focus Not Obscured and a different question.)
    const shadow = await link.evaluate((el) => getComputedStyle(el).boxShadow);
    expect(shadow, "the focused shortcut draws no ring").not.toBe("none");

    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/\/focus$/);
  });

  test("the trolley is absent when shopping-list mode is off, and /shopping still 404s", async ({
    page,
  }) => {
    await setGates({ shoppingList: false, focusQuickAccess: true });
    await page.goto("/help");
    await waitForShell(page);

    await expect(shoppingLink(page)).toHaveCount(0);
    // Positive control: the OTHER shortcut is there, so the absence above is the
    // gate and not a header that failed to render.
    await expect(focusLink(page)).toBeVisible();

    // Hiding the icon is presentation; the route is the gate (#199).
    await page.goto("/shopping");
    await expect(page.getByText(/404|not found/i).first()).toBeVisible();
  });

  test("the timer shortcut is absent when its setting is off, and /focus still works", async ({
    page,
  }) => {
    await setGates({ shoppingList: true, focusQuickAccess: false });
    await page.goto("/help");
    await waitForShell(page);

    await expect(focusLink(page)).toHaveCount(0);
    await expect(shoppingLink(page)).toBeVisible();

    // The setting governs the ICON, not the feature: the menu still lists the
    // timer and the route still answers. Turning the shortcut off must not take
    // the focus timer away.
    await page.getByRole("button", { name: "Menu" }).click();
    await page
      .getByRole("navigation", { name: "Main" })
      .getByRole("link", { name: /Focus Timer/ })
      .click();
    await expect(page).toHaveURL(/\/focus$/);
  });

  // The second half of #252: the bar greeted people by a provider handle.
  test("the header greets the owner by the name they chose", async ({
    page,
  }) => {
    await setGates({ shoppingList: true, focusQuickAccess: true });
    await setDisplayName("Domi");
    try {
      await page.goto("/help");
      await waitForShell(page);

      const trigger = identityTrigger(page);
      await expect(trigger).toContainText("Domi");
      await expect(trigger).toHaveAccessibleName("Account: Domi");
      await expect(trigger).not.toContainText(OWNER_HANDLE);

      // Still fits at the narrowest width with a name in the corner.
      const scrollWidth = await page.evaluate(
        () => document.documentElement.scrollWidth,
      );
      expect(scrollWidth).toBeLessThanOrEqual(NARROW.width);
    } finally {
      await setDisplayName(null);
    }
  });

  test("and falls back to the provider handle when no name is set", async ({
    page,
  }) => {
    await setDisplayName(null);
    await page.goto("/help");
    await waitForShell(page);
    await expect(identityTrigger(page)).toContainText(OWNER_HANDLE);
  });
});

// ── Driven from Settings, the way a person does it ──────────────────────────
//
// The two describes above set state with Prisma, which proves the header READS
// it. This one proves the whole path: the Settings control renders, its write
// lands, and the app shell — a different component tree on a different route —
// changes as a result. That is the half a unit test structurally cannot reach,
// and the half that broke in #199 (a client component reaching a module that
// constructs `new PrismaClient()`: `next build` green, unit suite green, the
// chunk threw in a browser).

test.describe("#252 driven from Settings", () => {
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize(DESKTOP);
  });

  test("turning the shortcut off in Settings removes it from the header", async ({
    page,
  }) => {
    await setGates({ shoppingList: false, focusQuickAccess: true });
    await page.goto("/settings");
    await waitForShell(page);
    await expandSection(page, "settings-focus-timer");

    const toggle = page.getByRole("checkbox", {
      name: /shortcut in the header/i,
    });
    await expect(toggle).toBeChecked();
    // The header on THIS page already carries it, so the removal is observable
    // without navigating anywhere.
    await expect(focusLink(page)).toBeVisible();

    await toggle.setChecked(false);
    // The shortcut is server-rendered by the layout, so it can only disappear
    // once the write has landed and the revalidation has taken effect — which is
    // what makes this the proof rather than the checkbox's own state.
    await expect(focusLink(page)).toHaveCount(0);

    // …and back, so nothing after this file inherits the change.
    await toggle.setChecked(true);
    await expect(focusLink(page)).toBeVisible();
  });

  test("typing a name in Settings changes what the header calls you", async ({
    page,
  }) => {
    await setDisplayName(null);
    try {
      await page.goto("/settings");
      await waitForShell(page);
      await expandSection(page, "settings-account");

      await expect(identityTrigger(page)).toContainText(OWNER_HANDLE);

      const nameField = page.getByLabel(/your name/i);
      await nameField.fill("Domi");
      // Auto-saved behind a debounce, so this waits on the HEADER rather than on
      // a Save button there is none of.
      await expect(identityTrigger(page)).toContainText("Domi");
      await expect(identityTrigger(page)).toHaveAccessibleName("Account: Domi");

      // Emptying it is the documented way back, and the hint promises it.
      await nameField.fill("");
      await expect(identityTrigger(page)).toContainText(OWNER_HANDLE);
    } finally {
      await setDisplayName(null);
    }
  });

  // The length bound is enforced by the field, not only by the action, so a
  // refusal is not something a user can reach by typing.
  test("the name field stops at the cap rather than letting the write fail", async ({
    page,
  }) => {
    await setDisplayName(null);
    try {
      await page.goto("/settings");
      await waitForShell(page);
      await expandSection(page, "settings-account");

      const nameField = page.getByLabel(/your name/i);
      await nameField.fill("");
      await nameField.pressSequentially("a".repeat(70), { delay: 0 });
      expect(await nameField.inputValue()).toHaveLength(60);
    } finally {
      await setDisplayName(null);
    }
  });
});
