import { describe, it, expect } from "vitest";
import {
  MIN_REMAINING_SEC,
  DURATION_PRESET_MIN,
  DEFAULT_DURATION_MIN,
  durationChoices,
  normalizeEstMin,
  mmss,
  applyTimeDelta,
  netAddedMin,
  timerFraction,
  remainingSecForSession,
  openSessionRemainingSec,
} from "@/lib/focus-timer-clock";

describe("mmss", () => {
  it("formats minutes:seconds, zero-padding seconds and flooring negatives to 0:00", () => {
    expect(mmss(0)).toBe("0:00");
    expect(mmss(9)).toBe("0:09");
    expect(mmss(65)).toBe("1:05");
    expect(mmss(600)).toBe("10:00");
    expect(mmss(-5)).toBe("0:00");
  });
});

describe("applyTimeDelta", () => {
  it("adds time to both total and remaining", () => {
    expect(applyTimeDelta({ totalSec: 600, remainingSec: 300 }, 300)).toEqual({
      totalSec: 900,
      remainingSec: 600,
    });
  });

  it("removes time from both when there is room", () => {
    expect(applyTimeDelta({ totalSec: 600, remainingSec: 300 }, -120)).toEqual({
      totalSec: 480,
      remainingSec: 180,
    });
  });

  it("clamps removal so remaining never drops below the 60s floor (total shrinks by the applied amount only)", () => {
    // remaining 90s, remove 5m: floor at 60s → only 30s actually removed.
    expect(applyTimeDelta({ totalSec: 300, remainingSec: 90 }, -300)).toEqual({
      totalSec: 270,
      remainingSec: MIN_REMAINING_SEC,
    });
  });

  it("is a no-op at the floor", () => {
    expect(applyTimeDelta({ totalSec: 240, remainingSec: 60 }, -300)).toEqual({
      totalSec: 240,
      remainingSec: 60,
    });
  });
});

describe("netAddedMin", () => {
  it("is signed vs the planned duration", () => {
    expect(netAddedMin(900, 600)).toBe(5); // +5m
    expect(netAddedMin(300, 600)).toBe(-5); // −5m
    expect(netAddedMin(600, 600)).toBe(0);
  });
});

describe("timerFraction", () => {
  it("is remaining/total, and 0 when total is 0", () => {
    expect(timerFraction(300, 600)).toBe(0.5);
    expect(timerFraction(0, 600)).toBe(0);
    expect(timerFraction(10, 0)).toBe(0);
  });
});

// #27 — true pause/resume. remainingSecForSession is the pure formula behind
// both the setup screen's "Resume (X left)" preview and the server actions'
// resume math, so a session's remaining time is computed identically
// everywhere (no drift between what the launcher shows and what resuming
// actually restores).
describe("remainingSecForSession", () => {
  const MIN = 60_000;

  it("plain countdown (never paused): remaining = planned − elapsed", () => {
    const startedAt = 0;
    expect(
      remainingSecForSession(
        { plannedMin: 25, startedAt, pausedAt: null, accumulatedPausedMs: 0 },
        10 * MIN, // 10 minutes elapsed
      ),
    ).toBe(15 * 60);
  });

  it("freezes remaining at the pause moment — later wall-clock time doesn't drain it", () => {
    const startedAt = 0;
    const pausedAt = 10 * MIN; // paused after 10 minutes
    const clock = {
      plannedMin: 25,
      startedAt,
      pausedAt,
      accumulatedPausedMs: 0,
    };
    // Asking "now" right after pausing…
    expect(remainingSecForSession(clock, 10 * MIN)).toBe(15 * 60);
    // …or a full day later while still paused — same frozen answer.
    expect(remainingSecForSession(clock, 10 * MIN + 24 * 60 * MIN)).toBe(
      15 * 60,
    );
  });

  it("after resume, accumulatedPausedMs excludes the pause interval from elapsed", () => {
    // Ran 10m, paused for 2h, resumed — accumulatedPausedMs now holds that gap.
    const startedAt = 0;
    const accumulatedPausedMs = 2 * 60 * MIN;
    const clock = {
      plannedMin: 25,
      startedAt,
      pausedAt: null,
      accumulatedPausedMs,
    };
    // "now" = 10m active + 2h paused = the instant of resume: still 15m left.
    expect(remainingSecForSession(clock, 10 * MIN + accumulatedPausedMs)).toBe(
      15 * 60,
    );
    // 3 more minutes of running after resume → 12m left.
    expect(remainingSecForSession(clock, 13 * MIN + accumulatedPausedMs)).toBe(
      12 * 60,
    );
  });

  it("supports multiple pause/resume cycles by summing accumulatedPausedMs", () => {
    const startedAt = 0;
    // Two prior pauses totalling 45 minutes of paused time.
    const accumulatedPausedMs = 45 * MIN;
    const clock = {
      plannedMin: 25,
      startedAt,
      pausedAt: null,
      accumulatedPausedMs,
    };
    expect(remainingSecForSession(clock, 25 * MIN + accumulatedPausedMs)).toBe(
      0,
    );
  });

  it("floors at 0 — never goes negative once time is fully elapsed", () => {
    const clock = {
      plannedMin: 5,
      startedAt: 0,
      pausedAt: null,
      accumulatedPausedMs: 0,
    };
    expect(remainingSecForSession(clock, 999 * MIN)).toBe(0);
  });
});

// Extension (#27 follow-up) — task-total-remaining / row surfaces read
// Prisma rows (real Dates) straight off the wire; this wrapper does the
// Date→ms conversion once so pages don't hand-roll it at every call site.
describe("openSessionRemainingSec", () => {
  const MIN = 60_000;

  it("null/undefined session → null (nothing to report)", () => {
    expect(openSessionRemainingSec(null, Date.now())).toBeNull();
    expect(openSessionRemainingSec(undefined, Date.now())).toBeNull();
  });

  it("a paused session's remaining is frozen at the pause instant", () => {
    const startedAt = new Date("2026-07-26T10:00:00Z");
    const pausedAt = new Date("2026-07-26T10:10:00Z"); // paused after 10 min
    const session = {
      startedAt,
      pausedAt,
      accumulatedPausedMs: 0,
      plannedMin: 25,
    };
    // Rendered right away, or a day later — same frozen 15m answer.
    expect(openSessionRemainingSec(session, pausedAt.getTime())).toBe(15 * 60);
    expect(
      openSessionRemainingSec(session, pausedAt.getTime() + 24 * 60 * MIN),
    ).toBe(15 * 60);
  });

  it("an actively-running (never paused) session reports its live remaining as of `nowMs` — the snapshot-at-render answer", () => {
    const startedAt = new Date("2026-07-26T10:00:00Z");
    const session = {
      startedAt,
      pausedAt: null,
      accumulatedPausedMs: 0,
      plannedMin: 25,
    };
    const renderedAt = startedAt.getTime() + 10 * MIN; // rendered 10m in
    expect(openSessionRemainingSec(session, renderedAt)).toBe(15 * 60);
  });
});

// #66 — the setup screen's duration chip row replaces a free-type number input,
// so the offered set must always contain the value the ring is showing (or the
// user could not get back to it after tapping another chip).
describe("durationChoices", () => {
  // #138 — the ladder moved from 5/10/15/25 to 15/30/45/60. 25m was the largest
  // offer and real sessions routinely run longer, so anything over 25 needed
  // fiddling with the in-timer ±5 control to reach.
  it("offers the four presets, with the current estimate already among them", () => {
    expect(durationChoices(30)).toEqual([...DURATION_PRESET_MIN]);
    expect(durationChoices(60)).toEqual([15, 30, 45, 60]);
  });

  it("adds a chip for an off-preset estimate, in ascending order", () => {
    expect(durationChoices(7)).toEqual([7, 15, 30, 45, 60]);
    expect(durationChoices(1)).toEqual([1, 15, 30, 45, 60]);
    expect(durationChoices(25)).toEqual([15, 25, 30, 45, 60]);
    expect(durationChoices(90)).toEqual([15, 30, 45, 60, 90]);
  });

  it("never offers a sub-minute or non-integer chip (bad data clamps to 1m)", () => {
    expect(durationChoices(0)).toEqual([1, 15, 30, 45, 60]);
    expect(durationChoices(-30)).toEqual([1, 15, 30, 45, 60]);
    expect(durationChoices(7.4)).toEqual([7, 15, 30, 45, 60]);
    expect(durationChoices(Number.NaN)).toEqual([...DURATION_PRESET_MIN]);
  });

  // Duo review (#66): the chips normalize the estimate, so whatever seeds the
  // timer's plannedMin must normalize it the SAME way — otherwise the seeded
  // value isn't among the chips and the setup screen preselects nothing.
  it("always contains normalizeEstMin() of the same estimate", () => {
    for (const est of [0, -30, 1, 7, 7.4, 10, 24.5, 45, Number.NaN]) {
      expect(durationChoices(est)).toContain(normalizeEstMin(est));
    }
  });
});

describe("normalizeEstMin", () => {
  it("passes through a sane whole-minute estimate", () => {
    expect(normalizeEstMin(10)).toBe(10);
    expect(normalizeEstMin(45)).toBe(45);
  });

  it("floors bad/legacy data to 1m and rounds fractions (matches durationChoices)", () => {
    expect(normalizeEstMin(0)).toBe(1);
    expect(normalizeEstMin(-30)).toBe(1);
    expect(normalizeEstMin(7.4)).toBe(7);
    expect(normalizeEstMin(24.5)).toBe(25);
  });

  // #138 — the fallback used to be DURATION_PRESET_MIN[1], which the new ladder
  // would have silently turned into 30m. An unusable estimate is the LEAST
  // reason to commit someone to half an hour, so the fallback is now the
  // shortest offer, named rather than positional.
  it("falls back to the shortest preset when the estimate isn't a number", () => {
    expect(normalizeEstMin(Number.NaN)).toBe(15);
    expect(normalizeEstMin(Number.NaN)).toBe(DEFAULT_DURATION_MIN);
    expect(DEFAULT_DURATION_MIN).toBe(Math.min(...DURATION_PRESET_MIN));
  });

  it("keeps the fallback among the offered chips, so Start is never 0m", () => {
    expect(durationChoices(Number.NaN)).toContain(DEFAULT_DURATION_MIN);
  });
});
