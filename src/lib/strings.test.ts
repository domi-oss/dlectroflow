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

describe("Task 2 — inbox/focus/breakdown keys (plain vs playful)", () => {
  // freshness.aging
  it('t("freshness.aging", "plain") → "Aging"', () => {
    expect(t("freshness.aging", "plain")).toBe("Aging");
  });
  it('t("freshness.aging", "playful") → "Softening"', () => {
    expect(t("freshness.aging", "playful")).toBe("Softening");
  });

  // section.needsReview
  it('t("section.needsReview", "plain") → "Needs review"', () => {
    expect(t("section.needsReview", "plain")).toBe("Needs review");
  });
  it('t("section.needsReview", "playful") → "Needs review"', () => {
    expect(t("section.needsReview", "playful")).toBe("Needs review");
  });

  // action.breakdown (used in InboxView row button)
  it('t("action.breakdown", "plain") → "Break into steps"', () => {
    expect(t("action.breakdown", "plain")).toBe("Break into steps");
  });
  it('t("action.breakdown", "playful") → "🍿 Snack-size it"', () => {
    expect(t("action.breakdown", "playful")).toBe("🍿 Snack-size it");
  });

  // action.addTodo (used in InboxView row button)
  it('t("action.addTodo", "plain") → "Add to-do"', () => {
    expect(t("action.addTodo", "plain")).toBe("Add to-do");
  });
  it('t("action.addTodo", "playful") → "🍽️ Add to-do"', () => {
    expect(t("action.addTodo", "playful")).toBe("🍽️ Add to-do");
  });

  // focus timer keys
  it('t("focus.startTimer", "plain") → "▶ Start focusing"', () => {
    expect(t("focus.startTimer", "plain")).toBe("▶ Start focusing");
  });
  it('t("focus.startTimer", "playful") → "▶ Start focusing"', () => {
    expect(t("focus.startTimer", "playful")).toBe("▶ Start focusing");
  });
  it('t("focus.complete", "plain") → "✅ Complete"', () => {
    expect(t("focus.complete", "plain")).toBe("✅ Complete");
  });
  it('t("focus.pause", "plain") → "⏸️ Pause"', () => {
    expect(t("focus.pause", "plain")).toBe("⏸️ Pause");
  });
  it('t("focus.resume", "plain") → "▶ Resume"', () => {
    expect(t("focus.resume", "plain")).toBe("▶ Resume");
  });
  it('t("focus.giveUp", "plain") → "Pause for now"', () => {
    expect(t("focus.giveUp", "plain")).toBe("Pause for now");
  });
  it('t("focus.giveUp", "playful") → "⏸️ Pause for now"', () => {
    expect(t("focus.giveUp", "playful")).toBe("⏸️ Pause for now");
  });
  it('t("focus.timesUp", "plain") → "Time\'s up — did you finish?"', () => {
    expect(t("focus.timesUp", "plain")).toBe("Time's up — did you finish?");
  });
  it('t("focus.timesUp", "playful") → "⏰ Time\'s up — did you finish?"', () => {
    expect(t("focus.timesUp", "playful")).toBe("⏰ Time's up — did you finish?");
  });
  it('t("focus.yesDone", "plain") → "✅ Yes, done!"', () => {
    expect(t("focus.yesDone", "plain")).toBe("✅ Yes, done!");
  });
  it('t("focus.notYet", "plain") → "Not yet"', () => {
    expect(t("focus.notYet", "plain")).toBe("Not yet");
  });
  it('t("focus.notYet", "playful") → "🔁 Not yet"', () => {
    expect(t("focus.notYet", "playful")).toBe("🔁 Not yet");
  });
  it('t("focus.nextStep", "plain") → "Focus the next step"', () => {
    expect(t("focus.nextStep", "plain")).toBe("Focus the next step");
  });
  it('t("focus.nextStep", "playful") → "Focus the next bite"', () => {
    expect(t("focus.nextStep", "playful")).toBe("Focus the next bite");
  });

  // step counter (used in FocusTimer title)
  it('t("step.counter", "plain") → "Step"', () => {
    expect(t("step.counter", "plain")).toBe("Step");
  });
  it('t("step.counter", "playful") → "bite"', () => {
    expect(t("step.counter", "playful")).toBe("bite");
  });

  // breakdown confirm keys
  it('t("breakdown.looksRight", "plain") → "Looks right"', () => {
    expect(t("breakdown.looksRight", "plain")).toBe("Looks right");
  });
  it('t("breakdown.looksRight", "playful") → "👍 Looks right"', () => {
    expect(t("breakdown.looksRight", "playful")).toBe("👍 Looks right");
  });

  // action.fewerSteps / action.moreSteps (resize quick-replies)
  it('t("action.fewerSteps", "plain") → "Fewer steps"', () => {
    expect(t("action.fewerSteps", "plain")).toBe("Fewer steps");
  });
  it('t("action.fewerSteps", "playful") → "🥖 Fewer steps"', () => {
    expect(t("action.fewerSteps", "playful")).toBe("🥖 Fewer steps");
  });
  it('t("action.moreSteps", "plain") → "More steps"', () => {
    expect(t("action.moreSteps", "plain")).toBe("More steps");
  });
  it('t("action.moreSteps", "playful") → "🍞 More steps"', () => {
    expect(t("action.moreSteps", "playful")).toBe("🍞 More steps");
  });

  // action.startFocus / action.backToInbox (breakdown confirmed state)
  it('t("action.startFocus", "plain") → "Start focusing"', () => {
    expect(t("action.startFocus", "plain")).toBe("Start focusing");
  });
  it('t("action.startFocus", "playful") → "🍽️ Start focusing"', () => {
    expect(t("action.startFocus", "playful")).toBe("🍽️ Start focusing");
  });
  it('t("action.backToInbox", "plain") → "Back to inbox"', () => {
    expect(t("action.backToInbox", "plain")).toBe("Back to inbox");
  });
  it('t("action.backToInbox", "playful") → "🍳 Back to inbox"', () => {
    expect(t("action.backToInbox", "playful")).toBe("🍳 Back to inbox");
  });
});

describe("Plain voice is emoji-free for nav and badge keys", () => {
  // Allowed functional glyphs in plain voice: status dots, ✅, ▶/⏸/➕/➖, 🗑️, 🔒, ⚠️
  const FUNCTIONAL_GLYPHS = /[✅▶⏸️➕➖🗑🔒⚠🟢🟡🟠🔴]/gu;
  // Matches any decorative emoji (strips functional glyphs first)
  const hasEmoji = (s: string) => /\p{Emoji_Presentation}/u.test(s.replace(FUNCTIONAL_GLYPHS, ""));

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
    "section.needsReview",
    "action.addTodo",
    "focus.giveUp",
    "focus.nextStep",
    "breakdown.looksRight",
    "action.fewerSteps",
    "action.moreSteps",
    "action.startFocus",
    "action.backToInbox",
    "focus.timesUp",
    "focus.yesDone",
  ];

  for (const key of plainOnlyKeys) {
    it(`t("${key}", "plain") contains no emoji`, () => {
      expect(hasEmoji(t(key, "plain"))).toBe(false);
    });
  }
});
