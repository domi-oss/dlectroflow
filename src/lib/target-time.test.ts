import { describe, it, expect } from "vitest";
import { targetTimeToday } from "@/lib/target-time";

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

  it.each(["", "nonsense", "25:00:00", "17.00", "1700"])(
    "falls back to 17:00 for the malformed value %o",
    (bad) => {
      const now = new Date(2026, 7, 16, 12, 0);
      expect(targetTimeToday(bad, now)).toBe(
        new Date(2026, 7, 16, 17, 0, 0, 0).getTime(),
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
