import { test, expect, type Page } from "@playwright/test";

// #35 Phase B — the owner-only People panel, end to end.
//
// The suite runs with the forged OWNER session (see e2e/global-setup.ts), so what
// these specs prove is the half jsdom cannot: the panel is really on the page a
// real browser renders, the invite → pending → withdraw round trip really writes
// and un-writes the database through the server actions, and the owner's own row
// really offers no way to lock themselves out.
//
// The guest side of the gate — that a visitor with no account sees none of this —
// lives in guest-unaffected.spec.ts, next to the rest of the guest assertions.

const PEOPLE = "#settings-people";

async function waitForShell(page: Page): Promise<void> {
  await expect(page.getByRole("link", { name: "dlectroflow" })).toBeVisible();
}

/** A throwaway identity, unique per run so a leftover row can't collide. */
function throwawayIdentity(): string {
  return `e2e-invitee-${Date.now()}`;
}

test.describe("People admin (owner)", () => {
  test("the panel leads the settings page and is listed in the nav", async ({
    page,
  }) => {
    await page.goto("/settings");
    await waitForShell(page);

    const heading = page.locator(PEOPLE);
    await expect(heading).toBeVisible();
    // The design puts the Account group at the TOP of /settings.
    const headings = page.locator("h2[data-section-target]");
    await expect(headings.first()).toHaveAttribute("id", "settings-people");

    // …and the section nav lists it, so the anchor is reachable.
    const nav = page.locator('nav[aria-label="Settings sections"]');
    await nav.getByRole("button", { name: /jump to/i }).click();
    await expect(nav.getByRole("link", { name: "People" })).toBeVisible();
  });

  test("says outright that the owner sees numbers, never content", async ({
    page,
  }) => {
    await page.goto("/settings");
    await waitForShell(page);

    await expect(
      page.getByText(/never anyone.s tasks, notes or other content/i),
    ).toBeVisible();
  });

  test("the owner's own row is uncapped and offers no way to revoke themselves", async ({
    page,
  }) => {
    await page.goto("/settings");
    await waitForShell(page);

    const own = page.locator('[data-person-label="e2e-owner"]');
    await expect(own).toBeVisible();
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

    await page.getByLabel(/invite a username or email/i).fill(identity);
    await page.getByLabel(/note \(optional\)/i).fill("e2e throwaway");
    await page.getByRole("button", { name: /send invitation/i }).click();

    // Reported, and the form is cleared ready for the next one.
    await expect(page.getByRole("status")).toContainText(
      new RegExp(`Invited ${identity}`, "i"),
    );
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
        name: new RegExp(`withdraw the invitation for ${identity}`, "i"),
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
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/settings");
    await waitForShell(page);

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

    const panel = page.locator("section").filter({ has: page.locator(PEOPLE) });
    const html = await panel.innerHTML();
    // The design's hard rule, checked against what a browser actually receives:
    // the encrypted column is never even loaded, so its envelope prefix ("v1:")
    // and any key-shaped string must be absent from the delivered markup.
    expect(html).not.toMatch(/v1:/);
    expect(html).not.toMatch(/sk-[A-Za-z0-9]/);
  });
});
