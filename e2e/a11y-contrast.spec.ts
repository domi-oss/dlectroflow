import { test, expect } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import {
  captureItem,
  needsReviewRow,
  setTheme,
  waitForShell,
  expandAllSections,
  THEMES,
  ROW_MENU_ADD_TODO,
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
// #95 seeding marker (see seedAgedPlatedItem below).
const AGED_MARKER = "a11y-lib-aged";
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

// #95 seeding. The Library row's "added Xh ago" label only turns amber once
// `isAging()` is true (src/lib/aging.ts — age >= agingThresholdMinutes, default
// 240). CI's database is recreated every run, so no row is ever old enough and
// BOTH /library a11y gates pass while the amber state is broken: a gated route
// with an ungated state, the same blind spot as #48/#56/#89. Backdating
// `createdAt` puts that state inside the gate's reach. 13h is deliberately
// between the aging threshold (4h) and the 24h "still needed?" prompt boundary
// (shouldPrompt24h), so the row renders aging and nothing else changes.
async function seedAgedPlatedItem(marker: string): Promise<PrismaClient> {
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
        status: "triaged", // BrainDumpStatus.Triaged → singleTask/plated bucket
        createdAt: new Date(Date.now() - 13 * 3600_000), // > 4h aging, < 24h prompt
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

    // #101 — /settings is now nine disclosures with one open, so the scan above
    // sees nine triggers and one section's worth of controls. Everything else is
    // behind a `hidden` attribute, which axe correctly skips: without this second
    // pass the gate would be quietly narrower than the one it replaced. Same
    // lesson as #90, arrived at from the other direction.
    test(`zero color-contrast violations: settings with every section expanded (${theme})`, async ({
      page,
    }) => {
      await page.goto("/settings");
      await waitForShell(page);
      await expandAllSections(page);
      expectNoContrastViolations(await scanColorContrast(page));
    });

    // #100: the header's identity popover. New signed-in chrome, and CLOSED by
    // default — so the route scans above see only its trigger, never the popup's
    // muted "Owner · signed in with GitLab" line or its two entries. A popup axe
    // never opens is a popup this gate does not cover, which is the #90/#101
    // lesson twice over. The identity line is the risk: `text-muted-foreground`
    // at `text-xs` over the popup's own `bg-background`, i.e. exactly the
    // small-muted-text pairing that shipped #56 and #73 below AA.
    test(`zero color-contrast violations: header identity popover open (${theme})`, async ({
      page,
    }) => {
      // /help, not the inbox: the header is byte-identical everywhere and /help
      // holds still (no live clock re-render, #105), so the popup cannot be
      // scanned mid-remount.
      await page.goto("/help");
      await waitForShell(page);
      await page
        .locator("header")
        .getByRole("button", { name: /^Account: / })
        .click();
      await expect(page.getByRole("dialog", { name: "Account" })).toBeVisible();
      expectNoContrastViolations(await scanColorContrast(page));
    });

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

    // #95: the Library row's aging "added Xh ago" label. It rendered a flat
    // `text-amber-600` (#e17100) — 3.01:1 on the light --background (#fdf6fa) at
    // 12px, where AA-normal needs 4.5:1 — with no dark variant at all. The fix
    // adopts the amber pair #57 already settled on for the identical `aging`
    // semantic (status-pill.tsx's FRESHNESS_TIER_STYLE): amber-700 in light
    // (4.73:1), amber-400 in dark (11.40:1). Seed a backdated row so the amber
    // state actually exists during the scan (see seedAgedPlatedItem).
    test(`zero color-contrast violations: library hub aging row age label (${theme})`, async ({
      page,
    }) => {
      const marker = `${AGED_MARKER}-${theme}`;
      const prisma = await seedAgedPlatedItem(marker);
      try {
        // Default hub tab is "Single-task" (plated), which is where a triaged,
        // task-less item lands and the only tab that renders AgeLabel per row.
        await page.goto("/library");
        await waitForShell(page);
        const row = page.getByRole("listitem").filter({ hasText: marker });
        await expect(row).toBeVisible();
        // Guard the repro precondition: the label must be in its AMBER state, or
        // this scan is a no-op that cannot catch #95. Matched loosely on the
        // amber family so the guard survives the weight change it is guarding.
        await expect(row.getByText(/^added /)).toHaveClass(/text-amber-/);
        expectNoContrastViolations(await scanColorContrast(page));
      } finally {
        await cleanupSeed(prisma, marker);
      }
    });

    // #99: the live focus session's two green confirm CTAs (white on
    // `bg-green-600` = 3.22:1, AA-normal needs 4.5:1). The *setup* screen was
    // gated all along, but the running session is a different surface with its
    // own control set — #89 added it to the baseline-relative gate
    // (e2e/a11y/axe-core-flow.spec.ts), which runs in one theme only. The bug
    // was present in BOTH themes, so the zero-tolerance both-themes gate is
    // where it belongs. Triage a fresh item into a single to-do, start focusing,
    // and scan the running controls.
    test(`zero color-contrast violations: running focus session controls (${theme})`, async ({
      page,
    }) => {
      const label = `A11y contrast focus-run ${theme} ${Date.now()}`;
      await page.goto("/");
      await waitForShell(page);
      await captureItem(page, label);

      const row = needsReviewRow(page, label);
      await expect(row).toBeVisible();
      // #253 — Add to-do moved off the row into its ▾ list, under the full label.
      await row.getByRole("button", { name: "All options" }).click();
      await row.getByRole("button", { name: ROW_MENU_ADD_TODO }).click();

      const todoRow = page
        .locator('[data-bucket="singleTask"]')
        .getByRole("listitem")
        .filter({ hasText: label });
      await expect(todoRow).toBeVisible();
      await todoRow.getByRole("button", { name: /Start Focus/ }).click();

      await page.waitForURL("**/focus/**");
      await waitForShell(page);
      await page.getByRole("button", { name: "Start focusing" }).click();
      // Guard the repro precondition: the green CTA must be on screen, or the
      // scan is a no-op that cannot catch #99.
      const completeStep = page.getByRole("button", {
        name: /complete step/i,
      });
      await expect(completeStep).toBeVisible();
      expectNoContrastViolations(await scanColorContrast(page));

      // #181 — the playlist/jump panel is state-dependent chrome that is only
      // painted once it is expanded, which is exactly the shape #109 kept
      // shipping green. Its playing-track row is a token pair on a tinted
      // background, and a token pair on a tint is the one thing
      // a11y-class-hygiene says it cannot measure — so it is measured here, in
      // both themes, at zero tolerance.
      const panelToggle = page.getByRole("button", {
        name: "Playlists and tracks",
      });
      await expect(panelToggle).toBeVisible();
      await panelToggle.click();
      // Guard the repro precondition: the row that carries the tint must be on
      // screen, or this scan is a no-op that cannot see the thing it is for.
      await expect(page.locator("[aria-current='true']").first()).toBeVisible();
      expectNoContrastViolations(await scanColorContrast(page));
    });

    // The "Break into steps now?" CTA (bg-destructive + text-destructive-
    // foreground, src/components/inbox/inbox-view.tsx) only renders once an
    // item sits in the Multi-step bucket with 0 steps ("awaitingBreakdown" —
    // see inbox-view.tsx's `awaitingBreakdown = item.stepsTotal === 0`).
    // Drive the real UI path instead of seeding DB state, so this scan exercises the
    // exact rendered DOM the dark-mode AA fix targets — in dark mode, white text on
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

      // ⚠️ #253 — two hops rather than one, and the reason is a real behavioural
      // difference rather than a longer path for its own sake. The nested "Move to…"
      // picker is gone, so `requestBreakdown` — the write that PARKS a row in
      // Multi-step with this CTA instead of navigating into the editor — is reached
      // from a SINGLE-TASK row's ▾. On a Needs-review row the same label runs
      // `startBreakdown`, which opens the editor and would never render the CTA at
      // all. So: capture → Add as single-task to-do → Add as multi-step to-do.
      const row = needsReviewRow(page, label);
      await expect(row).toBeVisible();
      await row.getByRole("button", { name: "All options" }).click();
      await row.getByRole("button", { name: ROW_MENU_ADD_TODO }).click();

      const singleTaskRow = page
        .locator('[data-bucket="singleTask"]')
        .getByRole("listitem")
        .filter({ hasText: label });
      await expect(singleTaskRow).toBeVisible();
      await singleTaskRow.getByRole("button", { name: "All options" }).click();
      await singleTaskRow
        .getByRole("button", { name: "Add as multi-step to-do" })
        .click();

      const multiStepRow = page
        .locator('[data-bucket="multiStep"]')
        .getByRole("listitem")
        .filter({ hasText: label });
      await expect(
        multiStepRow.getByRole("button", { name: "Break into steps now?" }),
      ).toBeVisible();

      expectNoContrastViolations(await scanColorContrast(page));
    });

    // NOT covered here: the settings "Yes, disconnect" confirm CTA
    // (src/components/settings/integrations-panel.tsx) — also bg-destructive +
    // text-destructive-foreground, the same token pairing fixed above — only
    // renders when Google Tasks is both configured AND connected
    // (`canDisconnect = google.connected`). THIS project's boot env (see
    // bootGuardEnv in playwright.config.ts) sets no GOOGLE_CLIENT_ID/SECRET, so
    // `google.configured` is false here and IntegrationsPanel renders no
    // Disconnect control at all.
    //
    // #118 Phase C made it reachable, in the `member` project: that
    // server has a dummy Google client and global-setup seeds the member an
    // encrypted credential, so e2e/smoke/member-google.spec.ts opens the confirm
    // state and measures the CTA's touch target at 390px. It still shares the
    // exact --destructive / --destructive-foreground pairing as the inbox CTA
    // above, so the contrast fix verified there applies to it as well.
  });
}
