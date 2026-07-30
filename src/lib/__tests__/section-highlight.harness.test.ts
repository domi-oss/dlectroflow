import { describe, it, expect } from "vitest";
import {
  isSectionHighlightSettled,
  type SectionHighlight,
} from "../../../e2e/helpers";

/**
 * #110 — the e2e suite's "the section nav has come to rest" invariant, checked
 * as pure logic.
 *
 * `isSectionHighlightSettled` is what `waitForSectionHighlightSettled` polls,
 * and therefore what decides whether an axe scan is allowed to start. Its
 * failure mode is silent: a predicate that returns `true` too readily does not
 * error, it just hands the scanner a page that is still moving — which is the
 * whole defect #110 is about. So the cases that matter are the ones where it
 * must say NO, and they are all reachable without a browser.
 *
 * The precedent for reaching into `e2e/` from a vitest file is
 * e2e-token-key.harness.test.ts, for the same reason: the harness has
 * invariants of its own, and a bug in them is invisible to the suite it guards.
 *
 * Why this file exists at all is a review finding on !206. `idOf` was written
 * `band?.querySelector("h2")?.id ?? null`, and `HTMLElement.id` is `""` — never
 * nullish — for an element with no id attribute. So an unnamed band produced
 * `""` rather than `null`, `topmost` became `""`, and `current[0] === topmost`
 * was satisfied by `"" === ""`: the invariant agreeing with itself about a page
 * it had failed to describe. Same class of defect as the no-op
 * `waitForFunction` that #110 removed — a check that cannot fail is not a
 * check.
 */

/** A settled page: at the top, one band current, and it is the topmost one. */
const SETTLED: SectionHighlight = {
  scrollY: 0,
  current: ["settings-focus-timer"],
  topmost: "settings-focus-timer",
};

describe("isSectionHighlightSettled", () => {
  it("accepts the state the page is actually in at rest", () => {
    expect(isSectionHighlightSettled(SETTLED)).toBe(true);
  });

  // ── The regression proper (review on !206) ────────────────────────────────
  // Each of these is a page the read could not describe. None may be "settled".

  it("is NOT satisfied by two unnamed bands comparing equal as empty strings", () => {
    // The exact shape `?? null` used to produce. Without the named-band check
    // this returns true, and every axe scan behind it starts on a page whose
    // state is unknown.
    expect(
      isSectionHighlightSettled({
        scrollY: 0,
        current: [""],
        topmost: "",
      }),
    ).toBe(false);
  });

  it("is NOT satisfied by two unnamed bands comparing equal as null", () => {
    expect(
      isSectionHighlightSettled({ scrollY: 0, current: [null], topmost: null }),
    ).toBe(false);
  });

  it("rejects an unnamed current band even when the topmost one is named", () => {
    for (const current of ["", null]) {
      expect(
        isSectionHighlightSettled({
          ...SETTLED,
          current: [current],
        }),
        `current=${JSON.stringify(current)}`,
      ).toBe(false);
    }
  });

  it("rejects an unnamed topmost band even when the current one is named", () => {
    for (const topmost of ["", null]) {
      expect(
        isSectionHighlightSettled({ ...SETTLED, topmost }),
        `topmost=${JSON.stringify(topmost)}`,
      ).toBe(false);
    }
  });

  // ── The conditions the invariant was always meant to enforce ──────────────

  it("rejects a page that has not come back to the top", () => {
    // The #110 measurement: axe scanning at scrollY 2486 on a page whose rest
    // position is 0.
    expect(isSectionHighlightSettled({ ...SETTLED, scrollY: 2486 })).toBe(
      false,
    );
  });

  it("rejects the mid-handover state: the wrong band still holds the highlight", () => {
    // The state `expandAllSections` used to return in — at the top, but with
    // the last-clicked section still magenta.
    expect(
      isSectionHighlightSettled({ ...SETTLED, current: ["settings-demo"] }),
    ).toBe(false);
  });

  it("rejects two bands claiming to be current at once", () => {
    expect(
      isSectionHighlightSettled({
        ...SETTLED,
        current: ["settings-focus-timer", "settings-demo"],
      }),
    ).toBe(false);
  });

  it("rejects a nav that has not decided yet — no band is current", () => {
    expect(isSectionHighlightSettled({ ...SETTLED, current: [] })).toBe(false);
  });

  it("rejects a page with no section bands at all", () => {
    // Nothing to be current, so nothing to settle. A page without bands must
    // not read as settled just because it has no way to disagree.
    expect(
      isSectionHighlightSettled({ scrollY: 0, current: [], topmost: null }),
    ).toBe(false);
  });
});
