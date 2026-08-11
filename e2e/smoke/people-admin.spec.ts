import { test, expect, type Locator, type Page } from "@playwright/test";
import { MOBILE, waitForShell, sectionToggle } from "../helpers";

// #35 Phase B — the owner-only People panel, end to end.
//
// The suite runs with the forged OWNER session (see e2e/global-setup.ts), so what
// these specs prove is the half jsdom cannot: the panel is really on the page a
// real browser renders, the invite → pending → withdraw round trip really writes
// and un-writes the database through the server actions, the owner's own row
// really offers no way to lock themselves out — and, since the panel became a
// disclosure (owner decision on !175), that collapsing it does not break !162's
// sticky section nav, whose scroll-spy and jump targets both depend on section
// GEOMETRY.
//
// The guest side of the gate — that a visitor with no account sees none of this —
// lives in guest-unaffected.spec.ts, next to the rest of the guest assertions.

const PEOPLE = "#settings-people";
const SETTINGS_NAV = 'nav[aria-label="Settings sections"]';

/**
 * The nav only gains its scroll-spy and its measured height after hydration, so
 * every geometry assertion has to wait for the opt-in it performs on mount.
 * (Same guard as e2e/smoke/section-nav.spec.ts.)
 */
async function waitForNavHydrated(page: Page): Promise<void> {
  await expect
    .poll(() =>
      page.evaluate(() =>
        document.documentElement.classList.contains("scroll-smooth"),
      ),
    )
    .toBe(true);
}

/** Wait for a (possibly smooth-animated) scroll to come to rest. */
async function waitForScrollToSettle(page: Page): Promise<void> {
  await page.waitForFunction(
    () =>
      new Promise<boolean>((resolve) => {
        let last = window.scrollY;
        let still = 0;
        const tick = () => {
          if (window.scrollY === last) {
            if (++still > 3) return resolve(true);
          } else {
            still = 0;
            last = window.scrollY;
          }
          requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      }),
  );
}

/**
 * The panel's disclosure trigger.
 *
 * #101 moved it inside the h2 (the chevron has to sit before the title), so its
 * accessible name is now the section's own label — which the "Jump to…" nav also
 * renders as a link. `data-section-toggle` is the unambiguous hook every section
 * carries.
 */
function peopleToggle(page: Page): Locator {
  return sectionToggle(page, "settings-people");
}

/**
 * The triage line in the heading band, beside the title.
 *
 * A sibling of the H2 rather than of the trigger: the trigger lives inside the
 * heading now, so `[data-section-toggle] ~ span` finds nothing.
 */
function peopleSummary(page: Page): Locator {
  return page.locator("#settings-people ~ span").first();
}

/** Open the panel (it rests collapsed) and wait for its body to be on screen. */
async function openPeople(page: Page): Promise<void> {
  await peopleToggle(page).click();
  await expect(peopleToggle(page)).toHaveAttribute("aria-expanded", "true");
  await expect(page.getByRole("list", { name: /accounts/i })).toBeVisible();
}

/** A throwaway identity, unique per run so a leftover row can't collide. */
function throwawayIdentity(): string {
  return `e2e-invitee-${Date.now()}`;
}

test.describe("People admin — the disclosure", () => {
  test("rests COLLAPSED, with a summary that answers 'is anything up?'", async ({
    page,
  }) => {
    await page.goto("/settings");
    await waitForShell(page);

    const toggle = peopleToggle(page);
    await expect(toggle).toBeVisible();
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    // The summary is the collapsed row's whole justification. It sits beside the
    // title now (#101) and is wired to the trigger as its accessible description,
    // so it is still what a screen-reader user hears on the collapsed row.
    await expect(peopleSummary(page)).toContainText(/\d+ account/);
    await expect(toggle).toHaveAccessibleDescription(/\d+ account/);

    // Nothing behind it is reachable — not on screen, not in the tab order.
    await expect(page.getByRole("list", { name: /accounts/i })).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: /send invitation/i }),
    ).toHaveCount(0);
  });

  test("stays collapsed on a RELOAD — expansion is never persisted", async ({
    page,
  }) => {
    // !162's precedent: default collapsed rather than restore a state the reader
    // has forgotten they left.
    await page.goto("/settings");
    await waitForShell(page);
    await openPeople(page);

    await page.reload();
    await waitForShell(page);
    await expect(peopleToggle(page)).toHaveAttribute("aria-expanded", "false");
  });

  test("is collapsed from FIRST PAINT — no expanded-then-collapsed flash", async ({
    page,
  }) => {
    // Asserted against the server's HTML, before any JavaScript runs: if the
    // panel were expanded server-side and collapsed on hydration, the body would
    // arrive without its `hidden` attribute.
    const res = await page.request.get("/settings");
    const html = await res.text();

    // Matched on the PEOPLE trigger specifically, via its section hook. The
    // section nav's own "Jump to…" toggle also carries aria-expanded="false" +
    // aria-controls and comes FIRST in the document, so a generic pattern finds
    // that one instead and proves nothing about this panel.
    const trigger =
      /<button[^>]*data-section-toggle="settings-people"[^>]*aria-expanded="false"[^>]*aria-controls="([^"]+)"/.exec(
        html,
      );
    expect(
      trigger,
      "no collapsed People trigger in the server HTML",
    ).not.toBeNull();
    // The controlled body is present AND hidden in that same first response.
    // `toContain` on the exact substring: no regex built from a captured value,
    // and no escaping to get wrong in an id React generates.
    expect(html).toContain(`id="${trigger![1]}" hidden=""`);
  });

  test("is keyboard operable with a visible focus ring", async ({ page }) => {
    await page.goto("/settings");
    await waitForShell(page);
    const toggle = peopleToggle(page);

    await toggle.focus();
    const ring = await toggle.evaluate(
      (el) => getComputedStyle(el).boxShadow ?? "none",
    );
    expect(ring).not.toBe("none");

    await page.keyboard.press("Enter");
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    await page.keyboard.press(" ");
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
  });

  test("collapsing hands the page back: the panel costs almost no height", async ({
    page,
  }) => {
    // The whole point of the owner's request — instance administration must not
    // sit between them and their own timer settings.
    await page.setViewportSize(MOBILE);
    await page.goto("/settings");
    await waitForShell(page);

    const section = page
      .locator("section")
      .filter({ has: page.locator(PEOPLE) });
    const collapsed = (await section.boundingBox())!.height;
    await openPeople(page);
    const expandedHeight = (await section.boundingBox())!.height;

    // Collapsed is a heading row plus the trigger, not a screenful.
    expect(collapsed).toBeLessThan(140);
    // And it really was hiding something substantial.
    expect(expandedHeight).toBeGreaterThan(collapsed * 4);
  });
});

// ── !162 interaction: collapsing a section changes its GEOMETRY ───────────────
//
// The section nav measures its own height into `--section-nav-h`, derives every
// jump target's `scroll-margin-top` from it, and tracks the current section with
// an IntersectionObserver over each section element. A collapsed People section
// is a ~100px band where an expanded one is ~1900px, so all three have to be
// checked in both states — this is the class of bug !162 already fixed twice.
for (const state of ["collapsed", "expanded"] as const) {
  test.describe(`section nav interaction — People ${state}`, () => {
    test.beforeEach(async ({ page }) => {
      await page.goto("/settings");
      await waitForShell(page);
      await waitForNavHydrated(page);
      if (state === "expanded") await openPeople(page);
    });

    test("the nav lists People and jumping to it lands clear of the sticky bar", async ({
      page,
    }) => {
      const nav = page.locator(SETTINGS_NAV);
      await nav.getByRole("button", { name: /jump to/i }).click();
      await nav.getByRole("link", { name: "People" }).click();

      const heading = page.locator(PEOPLE);
      await expect(heading).toBeFocused();
      await expect(heading).toBeInViewport();
      await waitForScrollToSettle(page);

      const navBox = (await nav.boundingBox())!;
      const headingBox = (await heading.boundingBox())!;
      // Below the bar, never underneath it. 1px of slack for sub-pixel rounding.
      expect(headingBox.y).toBeGreaterThanOrEqual(navBox.y + navBox.height - 1);
    });

    test("the scroll-spy names People at the END of the page", async ({
      page,
    }) => {
      // #101 moved People to the end (administration last), which puts it in the
      // hardest spot for the spy: the last section can never reach the top of the
      // viewport, so "topmost in the band wins" would strand the entry above it.
      // Collapsed, it is a ~56px band, which is the version of that bug this
      // whole disclosure invites.
      await page.evaluate(() =>
        window.scrollTo(0, document.documentElement.scrollHeight),
      );
      await waitForScrollToSettle(page);

      await expect(page.locator(`${SETTINGS_NAV} a[aria-current]`)).toHaveText(
        /People/,
      );
      await expect(page.locator(`${SETTINGS_NAV} a[aria-current]`)).toHaveCount(
        1,
      );
    });

    test("the pinned section header is People's at the end, and exactly one is pinned", async ({
      page,
    }) => {
      await page.evaluate(() =>
        window.scrollTo(0, document.documentElement.scrollHeight),
      );
      await waitForScrollToSettle(page);

      const pinned = page.locator("[data-section-header][data-current]");
      await expect(pinned).toHaveCount(1);
      await expect(pinned).toContainText("People");
      // The pinned band and the lit nav entry must never name different sections.
      const pinnedId = await pinned.locator("h2").getAttribute("id");
      const currentHref = await page
        .locator(`${SETTINGS_NAV} a[aria-current]`)
        .getAttribute("href");
      expect(currentHref).toBe(`#${pinnedId}`);
    });

    test("scrolling back up off People hands the current section over", async ({
      page,
    }) => {
      // Whatever People's height, the sections ABOVE it must be able to become
      // current again — a mis-measured band can strand the spy on the last one.
      await page.evaluate(() =>
        window.scrollTo(0, document.documentElement.scrollHeight),
      );
      await waitForScrollToSettle(page);
      await page.evaluate(() => window.scrollTo(0, 0));
      await waitForScrollToSettle(page);

      await expect(page.locator(`${SETTINGS_NAV} a[aria-current]`)).toHaveText(
        /Focus timer/,
      );
    });
  });
}

test.describe("People admin (owner)", () => {
  test("the panel CLOSES the settings page and is listed in the nav", async ({
    page,
  }) => {
    await page.goto("/settings");
    await waitForShell(page);

    await expect(page.locator(PEOPLE)).toBeVisible();
    // #101 — instance administration is not what should greet the owner on their
    // own settings page. It used to be first; it is now last.
    const headings = page.locator("h2[data-section-target]");
    await expect(headings.last()).toHaveAttribute("id", "settings-people");

    // …and the section nav lists it, so the anchor is reachable.
    const nav = page.locator(SETTINGS_NAV);
    await nav.getByRole("button", { name: /jump to/i }).click();
    await expect(nav.getByRole("link", { name: "People" })).toBeVisible();
  });

  test("says outright that the owner sees numbers, never content", async ({
    page,
  }) => {
    await page.goto("/settings");
    await waitForShell(page);
    await openPeople(page);

    await expect(
      page.getByText(/never anyone.s tasks, notes or other content/i),
    ).toBeVisible();
    // The copy bug found by eyeballing the !175 screenshots: the JSX transform
    // ate the space before "window" in the production build.
    await expect(page.getByText(/rolling 30 days window/i)).toBeVisible();
  });

  test("the owner's own row leads the list, is uncapped, and cannot be revoked", async ({
    page,
  }) => {
    await page.goto("/settings");
    await waitForShell(page);
    await openPeople(page);

    // The owner's row is FIRST — it is theirs, and the one they cannot revoke.
    const cards = page.locator("[data-person-label]");
    await expect(cards.first()).toHaveAttribute(
      "data-person-label",
      "e2e-owner",
    );

    const own = page.locator('[data-person-label="e2e-owner"]');
    // The instance owner is uncapped by design. Owner decision on !175: their
    // usage is still COUNTED and shown — as a bare count with no denominator, so
    // it reads as information rather than as a limit being approached.
    await expect(own).toContainText(/uncapped/i);
    await expect(own).toContainText(/used this window/i);
    await expect(own).not.toContainText("/ 50");
    await expect(own).toContainText("Owner");
    await expect(own).toContainText(/this is you/i);
    await expect(own.getByRole("button", { name: /revoke/i })).toHaveCount(0);
    // The quota field is inert while uncapped, so it is disabled.
    await expect(own.getByLabel(/quota for e2e-owner/i)).toBeDisabled();
  });

  test("invite → pending → withdraw, through the real server actions", async ({
    page,
  }) => {
    const identity = throwawayIdentity();
    await page.goto("/settings");
    await waitForShell(page);
    await openPeople(page);

    await page.getByLabel(/invite a username or email/i).fill(identity);
    await page.getByLabel(/note \(optional\)/i).fill("e2e throwaway");
    await page.getByRole("button", { name: /send invitation/i }).click();

    // Reported, and the form is cleared ready for the next one.
    await expect(page.getByRole("status")).toContainText(`Invited ${identity}`);
    await expect(page.getByLabel(/invite a username or email/i)).toHaveValue(
      "",
    );

    // It shows up in the invitations list as pending.
    const invitations = page.getByRole("list", { name: /invitations/i });
    const row = invitations.getByRole("listitem").filter({ hasText: identity });
    await expect(row).toBeVisible();
    await expect(row).toContainText("Pending");
    await expect(row).toContainText("e2e throwaway");

    // Withdraw it again — this is also the cleanup, so the row cannot leak into
    // the next run.
    await row
      .getByRole("button", {
        name: `Withdraw the invitation for ${identity}`,
      })
      .click();
    await expect(page.getByRole("status")).toContainText(/withdrawn/i);
    await expect(
      invitations.getByRole("listitem").filter({ hasText: identity }),
    ).toHaveCount(0);
  });

  test("refuses a duplicate invitation in words rather than failing silently", async ({
    page,
  }) => {
    const identity = throwawayIdentity();
    await page.goto("/settings");
    await waitForShell(page);
    await openPeople(page);

    const field = page.getByLabel(/invite a username or email/i);
    const send = page.getByRole("button", { name: /send invitation/i });

    await field.fill(identity);
    await send.click();
    await expect(page.getByRole("status")).toContainText(/invited/i);

    await field.fill(identity);
    await send.click();
    // Scoped to the panel: Next renders its own role="alert" route announcer, so
    // an unscoped getByRole("alert") is a strict-mode violation, not a failure.
    await expect(
      page
        .locator("section")
        .filter({ has: page.locator(PEOPLE) })
        .getByRole("alert"),
    ).toContainText(/already invited/i);

    // Cleanup.
    const invitations = page.getByRole("list", { name: /invitations/i });
    await invitations
      .getByRole("listitem")
      .filter({ hasText: identity })
      .getByRole("button", { name: /withdraw/i })
      .click();
    await expect(page.getByRole("status")).toContainText(/withdrawn/i);
  });

  test("every control in the panel clears the 44px touch-target minimum", async ({
    page,
  }) => {
    await page.setViewportSize(MOBILE);
    await page.goto("/settings");
    await waitForShell(page);

    // The disclosure trigger is the panel's resting UI, so it counts too.
    expect(
      (await peopleToggle(page).boundingBox())!.height,
    ).toBeGreaterThanOrEqual(44);

    await openPeople(page);
    const panel = page.locator("section").filter({ has: page.locator(PEOPLE) });
    const controls = panel.locator("button, select, input");
    const count = await controls.count();
    expect(count).toBeGreaterThan(3);
    for (let i = 0; i < count; i++) {
      const box = await controls.nth(i).boundingBox();
      expect(
        box!.height,
        `control ${i} is only ${box!.height}px tall`,
      ).toBeGreaterThanOrEqual(44);
    }
  });

  test("the panel renders no key material at all", async ({ page }) => {
    await page.goto("/settings");
    await waitForShell(page);
    await openPeople(page);

    const panel = page.locator("section").filter({ has: page.locator(PEOPLE) });
    const html = await panel.innerHTML();
    // The design's hard rule, checked against what a browser actually receives:
    // the encrypted column is never even loaded, so its envelope prefix ("v1:")
    // and any key-shaped string must be absent from the delivered markup.
    expect(html).not.toMatch(/v1:/);
    expect(html).not.toMatch(/sk-[A-Za-z0-9]/);
  });
});

// ── The coverage hole collapsing the panel opened ─────────────────────────────
//
// `e2e/a11y-contrast.spec.ts` scans owner `/settings` with ZERO tolerance, and
// that scan used to see the whole People panel. Collapsing it by default (!175)
// took ~1900px of controls out of the scanned DOM, so the panel's expanded and
// mid-revoke states need a scan of their own.
//
// That scan lives in `e2e/a11y/axe-people-panel.spec.ts`, not here (#247). It was
// here, and this file runs in the `chromium` project — where the suite-wide
// `retries` applies, which is exactly what #127 removed from the accessibility
// gate. A retried AA assertion is indistinguishable from a real regression that
// happens to be timing-dependent, and #127's fix could not see these three calls
// because it guards a project and an a11y assertion is a call, not a file.
//
// What stays here is the behavioural half: the invite → pending → withdraw round
// trip against a real database, the sticky-nav geometry, and the owner's own row
// offering no way to lock themselves out. Those keep the retry, which is the
// right default for them.
