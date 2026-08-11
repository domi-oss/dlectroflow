import { test, expect } from "@playwright/test";
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
 * What actually happens, read off the DOM snapshots in the CI trace of job
 * `15826251144` (`/shopping with a row`, sha `fd4b608`):
 *
 *   after@call@1738  <head> … META, TITLE, META[description], LINK, LINK      ← 8 children
 *   after@call@1744  <head> … META, META                                      ← 4 children,
 *                    and the TITLE is at /HTML/BODY/DIV/DIV/DIV/DIV
 *   after@call@1752  <head> … META, TITLE, META[description], LINK, LINK      ← 8 children
 *
 * `call@1744` is the spec's last wait before the scan and `call@1752` is
 * `axe.runPartial` itself, so the re-application of the metadata block brackets
 * the scan exactly. Next streams `metadata` into the body and React 19 hoists it
 * into `<head>`; on the RSC payload that a `router.refresh()` brings back, the
 * whole block — `<title>`, the description `<meta>` and both icon `<link>`s —
 * is detached and re-inserted. `document.title` is `""` only for the instant the
 * element belongs to no parent at all (verified: a `<title>` parked inside a body
 * `<div>` still reads `"dlectroflow"`), and axe's `doc-has-title` check is
 * literally `!!sanitize(document.title)` — so that instant is the whole bug.
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
 * Reproduce #222's window: take the `<title>` out of the document entirely, and
 * optionally put it back after `restoreAfterMs`.
 *
 * Returns the `document.title` reading taken immediately afterwards so the
 * caller can assert the window actually opened. A fixture that silently failed
 * to open it would make every assertion below pass for the wrong reason — the
 * scan would simply see a titled page.
 */
async function detachTitle(
  page: import("@playwright/test").Page,
  restoreAfterMs: number | null,
): Promise<string> {
  return page.evaluate((ms) => {
    const el = document.querySelector("head > title");
    if (!el) throw new Error("no <head> <title> to detach — fixture is broken");
    el.remove();
    if (ms !== null) {
      window.setTimeout(() => document.head.appendChild(el), ms);
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

    expect(await detachTitle(page, null)).toBe("");

    // Matched on the GUARD's wording, not on anything axe says. axe's own
    // failure text contains the word "title" too, so a looser matcher would
    // pass against the unfixed helper and prove nothing.
    await expect(scanA11y(page, "/")).rejects.toThrow(
      /never got a non-empty <title>/,
    );
  });
});
