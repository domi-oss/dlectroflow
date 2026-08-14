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
 * Extra wall-clock time to burn inside every iteration, between the navigation
 * and the assertions that read the page. Zero by default, so CI behaviour is
 * unchanged; it exists so #193's close condition is a command anyone can run
 * rather than a state a runner has to happen to be in:
 *
 *   E2E_HYDRATION_SLOW_RUNNER_MS=65000 npm run test:e2e -- \
 *     --project=chromium --no-deps e2e/smoke/inbox-hydration.spec.ts
 *
 * 65 000 is chosen to put ONE iteration past 60 s, which is where `formatAgo`
 * stops rendering seconds and starts rendering minutes — the boundary #193 is
 * about. It is deliberately a plain wait rather than a higher
 * `CPU_THROTTLE_RATE`: the throttle is load-bearing evidence (see the header)
 * and must not be dialled around, and what this spec is sensitive to is ELAPSED
 * TIME between the server's render and the assertion that reads it, which is
 * exactly what a wait reproduces. A loaded CI runner spends that time doing
 * work; the effect on this spec is identical.
 */
const SLOW_RUNNER_MS = readSlowRunnerMs();

function readSlowRunnerMs(): number {
  const raw = process.env.E2E_HYDRATION_SLOW_RUNNER_MS;
  if (raw === undefined || raw.trim() === "") return 0;
  const ms = Number(raw);
  // Fail at collection time rather than silently running unslowed: a typo here
  // would make the close condition report a green that proves nothing, which is
  // the failure class this whole spec exists to avoid.
  if (!Number.isFinite(ms) || ms < 0) {
    throw new Error(
      `E2E_HYDRATION_SLOW_RUNNER_MS must be a non-negative number of milliseconds; got ${JSON.stringify(raw)}`,
    );
  }
  return ms;
}

/**
 * The theme sampling window — see `expectThemeHolds`. Named constants rather
 * than default parameters because the test's own time budget is DERIVED from
 * them below: `samples × everyMs` is time this test spends deliberately doing
 * nothing, on every iteration, and a budget that did not count it would go
 * stale the moment either number changed.
 */
const THEME_SAMPLES = 10;
const THEME_SAMPLE_EVERY_MS = 200;

/**
 * How long ONE throttled `/` load is allowed to take before its assertion gives
 * up — the navigation, the stream, and React hydrating the whole board at
 * `CPU_THROTTLE_RATE`.
 *
 * Playwright's default is 5 s, and that is what this spec ran on until #193.
 * 5 s of a 20x-throttled main thread is ~250 ms of unthrottled work, which is
 * not enough to hydrate this route on a runner that is also hosting Postgres and
 * two standalone Next servers. That is the FIRST of the two failures in
 * `e2e_test` #15771333861 (2026-08-07, `main`): the hydration check timed out at
 * 5 s having resolved the toggle nine times, every time still reading the
 * server's "Switch to dark mode".
 *
 * 20 s is ~4x the cost that runner actually incurred, and it does not weaken the
 * assertion: a genuine #105 regression drops `html.dark` and re-labels the
 * toggle back, so it fails on VALUE and reports in milliseconds. Only a slow
 * runner spends the extra time.
 */
const HYDRATION_TIMEOUT_MS = 20_000;

/**
 * The per-iteration allowance the test's own timeout is built from: one throttled
 * load, the hydration check above, and the precondition read.
 *
 * The second of the two 2026-08-07 failures was `Test timeout of 30000ms
 * exceeded` — Playwright's DEFAULT, which this spec never overrode. Four
 * throttled page loads plus `RELOADS × THEME_SAMPLES × THEME_SAMPLE_EVERY_MS`
 * (8 s, over a quarter of the whole budget) do not fit in 30 s on a loaded
 * runner, and the failure lands on whichever assertion happens to be in flight
 * — which is how #193 came to be filed against the precondition. Measured here
 * for scale: ~3.5 s per iteration on an idle developer machine.
 *
 * Deliberately an upper ENVELOPE, not a target. Every assertion inside the loop
 * carries its own timeout, so a real regression still fails in seconds; this
 * number only decides how long a comprehensively wedged run is allowed to hang
 * before the runner reclaims it.
 */
const ITERATION_BUDGET_MS = 30_000;

/** Seeding, the theme bootstrap, the CDP session and teardown. */
const SETUP_BUDGET_MS = 30_000;

/**
 * Derived, never hard-coded: `RELOADS`, the sampling window and the opt-in slow
 * runner all move this number, and a budget that has to be re-derived by hand is
 * a budget that silently stops matching the work.
 */
const TEST_TIMEOUT_MS =
  SETUP_BUDGET_MS +
  RELOADS *
    (ITERATION_BUDGET_MS +
      THEME_SAMPLES * THEME_SAMPLE_EVERY_MS +
      SLOW_RUNNER_MS);

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

/**
 * Every `captured … ago` label in a served HTML document, in document order.
 *
 * Two details make this a whole-element read rather than a substring search, and
 * both were verified against the real streamed response before being relied on:
 *
 *  * React separates adjacent text children with an EMPTY COMMENT, so `AgeLabel`
 *    streams as `<p …>captured <!-- -->0s ago</p>`, and the label text is not
 *    contiguous in the bytes. Only that exact comment form is removed, so nothing
 *    else in the document is altered by the normalisation.
 *  * Anchoring on `>` and `<` requires the match to be an element's ENTIRE text,
 *    which is what the old DOM locator's `^…$` gave. It matters: `/` also serves
 *    the prose "Everything you have captured lives in your Library", and a
 *    substring search would count it. The measured response carries seven
 *    occurrences of "captured" for six rows — that sentence is the seventh.
 *
 * The unit is captured rather than assumed so the caller can tell "the server
 * rendered minutes" (precondition genuinely absent) apart from "there is no label
 * at all" (the row metadata line is gone) and report the difference.
 */
const SERVED_AGE_LABEL = />captured (\d+)([smhd]) ago</g;
const REACT_TEXT_SEPARATOR = /<!--\s*-->/g;

function servedAgeLabels(html: string): { value: number; unit: string }[] {
  return [
    ...html.replace(REACT_TEXT_SEPARATOR, "").matchAll(SERVED_AGE_LABEL),
  ].map(([, value, unit]) => ({ value: Number(value), unit }));
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
async function expectThemeHolds(
  page: Page,
  samples = THEME_SAMPLES,
  everyMs = THEME_SAMPLE_EVERY_MS,
) {
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
    test.setTimeout(TEST_TIMEOUT_MS);
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
        const nav = await page.goto("/");
        // The markup hydration has to match, captured at the instant it was
        // served — read here, before anything is allowed to elapse, because that
        // is the whole point (#193).
        expect(nav, "the navigation to / returned no response").not.toBeNull();
        const servedHtml = await nav!.text();
        await waitForShell(page);
        if (SLOW_RUNNER_MS > 0) await page.waitForTimeout(SLOW_RUNNER_MS);

        // Guard the repro precondition. Without a row whose age is rendered in
        // SECONDS there is nothing for the two clocks to disagree about, and a
        // green run would mean nothing.
        //
        // #193 — asserted against WHAT THE SERVER SENT, not against the live
        // DOM. `AgeLabel` re-renders off a `setInterval`, so the label on screen
        // is a reading of the CLIENT's clock at the moment the assertion happens
        // to run, while the precondition is a claim about the moment the SERVER
        // rendered the markup. Those were the same instant only while a
        // throttled reload stayed under `formatAgo`'s 60 s boundary; past it
        // every row reads "captured 1m ago" and the guard failed with its own
        // message on a spec that was working perfectly. Measured on this branch:
        // one throttled load then 65 s gave dom=["captured 1m ago", ...x6] and
        // zero matches for the old locator, while the served markup still read
        // [0,0,0,0,0,0]. The served bytes are a frozen artefact, so this is now
        // time-independent by construction rather than by being fast enough.
        const servedAges = servedAgeLabels(servedHtml);
        expect(
          servedAges.map(({ value, unit }) => `${value}${unit}`),
          `fewer than the ${SEED_COUNT} seeded rows carried an age label in the markup the server sent — the repro precondition never existed on this reload, so nothing below is evidence about hydration`,
        ).toHaveLength(SEED_COUNT);
        // Second granularity is the precondition itself: `formatAgo` renders
        // whole seconds only under a minute, and that is the only band in which
        // two clocks a tick apart produce two different strings. Asserted on the
        // rendered text rather than a class hook so it also fails loudly if the
        // label ever loses that granularity, which would make this spec moot.
        expect(
          servedAges.filter(({ unit }) => unit !== "s"),
          "the server rendered a coarser-than-seconds age — nothing for the two clocks to disagree about",
        ).toEqual([]);
        // The rows in the markup are OURS. Six fresh labels could in principle
        // come from someone else's fixture; the seeded text pins them.
        for (let row = 0; row < SEED_COUNT; row++) {
          expect(
            servedHtml,
            `seeded row "${marker} ${row}" is missing from the served markup`,
          ).toContain(`${marker} ${row}`);
        }
        // …and the labels really are on screen, which the served bytes cannot
        // tell you. Granularity-agnostic on purpose: the band is asserted above,
        // at the only instant it is meaningful, and repeating it here is exactly
        // what made this spec time-dependent.
        await expect(
          page.getByText(/^captured \d+[smhd] ago$/).first(),
          "no captured-age label on screen — the row metadata line is gone",
        ).toBeVisible({ timeout: HYDRATION_TIMEOUT_MS });

        // Hydration has definitely happened once the control re-labels itself:
        // it renders from the `dark` class on <html>, and its SERVER snapshot is
        // light (see getServerSnapshot in theme-toggle.tsx), so this string can
        // only come from a client render that saw the class.
        await expect(themeToggle(page)).toHaveAccessibleName(
          "Switch to light mode",
          // Not the default 5 s — hydrating this route at CPU_THROTTLE_RATE on a
          // loaded runner exceeded it, which is one half of #193.
          { timeout: HYDRATION_TIMEOUT_MS },
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
