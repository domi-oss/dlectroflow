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
    ["nav.inbox",           "plain",   "Inbox"],
    ["nav.inbox",           "playful", "🧠 Inbox"],
    ["nav.dashboard",       "plain",   "Dashboard"],
    ["nav.dashboard",       "playful", "🎉 Dashboard"],
    ["section.singleTask",  "plain",   "Single-task to-dos"],
    ["section.singleTask",  "playful", "😋 Quick bites"],
    ["heading.bestStreaks",  "plain",   "Best streaks"],
    ["heading.bestStreaks",  "playful", "🏆 Best streaks"],
    ["badge.first_breakdown","plain",   "First breakdown"],
    ["badge.first_breakdown","playful", "🍰 First Slice"],
    ["badge.streak_5",       "plain",   "Full work week"],
    ["badge.streak_5",       "playful", "🔥 Full Week"],
    ["badge.inbox_zero",     "plain",   "Inbox zero"],
    ["badge.comeback",       "plain",   "Comeback"],
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

describe("Plain voice is emoji-free for nav and badge keys", () => {
  // Matches any Unicode emoji character (basic range + ZWJ sequences)
  const hasEmoji = (s: string) => /\p{Emoji_Presentation}/u.test(s);

  const plainOnlyKeys: StringKey[] = [
    "nav.inbox",
    "nav.dashboard",
    "nav.everything",
    "nav.done",
    "heading.bestStreaks",
    "badge.first_breakdown",
    "badge.first_schedule",
    "badge.first_focus",
    "badge.task_complete",
    "badge.streak_5",
    "badge.inbox_zero",
    "badge.comeback",
  ];

  for (const key of plainOnlyKeys) {
    it(`t("${key}", "plain") contains no emoji`, () => {
      expect(hasEmoji(t(key, "plain"))).toBe(false);
    });
  }
});
