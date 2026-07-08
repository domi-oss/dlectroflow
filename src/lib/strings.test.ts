import { describe, it, expect } from "vitest";
import { STRINGS, t, type StringKey, type Voice } from "./strings";

describe("STRINGS map completeness", () => {
  it("every key has a non-empty plain string", () => {
    for (const key of Object.keys(STRINGS) as StringKey[]) {
      expect(STRINGS[key].plain, `key "${key}" plain is empty`).toBeTruthy();
      expect(STRINGS[key].plain.length, `key "${key}" plain is empty string`).toBeGreaterThan(0);
    }
  });

  it("every key has a non-empty playful string", () => {
    for (const key of Object.keys(STRINGS) as StringKey[]) {
      expect(STRINGS[key].playful, `key "${key}" playful is empty`).toBeTruthy();
      expect(STRINGS[key].playful.length, `key "${key}" playful is empty string`).toBeGreaterThan(0);
    }
  });
});

describe("t() function", () => {
  const cases: Array<[StringKey, Voice, string]> = [
    ["stat.pointsToday",    "plain",   "Points today"],
    ["stat.pointsToday",    "playful", "Crumbs today"],
    ["stat.currentStreak",  "plain",   "Current streak"],
    ["stat.currentStreak",  "playful", "On a roll"],
    ["stat.focusMinsToday", "plain",   "Focus mins today"],
    ["stat.focusMinsToday", "playful", "Time at the table"],
    ["stat.stepsToday",     "plain",   "Steps today"],
    ["stat.stepsToday",     "playful", "Bites today"],
    ["action.breakdown",    "plain",   "Break into steps"],
    ["action.breakdown",    "playful", "🍿 Snack-size it"],
    ["nav.everything",      "plain",   "Everything"],
    ["nav.everything",      "playful", "🍱 Larder"],
    ["section.singleTask",  "plain",   "Single-task to-dos"],
    ["section.singleTask",  "playful", "😋 Quick bites"],
  ];

  for (const [key, voice, expected] of cases) {
    it(`t("${key}", "${voice}") → "${expected}"`, () => {
      expect(t(key, voice)).toBe(expected);
    });
  }

  it("returns plain variant when voice is plain", () => {
    const result = t("stat.totalPoints", "plain");
    expect(result).toBe("Total points earned");
  });

  it("returns playful variant when voice is playful", () => {
    const result = t("stat.totalPoints", "playful");
    expect(result).toBe("Total crumbs earned");
  });
});
