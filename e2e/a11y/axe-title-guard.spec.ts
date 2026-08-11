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
 * Reproduce #222's window: take the `<title>` out of the document entirely and
 * put it back after `restoreAfterMs`.
 *
 * Returns the `document.title` reading taken immediately afterwards so the
 * caller can assert the window actually opened. A fixture that silently failed
 * to open it would make every assertion below pass for the wrong reason — the
 * scan would simply see a titled page.
 */
async function detachTitle(
  page: Page,
  restoreAfterMs: number,
): Promise<string> {
  return page.evaluate((ms) => {
    const el = document.querySelector("head > title");
    if (!el) throw new Error("no <head> <title> to detach — fixture is broken");
    el.remove();
    window.setTimeout(() => document.head.appendChild(el), ms);
    return document.title;
  }, restoreAfterMs);
}

/**
 * Hold the `<title>` out of the document for the rest of the test — and keep it
 * out, whatever React does next.
 *
 * #249: `remove()` on its own does not mean "never returns", it means "gone
 * until React notices". Measured on this spec under a 20× CPU throttle, which
 * widens the window the way a loaded CI runner does: `<title>` ships inside the
 * server-streamed `<head>` (byte 1624 of `/`, before `</head>`), so
 * `toHaveTitle(/\S/)` above is satisfied by the PARSED document, while
 * hydration is still pending. React 19 owns that hoisted element, and its first
 * commit puts one back — a NEW element, `insertBefore`d into `<head>` roughly
 * 700 ms after the detach, not the node that was taken out. So the old fixture
 * was racing hydration rather than asserting a title-less page: it won 30/30 on
 * an idle machine and lost 30/30 at 20×, with exactly the CI failure #249
 * records (`Received promise resolved instead of rejected`).
 *
 * That also corrects, for this fixture, the mechanism the file header describes
 * from #222: a spontaneous `router.refresh()` is how the window opens in
 * PRODUCTION, but the one this negative control was losing to is the initial
 * hydration commit. Detaching after hydration has finished is not re-inserted
 * at all (0/3 at 20×, over a full 5 s guard budget) — which is why the flake
 * only ever showed up on a loaded runner, and why "detach a bit later" would be
 * a better-tuned race rather than a fix.
 *
 * A `MutationObserver` makes "never" true instead of merely likely. Every
 * `<title>` that appears is removed again inside the same task that inserted it:
 * observer callbacks are delivered at that task's microtask checkpoint, while
 * both readers of `document.title` here — Playwright's `toHaveTitle` poll and
 * axe's `doc-has-title`, which is literally `!!sanitize(document.title)` — run
 * in later tasks. Robust to the re-render, not faster than it.
 *
 * Swept over the whole document rather than `head > title` because
 * `document.title` reads the FIRST `<title>` in tree order wherever it sits —
 * the reading `axe-helpers.ts` records, a `<title>` parked in a body `<div>`
 * still reporting `"dlectroflow"`. A head-only sweep would leave a readable
 * title behind the moment one lands anywhere else.
 *
 * Deliberately never disconnected: it has to outlive the scan it is holding the
 * title away from, and the page is torn down when the test ends.
 */
async function holdTitleAway(page: Page): Promise<string> {
  return page.evaluate(() => {
    // A static NodeList, so removing as we go cannot skip an entry.
    const strip = () => {
      const titles = document.querySelectorAll("title");
      for (const el of titles) el.remove();
      return titles.length;
    };
    if (strip() === 0) {
      throw new Error("no <title> to hold away — fixture is broken");
    }
    // Terminates rather than looping: the removals it performs re-enter it once
    // more, and that pass finds nothing left to remove.
    new MutationObserver(strip).observe(document, {
      childList: true,
      subtree: true,
    });
    return document.title;
  });
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
      await detachTitle(page, DETACH_MS),
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
      await holdTitleAway(page),
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
