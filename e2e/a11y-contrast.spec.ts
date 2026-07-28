import { test, expect } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import {
  captureItem,
  needsReviewRow,
  setTheme,
  waitForShell,
  THEMES,
} from "./helpers";
import {
  scanColorContrast,
  expectNoContrastViolations,
} from "./a11y/axe-helpers";
import { OWNER_WS_ID } from "./constants";

// Dedicated color-contrast gate for the #40 visual-identity-refresh palette
// (Phase 1.2), covering both themes. Distinct from the broader
// baseline-relative WCAG gate in e2e/a11y/axe-core-flow.spec.ts: this one
// checks only the `color-contrast` rule and asserts ZERO violations, with no
// allowlist — every real contrast issue on these routes must be fixed, not
// grandfathered in.
//
// Everything here runs as the OWNER — the forged storageState in
// playwright.config.ts. The guest-session half of the same gate lives in
// e2e/a11y/axe-guest-surfaces.spec.ts (#90); guest-only UI is never in this
// file's DOM.

// #48 seeding. The Library hub's active tab-count chip only fails as an axe
// *violation* once its count reaches two digits: axe skips single-character
// text as "too short to determine if it is actual text content" (an
// `incomplete` result, not a violation), so a fresh/empty hub — every count
// "0" — can never catch this regression. We seed >=10 triaged, task-less
// brain-dump items (which land in the default "Single-task"/plated tab, see
// libraryBuckets) directly in the owner workspace so the active pill renders a
// 2-digit count and axe actually evaluates its contrast. Seeding via Prisma
// (not the capture UI) keeps it deterministic and fast; items are marked and
// deleted after each scan so the DB stays clean for other specs. The marker is
// scoped per theme so each variant owns its own slice of seeded rows — the
// suite runs serially today (playwright.config.ts: workers 1, fullyParallel
// false) so there is no cross-variant race, but a per-theme marker keeps the
// helpers correct if that ever changes (one variant's cleanup can never delete
// another's data).
const SEED_MARKER = "a11y-lib-pill";
// #56 seeding marker (see seedSavedLaterItem below).
const SAVED_MARKER = "a11y-saved-idle";
// #35 Phase A: seed into the SAME workspace the forged session resolves to.
// Pre-accounts this was the constant "owner"; now the suite has a real account
// (see e2e/global-setup.ts) and its workspace id comes from e2e/constants.ts.
const OWNER_WS = OWNER_WS_ID;

async function seedPlatedItems(
  count: number,
  marker: string,
): Promise<PrismaClient> {
  const prisma = new PrismaClient();
  // Own the client's lifecycle on the seed path too: if either write throws,
  // the caller never receives `prisma` (so its try/finally never disconnects),
  // which would leak the connection. Disconnect-then-rethrow here instead.
  try {
    await prisma.workspace.upsert({
      where: { id: OWNER_WS },
      create: { id: OWNER_WS, kind: "user" },
      update: {},
    });
    await prisma.brainDumpItem.createMany({
      data: Array.from({ length: count }, (_, i) => ({
        text: `${marker} ${i}`,
        status: "triaged", // BrainDumpStatus.Triaged → singleTask/plated bucket
        workspaceId: OWNER_WS,
      })),
    });
  } catch (err) {
    await prisma.$disconnect();
    throw err;
  }
  return prisma;
}

// #56 seeding. The saved-for-later row, in its IDLE state, dimmed the whole
// row with `opacity-70`, which composited the bg-primary "Review now" CTA below
// WCAG-AA (~3.3:1 light / ~3.6:1 dark against its background; needs 4.5:1). The
// fresh-DB scans above can never catch it: a freshly captured item lands in
// Needs-review, never savedLater. So — like the #48 pill — seed the exact state
// the regression needs. An inbox item snoozed into the future lands in the
// savedLater bucket (see bucketItems in src/components/inbox/bucket.ts) and
// renders idle by default, so its dimmed "Review now" CTA is on screen for the
// scan. Seeding via Prisma (not the capture UI) keeps it deterministic; the row
// is deleted after each scan (cleanupSeed) so the DB stays clean for other
// specs. Marker is per-theme so each variant owns its own slice.
async function seedSavedLaterItem(marker: string): Promise<PrismaClient> {
  const prisma = new PrismaClient();
  try {
    await prisma.workspace.upsert({
      where: { id: OWNER_WS },
      create: { id: OWNER_WS, kind: "user" },
      update: {},
    });
    await prisma.brainDumpItem.create({
      data: {
        text: marker,
        status: "inbox", // BrainDumpStatus.Inbox …
        snoozedUntil: new Date(Date.now() + 24 * 3600_000), // … + future snooze → savedLater
        workspaceId: OWNER_WS,
      },
    });
  } catch (err) {
    await prisma.$disconnect();
    throw err;
  }
  return prisma;
}

async function cleanupSeed(
  prisma: PrismaClient,
  marker: string,
): Promise<void> {
  await prisma.brainDumpItem.deleteMany({
    where: { text: { startsWith: marker } },
  });
  await prisma.$disconnect();
}

for (const theme of THEMES) {
  test.describe(`accessibility: color-contrast (axe) — ${theme} mode`, () => {
    test.beforeEach(async ({ page }) => {
      await setTheme(page, theme);
    });

    const STATIC_ROUTES = [
      { path: "/", name: "inbox / capture" },
      { path: "/settings", name: "settings" },
      // #72 — Help now carries the same section nav as Settings (magenta
      // active pill, muted "where am I" hint), so it joins the gate.
      { path: "/help", name: "help" },
      { path: "/focus", name: "focus launcher" },
    ] as const;

    for (const route of STATIC_ROUTES) {
      test(`zero color-contrast violations: ${route.name} (${route.path})`, async ({
        page,
      }) => {
        await page.goto(route.path);
        await waitForShell(page);
        expectNoContrastViolations(await scanColorContrast(page));
      });
    }

    // #48: the Library hub's active tab-count chip. It rendered white
    // `text-primary-foreground` on a translucent `bg-primary-foreground/20`
    // chip over the magenta active tab — the white overlay lightened the bg
    // toward the text, dropping contrast to 3.90:1 (light) / 4.44:1 (dark),
    // both below AA-normal 4.5:1. The fix uses an opaque `bg-primary-foreground`
    // / `text-primary` pairing (5.41:1 / 6.32:1). Seed a 2-digit count so axe
    // evaluates the pill as real text (see seedPlatedItems above), then scan.
    test(`zero color-contrast violations: library hub active tab-count pill (${theme})`, async ({
      page,
    }) => {
      const marker = `${SEED_MARKER}-${theme}`;
      const prisma = await seedPlatedItems(12, marker);
      try {
        // Default hub tab is "Single-task" (plated) — now holding the 12 seeded
        // items, so its active count chip renders "12" (2 digits).
        await page.goto("/library");
        await waitForShell(page);
        const activePill = page.locator(
          'nav[aria-label="Library tabs"] a[aria-current="page"] span.rounded-full',
        );
        // Guard the repro precondition: the active pill must show a >=2-digit
        // count, or axe would skip it as "too short" and the scan would be a
        // no-op that can't catch #48.
        await expect(activePill).toHaveText(/^\d{2,}$/);
        expectNoContrastViolations(await scanColorContrast(page));
      } finally {
        await cleanupSeed(prisma, marker);
      }
    });

    // #56: the saved-for-later row's IDLE "Review now" CTA. The row dimmed
    // itself with `opacity-70`, compositing the bg-primary CTA below AA (~3.3:1
    // light / ~3.6:1 dark; needs 4.5:1). Seed an inbox item snoozed into the
    // future so it lands in savedLater and renders idle (its "Review now" CTA
    // on screen), then scan. The fix moves the dim onto the title line only, so
    // the CTA keeps its full 5.41:1 (light) / 6.32:1 (dark).
    test(`zero color-contrast violations: inbox saved-for-later idle "Review now" CTA (${theme})`, async ({
      page,
    }) => {
      const marker = `${SAVED_MARKER}-${theme}`;
      const prisma = await seedSavedLaterItem(marker);
      try {
        await page.goto("/");
        await waitForShell(page);
        const savedRow = page
          .locator('[data-bucket="savedLater"]')
          .getByRole("listitem")
          .filter({ hasText: marker });
        // Guard the repro precondition: the idle CTA must actually be on screen,
        // or the scan is a no-op that can't catch #56.
        await expect(
          savedRow.getByRole("button", { name: "Review now" }),
        ).toBeVisible();
        expectNoContrastViolations(await scanColorContrast(page));
      } finally {
        await cleanupSeed(prisma, marker);
      }
    });

    // The "Break into steps now?" CTA (bg-destructive + text-destructive-
    // foreground, src/components/inbox/inbox-view.tsx) only renders once an
    // item sits in the Multi-step bucket with 0 steps ("awaitingBreakdown" —
    // see inbox-view.tsx's `awaitingBreakdown = item.stepsTotal === 0`).
    // Drive the real UI path (capture → All options → Move to… → Multi-step
    // to-dos) instead of seeding DB state, so this scan exercises the exact
    // rendered DOM the dark-mode AA fix targets — in dark mode, white text on
    // --destructive was 3.52:1 (fails AA-normal 4.5:1); the fix swaps in the
    // --destructive-foreground token (near-black in dark, white in light).
    // We deliberately do NOT click the CTA itself — that starts the AI
    // breakdown flow, which needs ANTHROPIC_API_KEY (unavailable in this
    // e2e env, same constraint documented in e2e/a11y/axe-core-flow.spec.ts).
    test(`zero color-contrast violations: inbox "Break into steps now?" CTA (${theme})`, async ({
      page,
    }) => {
      const label = `A11y contrast destructive-cta ${theme} ${Date.now()}`;
      await page.goto("/");
      await waitForShell(page);
      await captureItem(page, label);

      const row = needsReviewRow(page, label);
      await expect(row).toBeVisible();
      await row.getByRole("button", { name: "All options" }).click();
      await row.getByRole("button", { name: "Move to…" }).click();
      await row.getByRole("menuitem", { name: /Multi-step/ }).click();

      const multiStepRow = page
        .locator('[data-bucket="multiStep"]')
        .getByRole("listitem")
        .filter({ hasText: label });
      await expect(
        multiStepRow.getByRole("button", { name: "Break into steps now?" }),
      ).toBeVisible();

      expectNoContrastViolations(await scanColorContrast(page));
    });

    // NOT covered here, deliberately: the settings "Yes, disconnect" confirm
    // CTA (src/components/settings/integrations-panel.tsx) — also
    // bg-destructive + text-destructive-foreground, same token pairing fixed
    // above — only renders when Google Tasks is both configured AND
    // connected (`canDisconnect = google.connected`). The e2e boot env (see
    // bootGuardEnv in playwright.config.ts) sets no GOOGLE_CLIENT_ID/SECRET,
    // so `google.configured` is always false here and IntegrationsPanel never
    // renders a Disconnect control at all — reaching the confirm state would
    // need a live OAuth connection seeded in the DB, out of scope for this
    // gate. It shares the exact same --destructive / --destructive-foreground
    // pairing as the inbox CTA above, so the fix verified there applies here
    // too.
  });
}
