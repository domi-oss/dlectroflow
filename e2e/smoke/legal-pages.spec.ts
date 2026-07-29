import { test, expect } from "@playwright/test";
import { LEGAL_CONTACT_EMAIL } from "../../src/lib/legal";

// #123 — the legal pages, end to end, as a complete stranger sees them.
//
// This is the spec that stands in for Google's OAuth verification reviewer. They
// fetch https://dlectroflow.dev/privacy with no cookies, follow no sign-in, and
// if they meet a login wall the consent screen is rejected — with nothing in the
// app looking broken and no unit test failing.
//
// src/proxy.test.ts already asserts the middleware decision in isolation. This
// asserts the whole stack agrees: the route exists, it is served by the real
// standalone server, the middleware lets it through, the page renders, and the
// footer link a reviewer needs is genuinely clickable.
//
// No storageState: the config default is the forged OWNER session, which would
// make "reachable without signing in" untestable here.
test.use({ storageState: { cookies: [], origins: [] } });

const LEGAL_ROUTES = [
  { path: "/privacy", heading: "Privacy Policy", title: /Privacy Policy/ },
  { path: "/terms", heading: "Terms of Service", title: /Terms of Service/ },
] as const;

test.describe("legal pages are public", () => {
  for (const route of LEGAL_ROUTES) {
    test(`${route.path} serves 200 to a request with no cookies at all`, async ({
      page,
      context,
    }) => {
      expect(
        await context.cookies(),
        "this spec must start with no cookies to mean anything",
      ).toEqual([]);

      const response = await page.goto(route.path);

      // Status AND url: a redirect to /login would also render a page and could
      // still report 200 after following, so the final URL is the real assertion.
      expect(response?.status()).toBe(200);
      expect(new URL(page.url()).pathname).toBe(route.path);
      await expect(
        page.getByRole("heading", { level: 1, name: route.heading }),
      ).toBeVisible();
    });

    test(`${route.path} sets no guest sandbox cookie`, async ({
      page,
      context,
    }) => {
      // A public path returns before the guest-minting branch in src/proxy.ts.
      // Reading the privacy policy should not create a workspace for you — and the
      // policy itself says the guest cookie is set when you *use* the app.
      await page.goto(route.path);
      const names = (await context.cookies()).map((c) => c.name);
      expect(names).not.toContain("df_guest");
      expect(names).not.toContain("df_owner");
    });

    test(`${route.path} carries its own page title`, async ({ page }) => {
      // A reviewer arrives on a bare URL; the tab title is the only context they
      // get before reading. Without per-page metadata this would inherit the root
      // layout's plain "dlectroflow".
      await page.goto(route.path);
      await expect(page).toHaveTitle(route.title);
    });
  }

  test("the privacy policy publishes a working contact route", async ({
    page,
  }) => {
    await page.goto("/privacy");
    await expect(
      page.getByRole("link", { name: LEGAL_CONTACT_EMAIL }).first(),
    ).toHaveAttribute("href", `mailto:${LEGAL_CONTACT_EMAIL}`);
  });
});

test.describe("legal pages are reachable from the app", () => {
  // Google requires the policy to be LINKED from the app, not merely to exist.
  // The footer is that link, so it is worth clicking rather than trusting.
  test("the footer link on the app shell reaches the privacy policy", async ({
    page,
  }) => {
    await page.goto("/");
    await page.getByRole("link", { name: "Privacy" }).click();
    await expect(
      page.getByRole("heading", { level: 1, name: "Privacy Policy" }),
    ).toBeVisible();
  });

  test("the footer link on the sign-in page reaches the terms", async ({
    page,
  }) => {
    await page.goto("/login");
    await page.getByRole("link", { name: "Terms" }).click();
    await expect(
      page.getByRole("heading", { level: 1, name: "Terms of Service" }),
    ).toBeVisible();
  });

  test("each legal page links to the other", async ({ page }) => {
    await page.goto("/privacy");
    await page.getByRole("link", { name: "Terms" }).click();
    await expect(
      page.getByRole("heading", { level: 1, name: "Terms of Service" }),
    ).toBeVisible();

    await page.getByRole("link", { name: "Privacy" }).first().click();
    await expect(
      page.getByRole("heading", { level: 1, name: "Privacy Policy" }),
    ).toBeVisible();
  });
});
