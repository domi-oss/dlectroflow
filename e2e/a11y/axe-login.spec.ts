import { test, expect } from "@playwright/test";
import { scanA11y } from "./axe-helpers";

// #263 — /login had NO accessibility scan of ANY kind.
//
// `/settings` (see `axe-settings.spec.ts`) was contrast-scanned but never
// WCAG-tag scanned. `/login` was worse: neither gate reached it. Grepping the
// whole `e2e/` tree for the route finds one `goto` in
// `e2e/smoke/legal-pages.spec.ts`, asserting a redirect target rather than
// scanning anything, and no `scanA11y` or `scanColorContrast` call at all.
//
// That is the sign-in page — the first page a new owner sees, and the only page
// an unauthenticated visitor is sent to. Every other spec in the suite carries
// the forged owner storageState from `e2e/global-setup.ts`, so this route's DOM
// had never once been in a scanned page, the same structural blind spot #90
// closed for guest chrome and #73 was the cost of.
//
// Measured when this file was added, so the coverage is recorded as additive
// rather than assumed: 63 rules evaluated, `target-size` reporting in `passes`
// over 4 nodes, zero serious/critical violations and zero contrast violations.
//
// No storageState, deliberately — and here it is load-bearing rather than
// merely realistic. `/login` is in PUBLIC_PREFIXES (`src/lib/auth/gate.ts`), and
// a context carrying the forged owner cookie is REDIRECTED AWAY from it by
// `src/proxy.ts`, so inheriting the default session would scan the inbox and
// report green for a page nothing looked at. The heading assertion below is what
// makes that failure loud instead of silent.
test.use({
  storageState: { cookies: [], origins: [] },
  contextOptions: { reducedMotion: "reduce" },
});

test("no new serious/critical violations: /login", async ({ page }) => {
  await page.goto("/login");

  // The precondition, not decoration: a signed-in context or a middleware change
  // that put this route behind the gate would leave `goto` on a DIFFERENT page
  // returning 200, and the scan below would pass while covering nothing. Asserted
  // on the h1 rather than the URL because a client-side redirect can leave the
  // URL behind for a moment; the heading is what proves the page rendered.
  await expect(
    page.getByRole("heading", { level: 1, name: "Owner sign-in" }),
  ).toBeVisible();

  await scanA11y(page, "/login");
});
