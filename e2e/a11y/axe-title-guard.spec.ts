import { test, expect, type Page } from "@playwright/test";
import { waitForShell } from "../helpers";
import { scanA11y } from "./axe-helpers";

/**
 * #222 — the axe gate must not read `document.title` mid-commit.
 *
 * The bug this file pins down is a race, and the two sightings recorded on #222
 * are the kind of evidence a test cannot be built out of: same SHA, three runs
 * of one job, red → red → green, with the FAILING SPEC MOVING between runs
 * (`axe-core-flow.spec.ts:51` one attempt, `axe-shopping.spec.ts:98` the next).
 * Nothing about the app is wrong — `src/app/layout.tsx` sets a static
 * `metadata.title`, so the `<title>` is in the server-streamed HTML and a
 * genuinely absent one would fail every scan of every route rather than one.
 *
 * What actually happens: Next streams `metadata` into the body and React 19
 * hoists it into `<head>`, and on the RSC payload a `router.refresh()` brings
 * back, the whole hoisted block — `<title>`, the description `<meta>` and both
 * icon `<link>`s — is detached and re-inserted. `document.title` is `""` only for
 * the instant the element belongs to no parent at all (verified: a `<title>`
 * parked inside a body `<div>` still reads `"dlectroflow"`), and axe's
 * `doc-has-title` check is literally `!!sanitize(document.title)` — so that
 * instant is the whole bug. #222 has the CI trace showing the re-insertion
 * bracketing `axe.runPartial`; the ids are left there rather than copied here,
 * because a purged job log makes them unverifiable while the mechanism stays true.
 *
 * Milliseconds wide, and therefore not reproducible on demand. So this file does
 * not try to win a race: it reproduces the STATE the race produces — a detached
 * `<title>` that comes back — and asserts `scanA11y` waits it out. That turns an
 * unreproducible flake into a deterministic test, which is the only version of
 * it that can fail on the day the guard is removed.
 *
 * Both directions are covered on purpose. A wait that never fails would be a
 * vacuous pass, and this repo has been bitten by that shape before (#110's
 * no-op `waitForFunction`, and the unnamed-band case in
 * `isSectionHighlightSettled`): the second test holds the title away for good
 * and requires the scan to fail with the GUARD's message, so the guard cannot
 * be quietly turned into a no-op that lets a real WCAG 2.4.2 regression past.
 *
 * ── #249: "removed once" is not "held away" ─────────────────────────────────
 *
 * Both tests used to `remove()` the element once, which turned out to mean "gone
 * until React notices" rather than gone. That made the negative control a race
 * it lost on loaded CI runners — ~2 in 7 `e2e_test` jobs, hard-failing MRs
 * because the `a11y` project has no retry to absorb it (#127, correctly).
 *
 * Measured under a 20× CPU throttle, which is how #110 stood in for a loaded
 * runner: on `/`, the `<title>` ships INSIDE the server-streamed `<head>` (byte
 * 1624 of the response, `</head>` at 2159) — which corrects the paragraph above,
 * and `axe-helpers.ts` with it: the element the browser parses is already in
 * `<head>`, so nothing has to be hoisted out of the body for it to be readable.
 * The consequence is what matters here: the `toHaveTitle(/\S/)` precondition
 * below is satisfied by the PARSED document, while hydration is still pending.
 * React 19 owns that hoisted element, and its FIRST COMMIT puts one back — a new
 * element, `insertBefore`d into `<head>` ~700 ms after the detach, not the node
 * the fixture took out, so holding a reference to the removed one would not have
 * been enough either. The negative control before this change: 30/30 pass at 1×,
 * **0/30 at 20×**, failing with exactly the signature #249 records. Both tests
 * after it: 60/60 at 1× and 30/30 at 20× (fifteen runs each).
 *
 * That corrects the mechanism for this fixture, and the correction is the reason
 * a narrower fix would not hold: the `router.refresh()` re-insertion described
 * above is how the window opens in PRODUCTION, but what this file was losing to
 * is initial hydration. A title detached AFTER hydration finishes is never
 * re-inserted at all (0/3 at 20×, over a full 5 s guard budget) — so "detach a
 * bit later" or "shorten the window" would only have re-tuned the race.
 *
 * `holdTitleAway` therefore makes "away" true instead of likely, with a
 * `MutationObserver` that removes every `<title>` that appears. The removal lands
 * in the same task as the insertion — observer callbacks are delivered at that
 * task's microtask checkpoint — while both readers of `document.title` here run
 * in later tasks: Playwright's `toHaveTitle` poll, and axe's `doc-has-title`,
 * which is literally `!!sanitize(document.title)`. Robust to the re-render rather
 * than faster than it.
 *
 * The first test needed it as much as the second, for a quieter reason: at 20× it
 * passed 10/10, but seven of those ten ended with TWO `<title>`s in `<head>` —
 * React's and the fixture's — meaning the recovery the guard was observed to make
 * was usually React's rather than the one this test opened a window for. Never
 * red, and still a vacuous pass, which is the shape the paragraph above is about.
 * Holding the window open instead, and dropping anything React put back before
 * restoring the original, ends all fifteen 20× runs with exactly one `<title>`:
 * the fixture's.
 */

test.use({ contextOptions: { reducedMotion: "reduce" } });

/**
 * How long to keep the `<title>` detached in the recoverable case.
 *
 * Comfortably longer than the CDP round trip that starts the scan, so the scan
 * provably begins inside the window rather than after it — and comfortably
 * shorter than the guard's own wait, so a correct guard has time to recover.
 */
const DETACH_MS = 750;

/**
 * Reproduce #222's window: take the `<title>` out of the document and KEEP it
 * out for `restoreAfterMs` — or for the rest of the test, when that is `null`.
 *
 * Returns the `document.title` reading taken immediately afterwards so the
 * caller can assert the window actually opened. A fixture that silently failed
 * to open it would make every assertion below pass for the wrong reason — the
 * scan would simply see a titled page.
 */
async function holdTitleAway(
  page: Page,
  restoreAfterMs: number | null,
): Promise<string> {
  return page.evaluate((ms) => {
    const original = document.querySelector("head > title");
    if (!original) {
      throw new Error("no <head> <title> to detach — fixture is broken");
    }
    // Swept over the whole document rather than `head > title`, because
    // `document.title` reads the FIRST `<title>` in tree order wherever it sits
    // — the reading `axe-helpers.ts` records, a `<title>` parked in a body
    // `<div>` still reporting `"dlectroflow"`. A head-only sweep would leave a
    // readable title behind the moment one lands anywhere else. The NodeList is
    // static, so removing as we go cannot skip an entry.
    const strip = () => {
      for (const el of document.querySelectorAll("title")) el.remove();
    };
    strip();
    // Terminates rather than looping: the removals it performs re-enter it once
    // more, and that pass finds nothing left to remove.
    const observer = new MutationObserver(strip);
    observer.observe(document, { childList: true, subtree: true });
    if (ms !== null) {
      window.setTimeout(() => {
        // Disconnect FIRST, or the observer eats the restore it is watching for.
        observer.disconnect();
        // Then drop whatever React put back, so the element that returns is the
        // one this fixture took away — the whole point of holding the window
        // open for a known duration.
        strip();
        document.head.appendChild(original);
      }, ms);
    }
    return document.title;
  }, restoreAfterMs);
}

test.describe("#222 — the axe gate waits for the document title", () => {
  test("a momentarily detached <title> does not fail the scan", async ({
    page,
  }) => {
    await page.goto("/");
    await waitForShell(page);
    // The precondition, asserted rather than assumed: if `/` arrived without a
    // title the rest of this test would be measuring the wrong thing.
    await expect(page).toHaveTitle(/\S/);

    expect(
      await holdTitleAway(page, DETACH_MS),
      "detaching the <title> did not empty document.title, so the window this " +
        "test needs never opened",
    ).toBe("");

    // Before the fix this fails with `document-title::html` — the exact
    // violation #222 reports from CI, now on demand.
    await scanA11y(page, "/");
  });

  test("a <title> that never returns still fails the scan, with the guard's own message", async ({
    page,
  }) => {
    await page.goto("/");
    await waitForShell(page);
    await expect(page).toHaveTitle(/\S/);

    expect(
      await holdTitleAway(page, null),
      "holding the <title> away did not empty document.title, so the window " +
        "this test needs never opened",
    ).toBe("");

    // Matched on the GUARD's wording, not on anything axe says. axe's own
    // failure text contains the word "title" too, so a looser matcher would
    // pass against the unfixed helper and prove nothing.
    await expect(scanA11y(page, "/")).rejects.toThrow(
      /never got a non-empty <title>/,
    );
  });
});
