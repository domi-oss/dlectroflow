import { describe, it, expect } from "vitest";
import { isUsableHhmm, targetTimeToday } from "@/lib/target-time";

/**
 * Every value this module refuses, with why — ONE table, shared by the resolver's
 * fallback specs and by {@link isUsableHhmm}'s.
 *
 * ⚠️ Module scope rather than inline, because the two describes below assert the
 * two halves of a single rule: that the predicate says "unusable" for exactly the
 * inputs the resolver falls back for. Two copies of this list is precisely the
 * drift `parseHhmm`'s docblock exists to prevent — and the copy that quietly kept
 * accepting `"25:00"` would be the one deciding a medication deadline.
 */
const UNUSABLE: readonly (readonly [string, string])[] = [
  // Shape — these already fell back correctly.
  ["", "empty"],
  ["nonsense", "not a time at all"],
  ["25:00:00", "seconds appended"],
  ["17.00", "a dot instead of a colon"],
  ["1700", "no separator"],
  ["-1:00", "a negative hour — the minus breaks the shape"],
  ["7:5", "a one-digit minute"],
  // Range — these MATCHED the shape and silently rolled the day over.
  ["25:00", "an hour past 23"],
  ["12:99", "a minute past 59"],
  ["24:00", "midnight written as the 24th hour"],
  ["99:99", "both out of range"],
];

/** Every value it accepts, with the hour and minute it must resolve to. */
const USABLE: readonly (readonly [string, number, number])[] = [
  ["00:00", 0, 0],
  ["23:59", 23, 59],
  ["0:00", 0, 0],
  ["9:05", 9, 5],
  ["17:00", 17, 0],
];

/**
 * #269 — the extracted half of `roundup-card.tsx`'s private `targetTimeToday`.
 *
 * Every assertion builds its expectation with `new Date(y, m, d, …)`, which is
 * LOCAL, because that is the whole property under test: `Settings.workdayEndTime`
 * is a bare `HH:mm` and this function is what decides it means 17:00 where the
 * user is rather than 17:00 UTC. An expectation written with `Date.UTC` would
 * pass in the container and fail on the owner's laptop for half the year, which
 * is the defect rather than the test.
 */
describe("targetTimeToday", () => {
  it("resolves HH:mm against the given day, in local time", () => {
    const now = new Date(2026, 7, 16, 9, 30);
    expect(targetTimeToday("17:00", now)).toBe(
      new Date(2026, 7, 16, 17, 0, 0, 0).getTime(),
    );
  });

  it("keeps the DAY of the reference instant, not today's", () => {
    // The property `roundup-card.tsx`'s own dayKey gets wrong: a tab left open
    // across midnight must re-derive rather than hold the mounted day.
    const now = new Date(2026, 0, 1, 0, 5);
    expect(targetTimeToday("09:00", now)).toBe(
      new Date(2026, 0, 1, 9, 0, 0, 0).getTime(),
    );
  });

  it("accepts a single-digit hour", () => {
    const now = new Date(2026, 7, 16, 12, 0);
    expect(targetTimeToday("9:05", now)).toBe(
      new Date(2026, 7, 16, 9, 5, 0, 0).getTime(),
    );
  });

  /**
   * One rejection path, and it covers RANGE as well as shape.
   *
   * ⚠️ Duo review of `!364`, grounded and reproduced. The shape check alone
   * accepts `"25:00"` and `"12:99"` — one-to-two digits then two digits — and
   * `setHours(25, 0)` does not throw or produce `NaN`, it **normalises into the
   * next day**. Measured on the unfixed code: `"25:00"` gave Tue 18 Aug 01:00
   * and `"12:99"` gave Mon 17 Aug 13:39. So the documented 17:00 fallback was
   * unreachable for exactly the inputs it was written for, and `dueAfter` has no
   * CHECK constraint by design.
   *
   * A table rather than one case each, because the failure is a CLASS: shape
   * and range are two ways for the same input to be wrong and they must not have
   * two different answers.
   */
  it.each(UNUSABLE)("falls back to 17:00 for %o (%s)", (bad) => {
    const now = new Date(2026, 7, 16, 12, 0);
    expect(targetTimeToday(bad, now)).toBe(
      new Date(2026, 7, 16, 17, 0, 0, 0).getTime(),
    );
  });

  it("never rolls a well-formed but out-of-range value into another DAY", () => {
    // The property behind the table, stated as itself: whatever the fallback is,
    // the answer must land on the day it was asked about. A future change to
    // FALLBACK_HOUR would keep this true and would break a date-equality
    // assertion, which is why this checks the day rather than the instant.
    const now = new Date(2026, 7, 16, 12, 0);
    for (const bad of ["25:00", "24:00", "12:99", "99:99"]) {
      const answer = new Date(targetTimeToday(bad, now));
      expect(answer.getDate(), `${bad} left 16 Aug`).toBe(16);
      expect(answer.getMonth()).toBe(7);
      expect(answer.getFullYear()).toBe(2026);
    }
  });

  it.each(USABLE)(
    "still accepts the in-range value %o",
    (good, hour, minute) => {
      // The non-zero control. A range check that refused everything would satisfy
      // every assertion above while making the deadline permanently 17:00.
      const now = new Date(2026, 7, 16, 12, 0);
      expect(targetTimeToday(good, now)).toBe(
        new Date(2026, 7, 16, hour, minute, 0, 0).getTime(),
      );
    },
  );

  it("zeroes the seconds and milliseconds of the reference instant", () => {
    const now = new Date(2026, 7, 16, 12, 0, 44, 999);
    expect(new Date(targetTimeToday("17:00", now)).getSeconds()).toBe(0);
    expect(new Date(targetTimeToday("17:00", now)).getMilliseconds()).toBe(0);
  });

  it("does not mutate the reference instant", () => {
    const now = new Date(2026, 7, 16, 12, 0);
    const before = now.getTime();
    targetTimeToday("17:00", now);
    expect(now.getTime()).toBe(before);
  });
});

/**
 * #269 — the predicate `doseDeadline` needs, and why it is not just a second
 * range check.
 *
 * ⚠️ Duo review round 4 of `!364`, grounded. `targetTimeToday` degrades an
 * unusable value to 17:00, which is the right answer for `Settings.workdayEndTime`
 * — 17:00 is that column's schema default — and the WRONG one for
 * `MedicationDose.dueAfter`, whose absent value is `null`. Composing the degraded
 * value into `max(workdayEndTime, dueAfter)` does not fall back, it takes the
 * later of the two, so a workspace ending its day at 09:00 gave an unusable
 * `dueAfter` eight extra hours before the dose could read as *missed*.
 *
 * A caller therefore has to be able to ask "was a time stated at all" separately
 * from "resolve it". That is this function, and the block below pins the thing
 * that makes it safe: it answers for **exactly** the inputs the resolver falls
 * back for, sharing one table and one private parse rather than agreeing by
 * inspection.
 */
describe("isUsableHhmm", () => {
  it.each(UNUSABLE)("refuses %o (%s)", (bad) => {
    expect(isUsableHhmm(bad)).toBe(false);
  });

  it.each(USABLE)("accepts %o", (good) => {
    // The non-zero control, and it is load-bearing rather than decorative: a
    // predicate stuck at `false` would make EVERY dose collapse to
    // workdayEndTime, deleting the `max` that `doseDeadline` exists for while
    // every refusal assertion above stayed green.
    expect(isUsableHhmm(good)).toBe(true);
  });

  /**
   * The agreement property, stated as itself.
   *
   * This is what earns the claim that there is ONE range rule rather than two
   * that happen to match today. If a future edit taught the resolver to accept
   * `"24:00"` and left the predicate refusing it, `doseDeadline` would treat a
   * value the resolver resolves as "no time stated" — and nothing else in the
   * suite would notice, because each side's own table would still pass.
   */
  it("says unusable for exactly the values the resolver falls back for", () => {
    const now = new Date(2026, 7, 16, 12, 0);
    const fallback = new Date(2026, 7, 16, 17, 0, 0, 0).getTime();
    for (const [value] of UNUSABLE) {
      expect(isUsableHhmm(value), `${value} disagreed`).toBe(false);
      expect(targetTimeToday(value, now), `${value} disagreed`).toBe(fallback);
    }
    for (const [value, hour, minute] of USABLE) {
      expect(isUsableHhmm(value), `${value} disagreed`).toBe(true);
      expect(targetTimeToday(value, now), `${value} disagreed`).toBe(
        new Date(2026, 7, 16, hour, minute, 0, 0).getTime(),
      );
    }
  });
});
