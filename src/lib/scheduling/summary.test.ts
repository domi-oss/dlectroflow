import { describe, it, expect } from "vitest";
import { formatBlockMinutes, scheduleSummary } from "./summary";
import type { WindowPlan } from "./windows";

// The owner's zone is Europe/London, which is BST in these dates — spelling the
// offset out keeps the expected weekday/date honest instead of accidentally
// asserting UTC.
const bst = (iso: string) => new Date(`${iso}:00.000+01:00`);

function plan(over: Partial<WindowPlan> = {}): WindowPlan {
  return {
    windows: [],
    feasible: true,
    availableMin: 1710,
    requiredMin: 210,
    earliestFeasibleDue: null,
    ...over,
  };
}

describe("formatBlockMinutes", () => {
  it("renders minutes under an hour", () => {
    expect(formatBlockMinutes(45)).toBe("45m");
  });
  it("renders whole hours without a stray 0m", () => {
    expect(formatBlockMinutes(120)).toBe("2h");
  });
  it("renders hours and minutes together", () => {
    expect(formatBlockMinutes(210)).toBe("3h30m");
  });
  it("renders zero honestly rather than as an empty string", () => {
    expect(formatBlockMinutes(0)).toBe("0m");
  });
  // A negative or non-finite total can only come from a bug upstream, but this
  // string is rendered — "NaNm" or "-1h-30m" in the UI is worse than "0m".
  it("floors a negative total at zero instead of rendering a minus sign", () => {
    expect(formatBlockMinutes(-30)).toBe("0m");
  });
  it("renders a non-finite total as 0m rather than NaN", () => {
    expect(formatBlockMinutes(Number.NaN)).toBe("0m");
    expect(formatBlockMinutes(Number.POSITIVE_INFINITY)).toBe("0m");
  });
});

describe("scheduleSummary — the feasible case", () => {
  it("states the step count, the total block time and the deadline", () => {
    const s = scheduleSummary(plan(), 7, bst("2026-07-31T17:00"));
    expect(s.warning).toBe(false);
    expect(s.text).toContain("7 steps");
    expect(s.text).toContain("3h30m");
    expect(s.text).toMatch(/in order/i);
    expect(s.text).toContain("Fri 31 Jul");
  });

  it("says 'step' not 'steps' for one", () => {
    const s = scheduleSummary(
      plan({ requiredMin: 30 }),
      1,
      bst("2026-07-31T17:00"),
    );
    expect(s.text).toContain("1 step");
    expect(s.text).not.toContain("1 steps");
  });

  it("drops the ordering clause for a single step — there is nothing to order", () => {
    const s = scheduleSummary(
      plan({ requiredMin: 30 }),
      1,
      bst("2026-07-31T17:00"),
    );
    expect(s.text).not.toMatch(/in order/i);
  });

  // The one place a build-vs-jsdom whitespace difference would show up is the
  // seam between the assembled clauses, so pin that there is exactly one space
  // either side of every separator and no double space anywhere.
  it("has no collapsed-whitespace seams between its clauses", () => {
    const s = scheduleSummary(plan(), 7, bst("2026-07-31T17:00"));
    expect(s.text).not.toMatch(/\s{2}/);
    expect(s.text.trim()).toBe(s.text);
  });
});

// A wall-clock timebomb, and the reason this suite asserts the whole string
// rather than its shape (#271's class). en-GB abbreviates September to "Sept" —
// four letters — and all eleven other months to three:
//
//   Jan Feb Mar Apr May Jun Jul Aug Sept Oct Nov Dec
//
// measured under node:22-alpine (ICU 78.2), the image test_app and the build both
// run. So anything that counts the month's letters passes for eleven months of the
// year and reds for the twelfth. e2e/smoke/schedule-menu.spec.ts counted them, and
// because e2e_test sits in the `build` stage while deploy_production sits in
// `deploy`, its September red does not merely fail a test — it skips the
// production deploy, silently.
//
// Twelve rows of exact equality is the whole guard: deterministic, no browser, and
// it reds in August rather than in September. Exact equality also subsumes the
// collapsed-seam check above for every month, not just July.
//
// Midday UTC deliberately: Europe/London is GMT for some of these dates and BST
// for others, and 12:00Z is the same calendar day under both, so each expected
// weekday is the real one instead of one that shifts with the offset.
describe("scheduleSummary — the deadline reads correctly in every month", () => {
  const utcMidday = (isoDate: string) => new Date(`${isoDate}T12:00:00.000Z`);

  it.each([
    ["2026-01-15", "Thu 15 Jan"],
    ["2026-02-15", "Sun 15 Feb"],
    ["2026-03-15", "Sun 15 Mar"],
    ["2026-04-15", "Wed 15 Apr"],
    ["2026-05-15", "Fri 15 May"],
    ["2026-06-15", "Mon 15 Jun"],
    ["2026-07-15", "Wed 15 Jul"],
    ["2026-08-15", "Sat 15 Aug"],
    ["2026-09-15", "Tue 15 Sept"],
    ["2026-10-15", "Thu 15 Oct"],
    ["2026-11-15", "Sun 15 Nov"],
    ["2026-12-15", "Tue 15 Dec"],
  ])("renders a deadline of %s as %s", (isoDate, shortDay) => {
    // The same step count and block total the e2e smoke spec asserts, so this
    // pins the exact string that spec reads out of the rendered dialog.
    const { text } = scheduleSummary(
      plan({ requiredMin: 135 }),
      3,
      utcMidday(isoDate),
    );
    expect(text).toBe(
      `3 steps · 2h15m of blocks, spread in order before ${shortDay}`,
    );
  });
});

describe("scheduleSummary — the warning case", () => {
  const infeasible = plan({
    feasible: false,
    availableMin: 240,
    requiredMin: 270,
    earliestFeasibleDue: bst("2026-08-03T11:00"),
  });

  it("flags itself as a warning", () => {
    expect(
      scheduleSummary(infeasible, 7, bst("2026-07-31T17:00")).warning,
    ).toBe(true);
  });

  it("says how much room there is, how much is needed, and what would fit", () => {
    const { text } = scheduleSummary(infeasible, 7, bst("2026-07-31T17:00"));
    expect(text).toContain("4h of"); // available, and not the "4h30m" below
    expect(text).toContain("4h30m"); // required
    expect(text).toContain("Mon 3 Aug"); // the earliest date that fits
  });

  it("does not suggest a date when there is none to suggest", () => {
    const { text } = scheduleSummary(
      plan({
        feasible: false,
        availableMin: 0,
        requiredMin: 30,
        earliestFeasibleDue: null,
      }),
      1,
      bst("2026-07-28T17:00"),
    );
    expect(text).toMatch(/no working time/i);
    expect(text).not.toMatch(/earliest/i);
  });

  // Infeasible with room left but no computable earliest date: still a warning,
  // and it must not trail an empty "Earliest that fits: ." sentence.
  it("omits the earliest-fits clause rather than emitting an empty one", () => {
    const { text } = scheduleSummary(
      plan({
        feasible: false,
        availableMin: 60,
        requiredMin: 120,
        earliestFeasibleDue: null,
      }),
      2,
      bst("2026-07-31T17:00"),
    );
    expect(text).not.toMatch(/earliest/i);
    expect(text).not.toMatch(/\s{2}/);
    expect(text).toContain("1h of");
    expect(text).toContain("2h");
  });
});
