import { expect, type Page } from "@playwright/test";

// Shared across the smoke specs: the capture bar's placeholder text, the
// capture-then-Enter step it takes to create a brain-dump item, and the
// Needs-review row locator specs assert on right after capturing. Kept
// minimal — only what's genuinely repeated across specs; anything that
// diverges (e.g. the single-task row lookups) stays local to its spec.
export const CAPTURE_PLACEHOLDER = "Brain dump anything… (Enter to save)";

// Capture a brain-dump item. The capture bar has no submit button — Enter
// saves it. Callers assert on the resulting row themselves.
export async function captureItem(page: Page, label: string): Promise<void> {
  const capture = page.getByPlaceholder(CAPTURE_PLACEHOLDER);
  await capture.fill(label);
  await capture.press("Enter");
}

// Locate a captured item's row in the Needs review bucket by its label.
export function needsReviewRow(page: Page, label: string) {
  return page
    .locator('[data-bucket="needsReview"]')
    .getByRole("listitem")
    .filter({ hasText: label });
}

// ── Shared viewports / theme / shell helpers ────────────────────────────────
// Extracted for #90: the guest axe pass needs the same two viewports, the same
// theme bootstrap and the same "is the shell rendered?" wait that
// e2e/smoke/section-nav.spec.ts and e2e/a11y-contrast.spec.ts had each grown
// their own copy of. One definition, so a fix lands everywhere.

export const MOBILE = { width: 390, height: 844 }; // iPhone 14-ish
export const DESKTOP = { width: 1280, height: 900 };

export type Theme = "light" | "dark";
export const THEMES: readonly Theme[] = ["light", "dark"];

/**
 * Sets df-theme in localStorage before the app's own scripts run, matching the
 * inline bootstrap in src/app/layout.tsx (`localStorage.getItem('df-theme') ===
 * 'dark'`) and the toggle in src/components/theme-toggle.tsx. addInitScript
 * re-runs on every subsequent navigation in this page, so it survives
 * page.goto() calls after this — but it must be called BEFORE the first goto.
 */
export async function setTheme(page: Page, theme: Theme): Promise<void> {
  await page.addInitScript((value: Theme) => {
    try {
      localStorage.setItem("df-theme", value);
    } catch {
      /* private mode etc. — matches the app's own best-effort persistence */
    }
  }, theme);
}

/**
 * Guard the precondition of any theme-scoped assertion: a silently-light "dark"
 * scan is worse than no scan, because it looks like it was checked.
 */
export async function expectThemeApplied(
  page: Page,
  theme: Theme,
): Promise<void> {
  expect(
    await page.evaluate(() =>
      document.documentElement.classList.contains("dark"),
    ),
    `expected the ${theme} theme to be applied (html.dark = ${theme === "dark"})`,
  ).toBe(theme === "dark");
}

/**
 * Wait for the always-present app shell (the brand link in the shared header)
 * so assertions and axe scans see a fully-rendered page, not a hydrating one.
 */
export async function waitForShell(page: Page): Promise<void> {
  await expect(page.getByRole("link", { name: "dlectroflow" })).toBeVisible();
}

// ── #101: every /settings section is a disclosure ───────────────────────────

/**
 * One section's disclosure trigger, by the stable hook `<SectionHeading>` puts on
 * it. Located by attribute rather than by accessible name on purpose: the name is
 * now the section's title, which the "Jump to…" nav also renders as a link, so a
 * by-name locator would be ambiguous.
 */
export function sectionToggle(page: Page, id: string) {
  return page.locator(`[data-section-toggle="${id}"]`);
}

/** Open one section and wait for its body to actually be on screen. */
export async function expandSection(page: Page, id: string): Promise<void> {
  const toggle = sectionToggle(page, id);
  if ((await toggle.getAttribute("aria-expanded")) === "true") return;
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
}

/**
 * Open EVERY section on /settings.
 *
 * The contrast and a11y gates need this: collapsing eight of nine sections takes
 * most of the page's controls out of the scanned DOM (axe correctly skips a
 * `hidden` subtree), so a scan of the resting page would be quietly narrower
 * than the one it replaced — the #90 lesson, arrived at from the other direction.
 */
export async function expandAllSections(page: Page): Promise<void> {
  const toggles = page.locator("[data-section-toggle]");
  const count = await toggles.count();
  expect(count, "no collapsible sections found").toBeGreaterThan(1);
  for (let i = 0; i < count; i++) {
    const toggle = toggles.nth(i);
    if ((await toggle.getAttribute("aria-expanded")) !== "true") {
      await toggle.click();
    }
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
  }
  // Clicking the last section's header scrolled the page down to reach it, and
  // (#101) named that section the current one. Leave the page where the caller
  // found it — at the top, with the scroll-spy back in charge — so "expand
  // everything" is a change of STATE and not also a change of scroll position.
  //
  // `behavior: "instant"` rather than a bare `scrollTo(0, 0)`: SectionNav puts
  // `scroll-smooth` on <html> while a section page is open, which makes the
  // default an ANIMATED scroll that this returned in the middle of (measured at
  // scrollY 2486 mid-scan on a page whose rest position is 0). Forcing the
  // behaviour is stronger than relying on the caller's `reducedMotion: "reduce"`
  // — it holds for the callers that do NOT emulate reduced motion too.
  await page.evaluate(() =>
    window.scrollTo({ top: 0, left: 0, behavior: "instant" }),
  );
  // …and then wait for the OTHER half, which arriving at the top does not
  // give you for free. See #110.
  await waitForSectionHighlightSettled(page);
}

/**
 * One atomic, NON-RETRYING read of where the section nav's "you are here"
 * highlight currently is.
 *
 * Atomic because it is a single `page.evaluate`: every field comes from the same
 * moment, which is the whole point — the #110 flake was axe reading one
 * element's background and its foreground on opposite sides of a state change,
 * and a read assembled from several round trips could not have seen that.
 *
 * Non-retrying for the same reason. Playwright's own assertions auto-wait, so
 * `expect(band).toContainText("Focus timer")` quietly waits the race out and
 * passes; axe does not retry, it reads the DOM once. This is what a scanner
 * sees.
 *
 * @param options.scrollHomeFirst Scroll to the top INSIDE the same evaluate,
 *   immediately before reading. It exists so the #110 regression test can prove
 *   the release of the highlight is asynchronous rather than assume it: the
 *   scroll-spy hands the highlight back from an IntersectionObserver callback,
 *   which cannot run in the middle of a task, so a read in the SAME task is
 *   guaranteed to catch the page at the top with the previous section still
 *   marked current. Doing it here rather than in the spec keeps one definition
 *   of the read — a second, inlined copy would be free to drift from the one
 *   {@link waitForSectionHighlightSettled} waits on, which is exactly the
 *   drift that would let this flake back in.
 */
export async function readSectionHighlight(
  page: Page,
  options: { readonly scrollHomeFirst?: boolean } = {},
): Promise<SectionHighlight> {
  return page.evaluate((scrollHomeFirst) => {
    if (scrollHomeFirst) {
      window.scrollTo({ top: 0, left: 0, behavior: "instant" });
    }
    const bands = Array.from(
      document.querySelectorAll("[data-section-header]"),
    );
    // The band's identity is its heading's id — the same id the nav links to.
    //
    // `|| null`, NOT `?? null`: `HTMLElement.id` is `""` for an element with no
    // id attribute, never nullish, so `??` would let the empty string through
    // as if it were an identity. It is not one — it is this read failing to
    // name the band, and it has to be reported as such (see
    // `isSectionHighlightSettled`, where "" === "" would otherwise satisfy the
    // invariant with two values that mean "I could not tell").
    const idOf = (band: Element | undefined): string | null =>
      band?.querySelector("h2")?.id || null;
    return {
      scrollY: Math.round(window.scrollY),
      current: bands
        .filter((band) => band.hasAttribute("data-current"))
        .map((band) => idOf(band)),
      topmost: idOf(bands[0]),
    };
  }, options.scrollHomeFirst ?? false);
}

/** The shape {@link readSectionHighlight} returns. */
export type SectionHighlight = {
  /** `window.scrollY`, rounded. */
  readonly scrollY: number;
  /**
   * The heading id of EVERY band claiming to be the current section. At rest
   * that is exactly one; more than one would mean two magenta bands, none means
   * the nav has not decided yet.
   *
   * `null` for a band whose heading has no usable id — a state this read can
   * report but cannot compare, deliberately kept distinct from a real id rather
   * than flattened into a placeholder string that could compare equal to
   * something.
   */
  readonly current: readonly (string | null)[];
  /** The heading id of the first band in document order, `null` if unnamed. */
  readonly topmost: string | null;
};

/**
 * Did the read manage to NAME this band?
 *
 * Rejects the empty string as well as `null`, so the answer stays correct even
 * if {@link readSectionHighlight}'s `idOf` ever goes back to `?? null` —
 * `HTMLElement.id` is `""`, not nullish, for a missing attribute, and that is
 * the exact slip this guards (review on !206).
 */
function isNamedBand(id: string | null): id is string {
  return id !== null && id !== "";
}

/** Render an id for a human, without letting an unnamed band print as blank. */
function describeBand(id: string | null): string {
  return isNamedBand(id) ? id : "(band with no heading id)";
}

/**
 * Is the page at rest at the top with the scroll-spy in charge?
 *
 * The condition is deliberately POSITIVE and TERMINAL rather than a "nothing
 * changed for N frames" heuristic: at the top of the page the topmost section is
 * the one being read, so it is the one that must be highlighted, and nothing
 * further can move it. If the app's resting behaviour ever changes this fails
 * with a message naming the band that actually holds the highlight, instead of
 * quietly going back to sampling a moving target.
 *
 * Both bands must be NAMED for the comparison to count. Review finding on !206:
 * `HTMLElement.id` is `""` rather than nullish when the attribute is absent, so
 * an unnamed `topmost` and an unnamed `current` used to compare equal and
 * satisfy this — an invariant agreeing with itself about a page it could not
 * describe. That is the same class of defect as the no-op `waitForFunction`
 * this change removed, so the unnamed case is rejected explicitly rather than
 * left to `idOf`'s return type: a blank id must fail loudly, and the wait must
 * time out with `topmost=(band with no heading id)` in the message.
 *
 * Guarded by src/lib/__tests__/section-highlight.harness.test.ts, which is where
 * the vacuous-pass cases live — they are pure logic, so they do not need a
 * browser and should not cost a Playwright run to check.
 */
export function isSectionHighlightSettled(state: SectionHighlight): boolean {
  const [current] = state.current;
  return (
    state.scrollY === 0 &&
    state.current.length === 1 &&
    isNamedBand(current) &&
    isNamedBand(state.topmost) &&
    current === state.topmost
  );
}

/**
 * Wait until the section nav's highlight has come to rest at the top of the
 * page — the missing half of {@link expandAllSections}'s own contract, and the
 * fix for #110.
 *
 * Why it has to exist. `expandAllSections` clicks every section header, and per
 * #101 a click NAMES that section current via an explicit override — so the last
 * one clicked (Demo, for a guest) ends up holding the magenta pinned band.
 * Scrolling home releases that override, but the release is ASYNCHRONOUS: the
 * IntersectionObserver callback cannot run until the next rendering opportunity,
 * React then re-renders, and only then does the `data-current` attribute move to
 * the first section. `scrollTo` returning tells you nothing about any of it.
 *
 * So a scan that started as soon as the page reached the top was reading a DOM
 * that was still changing, and axe would sample one element's background and its
 * foreground on opposite sides of that change: `--foreground` text over
 * `--primary` magenta, 3.08:1 light / 2.23:1 dark, reported against
 * `button[data-section-toggle="settings-demo"] > .truncate`. Nothing was wrong
 * with the colour — the settled band is `--primary-foreground` on `--primary`,
 * the documented AA pairing (globals.css) — and no element ever carries the
 * reported pair in any single frame. The tell is that axe's own report calls
 * that `font-semibold` label "weight normal": at least one field came from a
 * different moment than the others.
 *
 * !192 fixed the first half of this (the animated scroll) and left this half to
 * luck. Instrumented on `main` before this change, the last `data-current`
 * mutation landed 1 ms before the helper returned — green because the CDP round
 * trips happened to outlast one frame of browser work, not because anything
 * waited. Under an 8× CPU throttle that margin inverts and the helper returns
 * with the wrong band still magenta.
 */
export async function waitForSectionHighlightSettled(
  page: Page,
): Promise<void> {
  await expect
    .poll(
      async () => {
        const state = await readSectionHighlight(page);
        // A string rather than a boolean so the failure names the offending
        // band: `expect.poll` prints the last value it received. Every id goes
        // through `describeBand`, so an unnamed band reads as one instead of
        // vanishing into a blank — `join` would render `null` as "".
        return isSectionHighlightSettled(state)
          ? "settled"
          : `unsettled: scrollY=${state.scrollY} ` +
              `current=[${state.current.map(describeBand).join(", ")}] ` +
              `topmost=${describeBand(state.topmost)}`;
      },
      {
        message:
          "the section nav's highlight never came to rest at the top of the page",
      },
    )
    .toBe("settled");
}
