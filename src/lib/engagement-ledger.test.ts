import { describe, it, expect } from "vitest";
import {
  MAX_LEDGER_LOOKBACK_DAYS,
  isoWeekday,
  parseWorkingDays,
  parseYmd,
  recomputeRun,
  runIsFullyLedgered,
  ymd,
} from "@/lib/engagement-ledger";

/**
 * #233 — the recompute, on synthetic input and with no database.
 *
 * This is the half of the ledger that decides whether a streak badge may be
 * revoked, so it is the half that has to be exercised on shapes a real database
 * would take weeks to produce: a run interrupted by one missed working day, a run
 * that straddles the instant the ledger started recording, a workspace whose
 * working days are not Monday-to-Friday.
 *
 * The `CLAUDE.md` rule for a repo guard applies to this module for the same
 * reason it applies to the hygiene parsers: a pure module with no `prisma` import
 * can be shown to FAIL on a case, and one that can only be driven through a
 * server action cannot.
 *
 * ── The week these dates come from ──────────────────────────────────────────
 *
 * 2026-08-10 is a Monday, so 08-10..08-14 is Mon-Fri, 08-15 a Saturday, 08-16 a
 * Sunday and 08-17 the following Monday. Asserted below rather than trusted,
 * because every expectation in this file rests on it and a wrong assumption
 * would make the whole file pass for the wrong reason.
 */

const MON_FRI = [1, 2, 3, 4, 5];

describe("the days these tests are written against", () => {
  it("has 2026-08-10 as a Monday and 08-15/08-16 as the weekend", () => {
    expect(isoWeekday(parseYmd("2026-08-10"))).toBe(1);
    expect(isoWeekday(parseYmd("2026-08-14"))).toBe(5);
    expect(isoWeekday(parseYmd("2026-08-15"))).toBe(6);
    expect(isoWeekday(parseYmd("2026-08-16"))).toBe(7);
    expect(isoWeekday(parseYmd("2026-08-17"))).toBe(1);
  });
});

describe("ymd / parseYmd round-trip", () => {
  it("is stable across the local-midnight boundary either way", () => {
    // `ymd` reads LOCAL getters and `parseYmd` builds a LOCAL date, so the pair
    // has to be each other's inverse whatever TZ the process runs in. A `new
    // Date("2026-08-10")` would parse as UTC midnight and shift a day west of
    // Greenwich, which is exactly the bug this pairing exists to avoid.
    for (const day of ["2026-01-01", "2026-08-10", "2026-12-31"]) {
      expect(ymd(parseYmd(day))).toBe(day);
    }
  });

  it("gives local midnight, not an arbitrary time of day", () => {
    const d = parseYmd("2026-08-10");
    expect([
      d.getHours(),
      d.getMinutes(),
      d.getSeconds(),
      d.getMilliseconds(),
    ]).toEqual([0, 0, 0, 0]);
  });
});

describe("parseWorkingDays", () => {
  it("reads the settings CSV and drops anything outside 1-7", () => {
    expect(parseWorkingDays("1,2,3,4,5")).toEqual(MON_FRI);
    expect(parseWorkingDays(" 6 , 7 ")).toEqual([6, 7]);
    expect(parseWorkingDays("0,8,foo,3")).toEqual([3]);
  });
});

describe("recomputeRun (#233)", () => {
  it("reports no run at all for an empty ledger", () => {
    expect(recomputeRun(new Set(), MON_FRI, "2026-08-14")).toEqual({
      current: 0,
      lastActiveWorkday: null,
      runStart: null,
    });
  });

  it("counts a single working day as a run of one", () => {
    expect(
      recomputeRun(new Set(["2026-08-14"]), MON_FRI, "2026-08-14"),
    ).toEqual({
      current: 1,
      lastActiveWorkday: "2026-08-14",
      runStart: "2026-08-14",
    });
  });

  it("counts consecutive working days", () => {
    const days = new Set(["2026-08-12", "2026-08-13", "2026-08-14"]);
    expect(recomputeRun(days, MON_FRI, "2026-08-14")).toEqual({
      current: 3,
      lastActiveWorkday: "2026-08-14",
      runStart: "2026-08-12",
    });
  });

  it("steps over a non-working day without breaking the run", () => {
    // Friday then Monday, with the weekend skipped — the behaviour
    // `touchStreakOnEngagement` has always had ("non-working days don't break
    // it"), which the recompute has to reproduce exactly or the two disagree
    // about the same history.
    const days = new Set(["2026-08-14", "2026-08-17"]);
    expect(recomputeRun(days, MON_FRI, "2026-08-17")).toEqual({
      current: 2,
      lastActiveWorkday: "2026-08-17",
      runStart: "2026-08-14",
    });
  });

  it("stops at a MISSED working day", () => {
    // Monday and Wednesday, nothing on Tuesday. Two engagement days, one run of
    // one — this is the assertion that fails if the walk counts rows instead of
    // walking the calendar.
    const days = new Set(["2026-08-10", "2026-08-12"]);
    expect(recomputeRun(days, MON_FRI, "2026-08-12")).toEqual({
      current: 1,
      lastActiveWorkday: "2026-08-12",
      runStart: "2026-08-12",
    });
  });

  it("ignores a credit that landed on a non-working day", () => {
    // A Saturday capture is recorded in the ledger and must not advance the
    // streak, because `touchStreakOnEngagement` returns before its transaction on
    // a non-working day. The ledger keeps a truthful log; the recompute is what
    // applies the working-day rule.
    expect(
      recomputeRun(new Set(["2026-08-15"]), MON_FRI, "2026-08-17"),
    ).toEqual({ current: 0, lastActiveWorkday: null, runStart: null });
  });

  it("counts a run that ENDED before today", () => {
    // `Streak.current` is the length of the run ending at `lastActiveWorkday`,
    // not "the run ending today" — a person who has not engaged yet today still
    // has yesterday's streak.
    const days = new Set(["2026-08-12", "2026-08-13"]);
    expect(recomputeRun(days, MON_FRI, "2026-08-14")).toEqual({
      current: 2,
      lastActiveWorkday: "2026-08-13",
      runStart: "2026-08-12",
    });
  });

  it("ignores days in the future", () => {
    // Clock skew between two replicas, or a row written just after local
    // midnight elsewhere. A future day must not become `lastActiveWorkday`, or
    // the walk starts from a day nothing has happened on yet.
    const days = new Set(["2026-08-13", "2026-08-20"]);
    expect(recomputeRun(days, MON_FRI, "2026-08-13")).toEqual({
      current: 1,
      lastActiveWorkday: "2026-08-13",
      runStart: "2026-08-13",
    });
  });

  it("honours a working-week that is not Monday-to-Friday", () => {
    // A weekend worker. Sat 08-15 and Sun 08-16 are consecutive working days for
    // them, and the Friday before is not a working day at all — so it neither
    // extends the run nor breaks it.
    const days = new Set(["2026-08-14", "2026-08-15", "2026-08-16"]);
    expect(recomputeRun(days, [6, 7], "2026-08-16")).toEqual({
      current: 2,
      lastActiveWorkday: "2026-08-16",
      runStart: "2026-08-15",
    });
  });

  it("treats an empty working-week as no working days rather than as all of them", () => {
    // `parseWorkingDays("")` yields `[]`, which is reachable from a hand-edited
    // settings row. Reading it as "every day" would advance a streak the app
    // itself refuses to advance.
    expect(recomputeRun(new Set(["2026-08-14"]), [], "2026-08-14")).toEqual({
      current: 0,
      lastActiveWorkday: null,
      runStart: null,
    });
  });

  it("terminates on a ledger with no gaps at all, and says it was truncated", () => {
    // The walk's only unbounded shape: every working day back to the epoch
    // present. It has to stop, and it has to be honest that the number it
    // returned is a floor rather than the answer — a silent cap would understate
    // a run and could revoke a badge that is still earned.
    const days = new Set<string>();
    const cursor = parseYmd("2026-08-14");
    for (let i = 0; i < MAX_LEDGER_LOOKBACK_DAYS + 50; i++) {
      days.add(ymd(cursor));
      cursor.setDate(cursor.getDate() - 1);
    }
    const run = recomputeRun(days, MON_FRI, "2026-08-14");
    expect(run.truncated).toBe(true);
    expect(run.current).toBeGreaterThan(100);
    // …and the ordinary case must NOT be flagged, or the flag says nothing.
    expect(
      recomputeRun(new Set(["2026-08-14"]), MON_FRI, "2026-08-14").truncated,
    ).toBeFalsy();
  });
});

describe("runIsFullyLedgered (#233)", () => {
  it("trusts a run that began at or after the instant coverage started", () => {
    // The run's first day began at local midnight on 08-12. Coverage started
    // 08-11, i.e. before it, so every engagement inside the run was recorded.
    expect(
      runIsFullyLedgered("2026-08-12", new Date("2026-08-11T09:00:00")),
    ).toBe(true);
  });

  it("refuses a run that began before coverage started, even by an hour", () => {
    // Coverage began at 09:00 on the run's OWN first day, so anything that
    // happened between midnight and 09:00 is missing from the ledger and the
    // recomputed length is a floor. Acting on it could revoke a badge the person
    // earned. This is the boundary the whole gate exists for.
    expect(
      runIsFullyLedgered("2026-08-12", new Date("2026-08-12T09:00:00")),
    ).toBe(false);
  });

  it("trusts a run whose first day began exactly at the coverage instant", () => {
    expect(runIsFullyLedgered("2026-08-12", parseYmd("2026-08-12"))).toBe(true);
  });

  it("refuses to act when there is no run", () => {
    // "No engagement anywhere in the ledger" and "no engagement ever" are not
    // the same claim, and only the second would justify zeroing a streak.
    expect(runIsFullyLedgered(null, new Date("2020-01-01T00:00:00"))).toBe(
      false,
    );
  });
});
