import { test, expect, type Page } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import { MOBILE, setTheme, waitForShell } from "../helpers";
import { OWNER_WS_ID } from "../constants";

// #105 — the inbox must hydrate the server's markup, not throw it away.
//
// `formatAgo()` has SECOND granularity under a minute, and InboxView used to
// seed its live clock during render. The server stamped one second and the
// browser stamped the next, so every row younger than a minute rendered "Ns
// ago" twice from two clocks. React resolves a TEXT mismatch (minified error
// #418) by discarding the server tree and re-rendering from the ROOT — which
// rebuilds <html>'s class list out of the RSC payload, and the payload never
// carries the `dark` that the pre-hydration <head> script wrote. A returning
// dark-mode user opened the inbox and watched the theme fall off.
//
// The deterministic proof lives in src/components/inbox/inbox-view.hydration.
// test.tsx, which stubs the two clocks explicitly. THIS spec is the other half:
// the same claim against a REAL production build, where React is minified, the
// markup is streamed, and hydration competes with everything else on the main
// thread. jsdom cannot answer that, and #103 already learned the hard way that
// jsdom and `next build` disagree about what actually reaches the DOM.
//
// CPU throttling is how the window gets wide enough to be certain rather than
// lucky: the filed measurement was 6/6 reloads keeping dark at 1x, 3/6 at 10x,
// and 0/6 at 20x, with a #418 on every lost reload. So this runs at 20x — the
// setting at which the bug was a certainty, not a flake. A mid-range phone or a
// loaded CI runner is the real-world version of it.

const SEED_MARKER = "hydration-105";

/** Enough fresh rows that at least one is mid-second on any given reload. */
const SEED_COUNT = 6;

/** The throttle at which the unfixed inbox lost dark mode on every reload. */
const CPU_THROTTLE_RATE = 20;

/** Reloads per run. Unfixed, this failed on the first one at 20x. */
const RELOADS = 4;

/**
 * React's hydration bailouts, as they appear in a PRODUCTION bundle: the message
 * text is stripped, so what surfaces is the numbered form plus the docs link.
 * 418 is the text mismatch this issue is about; 422/423/425 are the neighbouring
 * hydration-recovery codes, included so a different bailout on this route cannot
 * pass by not being the one we named.
 */
const HYDRATION_ERROR =
  /Minified React error #(418|422|423|425)|react\.dev\/errors\/(418|422|423|425)|[Hh]ydration failed/;

async function seedFreshRows(marker: string): Promise<PrismaClient> {
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
        // Untriaged → the Needs-review bucket, whose rows render <AgeLabel>:
        // the "Ns ago" text that is the mismatch.
        status: "inbox",
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
 * Put the seeded rows back into the sub-minute band. The repro needs an age that
 * formatAgo renders in SECONDS; a throttled reload takes long enough that rows
 * seeded once would drift past a minute part-way through the loop and quietly
 * stop testing anything.
 */
async function refreshAges(prisma: PrismaClient, marker: string) {
  await prisma.brainDumpItem.updateMany({
    where: { workspaceId: OWNER_WS_ID, text: { startsWith: marker } },
    data: { createdAt: new Date() },
  });
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

/** The header's theme control, located the way an AT user reaches it (#103). */
const themeToggle = (page: Page) =>
  page
    .locator("header")
    .getByRole("button", { name: /^switch to (dark|light) mode$/i });

/**
 * `dark` is applied before React runs and removed (if at all) after it takes
 * over, so a single read can pass while the page is still on its way to being
 * wrong — which is exactly how this shipped. Sample repeatedly and require every
 * sample to hold.
 */
async function expectThemeHolds(page: Page, samples = 10, everyMs = 200) {
  const seen: boolean[] = [];
  for (let i = 0; i < samples; i++) {
    seen.push(
      await page.evaluate(() =>
        document.documentElement.classList.contains("dark"),
      ),
    );
    await page.waitForTimeout(everyMs);
  }
  expect(
    seen,
    `html.dark was dropped after hydration (samples: ${seen.join(",")})`,
  ).toEqual(Array(samples).fill(true));
}

test.describe("#105 the inbox hydrates without discarding the server tree", () => {
  test.use({ viewport: MOBILE });

  test("a preloaded dark theme survives loading / with fresh sub-minute rows, throttled", async ({
    page,
  }) => {
    const marker = `${SEED_MARKER} dark`;
    const prisma = await seedFreshRows(marker);
    try {
      // Both channels: React reports a recoverable error through
      // `reportError` (a window error event → `pageerror`), and anything that
      // reaches console.error is collected too, so neither routing can hide it.
      const errors: string[] = [];
      page.on("pageerror", (e) => errors.push(e.message));
      page.on("console", (m) => {
        if (m.type() === "error") errors.push(m.text());
      });

      await setTheme(page, "dark");
      const cdp = await page.context().newCDPSession(page);
      await cdp.send("Emulation.setCPUThrottlingRate", {
        rate: CPU_THROTTLE_RATE,
      });

      for (let i = 0; i < RELOADS; i++) {
        await refreshAges(prisma, marker);
        await page.goto("/");
        await waitForShell(page);

        // Guard the repro precondition. Without a row whose age is rendered in
        // SECONDS there is nothing for the two clocks to disagree about, and a
        // green run would mean nothing.
        // ("captured Ns ago" — the whole <p> AgeLabel renders. Matched on the
        // rendered text rather than a class hook so it fails loudly if the label
        // ever loses its second granularity, which would make this spec moot.)
        await expect(
          page.getByText(/^captured \d{1,2}s ago$/).first(),
          "no sub-minute row on screen — the repro precondition is gone",
        ).toBeVisible();

        // Hydration has definitely happened once the control re-labels itself:
        // it renders from the `dark` class on <html>, and its SERVER snapshot is
        // light (see getServerSnapshot in theme-toggle.tsx), so this string can
        // only come from a client render that saw the class.
        await expect(themeToggle(page)).toHaveAccessibleName(
          "Switch to light mode",
        );

        // …and it is still there a moment later. This is the assertion the bug
        // fails: the filed repro passed the label check and then found
        // html.dark === false, because the class is removed AFTER hydration, by
        // the regeneration — not by a theme that never applied.
        await expectThemeHolds(page);
      }

      expect(
        errors.filter((e) => HYDRATION_ERROR.test(e)),
        "React bailed out of hydration on / (this is #105)",
      ).toEqual([]);
    } finally {
      await cleanupSeed(prisma, marker);
    }
  });
});
