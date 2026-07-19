import { describe, it, expect } from "vitest";
import {
  isValidHHmm,
  reviewNudgeDayKey,
  shouldFireReviewNudge,
} from "./daily-review-nudge";

describe("isValidHHmm", () => {
  it("accepts well-formed 24h times", () => {
    expect(isValidHHmm("00:00")).toBe(true);
    expect(isValidHHmm("09:05")).toBe(true);
    expect(isValidHHmm("17:00")).toBe(true);
    expect(isValidHHmm("23:59")).toBe(true);
  });

  it("rejects out-of-range or malformed values", () => {
    expect(isValidHHmm("24:00")).toBe(false);
    expect(isValidHHmm("12:60")).toBe(false);
    expect(isValidHHmm("7:00")).toBe(false); // needs zero-padded hour
    expect(isValidHHmm("1700")).toBe(false);
    expect(isValidHHmm("")).toBe(false);
    expect(isValidHHmm("noon")).toBe(false);
  });
});

describe("reviewNudgeDayKey", () => {
  it("builds the localStorage day-key with a zero-padded YYYY-MM-DD", () => {
    expect(reviewNudgeDayKey(new Date(2026, 6, 3))).toBe(
      "dlectroflow-review-nudge-fired-2026-07-03",
    );
    expect(reviewNudgeDayKey(new Date(2026, 11, 25))).toBe(
      "dlectroflow-review-nudge-fired-2026-12-25",
    );
  });
});

describe("shouldFireReviewNudge", () => {
  const at = (h: number, min = 0) => {
    const d = new Date(2026, 6, 18);
    d.setHours(h, min, 0, 0);
    return d;
  };

  it("does not fire when the preference is off", () => {
    expect(
      shouldFireReviewNudge({
        now: at(18),
        dailyReviewNudgeTime: "17:00",
        notifyDailyReview: false,
        alreadyFiredToday: false,
      }),
    ).toBe(false);
  });

  it("does not fire when it already fired today", () => {
    expect(
      shouldFireReviewNudge({
        now: at(18),
        dailyReviewNudgeTime: "17:00",
        notifyDailyReview: true,
        alreadyFiredToday: true,
      }),
    ).toBe(false);
  });

  it("does not fire before the nudge time", () => {
    expect(
      shouldFireReviewNudge({
        now: at(16, 59),
        dailyReviewNudgeTime: "17:00",
        notifyDailyReview: true,
        alreadyFiredToday: false,
      }),
    ).toBe(false);
  });

  it("fires exactly at the nudge time", () => {
    expect(
      shouldFireReviewNudge({
        now: at(17, 0),
        dailyReviewNudgeTime: "17:00",
        notifyDailyReview: true,
        alreadyFiredToday: false,
      }),
    ).toBe(true);
  });

  it("fires after the nudge time", () => {
    expect(
      shouldFireReviewNudge({
        now: at(20, 30),
        dailyReviewNudgeTime: "17:00",
        notifyDailyReview: true,
        alreadyFiredToday: false,
      }),
    ).toBe(true);
  });

  it("falls back to 17:00 when the time string is malformed", () => {
    expect(
      shouldFireReviewNudge({
        now: at(16, 59),
        dailyReviewNudgeTime: "garbage",
        notifyDailyReview: true,
        alreadyFiredToday: false,
      }),
    ).toBe(false);
    expect(
      shouldFireReviewNudge({
        now: at(17, 1),
        dailyReviewNudgeTime: "garbage",
        notifyDailyReview: true,
        alreadyFiredToday: false,
      }),
    ).toBe(true);
  });
});
