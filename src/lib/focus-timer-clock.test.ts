import { describe, it, expect } from "vitest";
import {
  MIN_REMAINING_SEC,
  mmss,
  applyTimeDelta,
  netAddedMin,
  timerFraction,
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
