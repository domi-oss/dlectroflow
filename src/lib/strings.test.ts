import { describe, it, expect } from "vitest";
import { STRINGS, t, type StringKey, type Voice } from "./strings";
import { BadgeKey } from "./constants";

describe("STRINGS map completeness", () => {
  it("every key has a non-empty plain string", () => {
    for (const key of Object.keys(STRINGS) as StringKey[]) {
      expect(STRINGS[key].plain, `key "${key}" plain is empty`).toBeTruthy();
      expect(
        STRINGS[key].plain.length,
        `key "${key}" plain is empty string`,
      ).toBeGreaterThan(0);
    }
  });

  it("every key has a non-empty playful string", () => {
    for (const key of Object.keys(STRINGS) as StringKey[]) {
      expect(
        STRINGS[key].playful,
        `key "${key}" playful is empty`,
      ).toBeTruthy();
      expect(
        STRINGS[key].playful.length,
        `key "${key}" playful is empty string`,
      ).toBeGreaterThan(0);
    }
  });
});

describe("every awarded BadgeKey has a STRINGS label", () => {
  // Guards the dashboard regression where awarded badges (e.g. beat_best_streak)
  // rendered their raw DB key because BADGE_STRING_KEYS/STRINGS dropped them.
  for (const key of Object.values(BadgeKey)) {
    it(`badge.${key} exists`, () => {
      expect(STRINGS[`badge.${key}` as StringKey]).toBeTruthy();
    });
  }
});

describe("t() function", () => {
  const cases: Array<[StringKey, Voice, string]> = [
    ["stat.pointsToday", "plain", "Points today"],
    ["stat.pointsToday", "playful", "Crumbs today"],
    ["stat.currentStreak", "plain", "Current streak"],
    ["stat.currentStreak", "playful", "On a roll"],
    ["stat.focusMinsToday", "plain", "Focus mins today"],
    ["stat.focusMinsToday", "playful", "Time at the table"],
    ["stat.stepsToday", "plain", "Steps today"],
    ["stat.stepsToday", "playful", "Bites today"],
    ["action.breakdown", "plain", "Break into steps"],
    ["action.breakdown", "playful", "🍿 Snack-size it"],
    ["action.complete", "plain", "✓ Complete"],
    ["action.complete", "playful", "✓ Complete"],
    ["action.reopen", "plain", "Reopen"],
    ["nav.everything", "plain", "Library"],
    ["nav.everything", "playful", "🍱 Larder"],
    ["nav.inbox", "plain", "Inbox"],
    ["nav.inbox", "playful", "🧠 Inbox"],
    ["nav.dashboard", "plain", "Activity"],
    ["nav.dashboard", "playful", "🎉 Activity"],
    ["section.singleTask", "plain", "Single-task to-dos"],
    ["section.singleTask", "playful", "😋 Quick bites"],
    ["section.completed", "plain", "Completed"],
    ["section.completedToday", "plain", "Completed today"],
    ["heading.bestStreaks", "plain", "Best streaks"],
    ["heading.bestStreaks", "playful", "🏆 Best streaks"],
    ["badge.first_breakdown", "plain", "First breakdown"],
    ["badge.first_breakdown", "playful", "🍰 First Slice"],
    ["badge.streak_5", "plain", "Full work week"],
    ["badge.streak_5", "playful", "🔥 Full Week"],
    ["badge.inbox_zero", "plain", "Inbox zero"],
    ["badge.comeback", "plain", "Comeback"],
    ["badge.ten_steps_day", "plain", "10 steps in a day"],
    ["badge.beat_best_streak", "plain", "Beat your best streak"],
    ["bucket.empty", "plain", "Nothing here yet"],
    ["action.moveTo", "plain", "Move to…"],
    ["prompt.breakNow", "plain", "Break into steps now?"],
    ["action.reviewNow", "plain", "Review now"],
    ["action.reviewNow", "playful", "🥫 Review now"],
    // v6 dropdown full-labels + short button
    ["action.breakdownFull", "plain", "Break into smaller steps"],
    ["action.addTodoFull", "plain", "Add as single task to do"],
    ["action.saveShort", "plain", "Save"],
    ["action.completeFull", "plain", "Mark as completed"],
    ["action.editTitle", "plain", "Edit task title"],
    ["action.schedule", "plain", "Schedule"],
    // #25 step-row labels — voice-aware (plain literal, playful food-themed)
    ["step.startFocus", "plain", "▶ Start Focus"],
    ["step.startFocus", "playful", "▶ Start Focus"],
    ["step.resumeFocus", "plain", "▶ Resume Focus"],
    ["step.resumeFocus", "playful", "▶ Resume Focus"],
    ["step.startFocusTimer", "plain", "Start focus timer"],
    ["step.resumeFocusTimer", "plain", "Resume focus timer"],
    ["step.resumeFocusTimer", "playful", "🍴 Resume focus timer"],
    ["step.complete", "plain", "Complete step"],
    ["step.complete", "playful", "✅ Complete step"],
    ["step.editEstimate", "plain", "Edit time estimate"],
    ["step.editTitle", "plain", "Edit step title"],
    ["step.sendToReview", "plain", "Send back to review"],
    ["step.sendToReview", "playful", "🥫 Send back to review"],
    // welcome-card (#8) — inline links are voice-aware: Library (plain) vs
    // Larder (playful); the Focus Timer + Help section labels are shared.
    ["welcome.libraryLink", "plain", "Library"],
    ["welcome.libraryLink", "playful", "Larder"],
    ["welcome.focusLink", "plain", "Focus Timer"],
    ["welcome.helpLink", "plain", "Help section"],
    // Phase 6 — notifications + auto-save
    ["settings.saved", "plain", "Saved ✓"],
    ["settings.saved", "playful", "Saved ✓"],
    ["notify.heading", "plain", "Notifications"],
    ["notify.heading", "playful", "🔔 Notifications"],
    ["notify.roundup", "plain", "End-of-day round-up"],
    ["notify.roundup", "playful", "🌇 End-of-day round-up"],
    ["notify.aging", "plain", "Aging reminders"],
    ["notify.aging", "playful", "🍞 Aging reminders"],
    ["notify.dailyReview", "plain", "Daily review nudge"],
    ["notify.dailyReview", "playful", "🌙 Daily review nudge"],
    ["notify.nudgeTime", "plain", "Nudge time"],
    ["notify.nudgeTitle", "plain", "Time for your daily review"],
    ["notify.enable", "plain", "Enable desktop notifications"],
    ["notify.enable", "playful", "🔔 Enable desktop notifications"],
    // #11 — guest read-only settings + onboarding help banner
    ["settings.ownerOnly", "plain", "Owner-only"],
    ["settings.ownerOnly", "playful", "Owner-only"],
    ["guest.newHere", "plain", "New here?"],
    ["guest.helpCta", "plain", "See the help & docs →"],
    ["guest.helpCta", "playful", "🆘 See the help & docs →"],
    // Settings footer link — dedicated key, both words capitalised, space intact.
    ["settings.helpDocs", "plain", "Help & Docs"],
    ["settings.helpDocs", "playful", "🆘 Help & Docs"],
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

describe("Task 4 — nav/menu/prompt/confirm keys (plain vs playful)", () => {
  // nav.focusTimer
  it('t("nav.focusTimer", "plain") → "Focus Timer"', () => {
    expect(t("nav.focusTimer", "plain")).toBe("Focus Timer");
  });
  it('t("nav.focusTimer", "playful") → "⏱️ Focus Timer"', () => {
    expect(t("nav.focusTimer", "playful")).toBe("⏱️ Focus Timer");
  });

  // nav.settings
  it('t("nav.settings", "plain") → "Settings"', () => {
    expect(t("nav.settings", "plain")).toBe("Settings");
  });
  it('t("nav.settings", "playful") → "⚙️ Settings"', () => {
    expect(t("nav.settings", "playful")).toBe("⚙️ Settings");
  });

  // capture.confirm
  it('t("capture.confirm", "plain") → "captured ✓"', () => {
    expect(t("capture.confirm", "plain")).toBe("captured ✓");
  });
  it('t("capture.confirm", "playful") → "captured ✓"', () => {
    expect(t("capture.confirm", "playful")).toBe("captured ✓");
  });

  // prompt.stillNeeded
  it('t("prompt.stillNeeded", "plain") → "This has been sitting a while — still needed?"', () => {
    expect(t("prompt.stillNeeded", "plain")).toBe(
      "This has been sitting a while — still needed?",
    );
  });
  it('t("prompt.stillNeeded", "playful") → "🕐 This snack\'s been sitting a while — still want it?"', () => {
    expect(t("prompt.stillNeeded", "playful")).toBe(
      "🕐 This snack's been sitting a while — still want it?",
    );
  });

  // action.dismiss
  it('t("action.dismiss", "plain") → "Dismiss"', () => {
    expect(t("action.dismiss", "plain")).toBe("Dismiss");
  });
  it('t("action.dismiss", "playful") → "Not now"', () => {
    expect(t("action.dismiss", "playful")).toBe("Not now");
  });

  // action.stillNeeded
  it('t("action.stillNeeded", "plain") → "Still need it"', () => {
    expect(t("action.stillNeeded", "plain")).toBe("Still need it");
  });
  it('t("action.stillNeeded", "playful") → "Still want it"', () => {
    expect(t("action.stillNeeded", "playful")).toBe("Still want it");
  });

  // action.delete
  it('t("action.delete", "plain") → "Delete"', () => {
    expect(t("action.delete", "plain")).toBe("Delete");
  });
  it('t("action.delete", "playful") → "Delete"', () => {
    expect(t("action.delete", "playful")).toBe("Delete");
  });

  // action.cancel
  it('t("action.cancel", "plain") → "Cancel"', () => {
    expect(t("action.cancel", "plain")).toBe("Cancel");
  });
  it('t("action.cancel", "playful") → "Cancel"', () => {
    expect(t("action.cancel", "playful")).toBe("Cancel");
  });

  // link.seeAll
  it('t("link.seeAll", "plain") → "see all →"', () => {
    expect(t("link.seeAll", "plain")).toBe("see all →");
  });
  it('t("link.seeAll", "playful") → "see all →"', () => {
    expect(t("link.seeAll", "playful")).toBe("see all →");
  });

  // pill.toDo
  it('t("pill.toDo", "plain") → "▶ to-do"', () => {
    expect(t("pill.toDo", "plain")).toBe("▶ to-do");
  });
  it('t("pill.toDo", "playful") → "▶ to-do"', () => {
    expect(t("pill.toDo", "playful")).toBe("▶ to-do");
  });

  // progress.done
  it('t("progress.done", "plain") → "done"', () => {
    expect(t("progress.done", "plain")).toBe("done");
  });
  it('t("progress.done", "playful") → "done"', () => {
    expect(t("progress.done", "playful")).toBe("done");
  });

  // inbox.zero
  it('t("inbox.zero", "plain") → "Inbox zero. Nothing to review."', () => {
    expect(t("inbox.zero", "plain")).toBe("Inbox zero. Nothing to review.");
  });
  it('t("inbox.zero", "playful") → "🎉 Inbox zero! Nothing to review."', () => {
    expect(t("inbox.zero", "playful")).toBe(
      "🎉 Inbox zero! Nothing to review.",
    );
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
  it('t("focus.timesUp", "plain") → "Time\'s up — did you finish?"', () => {
    expect(t("focus.timesUp", "plain")).toBe("Time's up — did you finish?");
  });
  it('t("focus.timesUp", "playful") → "⏰ Time\'s up — did you finish?"', () => {
    expect(t("focus.timesUp", "playful")).toBe(
      "⏰ Time's up — did you finish?",
    );
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

  // task.scheduled / task.notScheduled (task page schedule indicator, #8 follow-up)
  it('t("task.scheduled", "plain") → "Scheduled ✓"', () => {
    expect(t("task.scheduled", "plain")).toBe("Scheduled ✓");
  });
  it('t("task.notScheduled", "plain") → "Not scheduled yet"', () => {
    expect(t("task.notScheduled", "plain")).toBe("Not scheduled yet");
  });
});

describe("library strings", () => {
  it("renames Everything → Library (plain) keeping Larder (playful)", () => {
    expect(t("nav.everything", "plain")).toBe("Library");
    expect(t("nav.everything", "playful")).toBe("🍱 Larder");
  });
  it("has the new bulk/meta keys in both voices", () => {
    for (const k of [
      "lib.select",
      "lib.selectAll",
      "lib.selected",
      "lib.openTask",
      "lib.deleteConfirm",
      "lib.next",
      "lib.minLeft",
      "lib.min",
      "lib.editEstimate",
    ] as const) {
      expect(t(k, "plain")).toBeTruthy();
      expect(t(k, "playful")).toBeTruthy();
    }
  });
});

describe("Plain voice is emoji-free for nav and badge keys", () => {
  // Allowed functional glyphs in plain voice: status dots, ✅, ▶/⏸/➕/➖, 🗑️, 🔒, ⚠️
  const FUNCTIONAL_GLYPHS = /[✅▶⏸️➕➖🗑🔒⚠🟢🟡🟠🔴]/gu;
  // Matches any decorative emoji (strips functional glyphs first)
  const hasEmoji = (s: string) =>
    /\p{Emoji_Presentation}/u.test(s.replace(FUNCTIONAL_GLYPHS, ""));

  const plainOnlyKeys: StringKey[] = [
    "nav.inbox",
    "nav.dashboard",
    "nav.everything",
    "nav.done",
    "nav.focusTimer",
    "nav.settings",
    "nav.help",
    "heading.bestStreaks",
    "badge.first_breakdown",
    "badge.first_schedule",
    "badge.first_focus",
    "badge.task_complete",
    "badge.streak_5",
    "badge.inbox_zero",
    "badge.comeback",
    "badge.ten_steps_day",
    "badge.beat_best_streak",
    "section.needsReview",
    "section.completed",
    "section.completedToday",
    "action.complete",
    "action.reopen",
    "action.addTodo",
    "action.dismiss",
    "action.stillNeeded",
    "action.delete",
    "action.cancel",
    "action.moveTo",
    "action.breakdownFull",
    "action.addTodoFull",
    "action.saveShort",
    "action.completeFull",
    "action.editTitle",
    "action.schedule",
    "capture.confirm",
    "prompt.stillNeeded",
    "prompt.breakNow",
    "action.reviewNow",
    "bucket.empty",
    "inbox.zero",
    "focus.nextStep",
    "breakdown.looksRight",
    "action.fewerSteps",
    "action.moreSteps",
    "action.addStep",
    "action.removeStep",
    "action.startFocus",
    "action.backToInbox",
    "focus.timesUp",
    "focus.yesDone",
    "link.seeAll",
    "pill.toDo",
    "progress.done",
    "action.reopenSelected",
    "action.reopenAll",
    "prompt.reopenWhich",
    // #25 step-row labels — plain variants are literal + emoji-free
    "step.startFocus",
    "step.resumeFocus",
    "step.startFocusTimer",
    "step.resumeFocusTimer",
    "step.complete",
    "step.editEstimate",
    "step.editTitle",
    "step.sendToReview",
    // Phase 6 — plain notification/auto-save copy stays emoji/jargon-free
    // (✓ and → are functional glyphs, allowed in plain).
    "settings.saved",
    "settings.saveError",
    "notify.heading",
    "notify.intro",
    "notify.roundup",
    "notify.roundupHint",
    "notify.aging",
    "notify.agingHint",
    "notify.dailyReview",
    "notify.dailyReviewHint",
    "notify.nudgeTime",
    "notify.enable",
    "notify.blocked",
    "notify.nudgeTitle",
    "notify.nudgeBody",
    // Library "Everything" hub (#8 Phase 3) — plain variants emoji-free
    "action.back",
    "lib.tab.singleTask",
    "lib.tab.multiStep",
    "lib.intro",
    "lib.plated.hint",
    "lib.pantry.hint",
    "lib.sorted.hint",
    "lib.done.hint",
    "lib.added",
    "lib.wakes",
    "lib.aToDo",
    "lib.select",
    "lib.selectAll",
    "lib.selected",
    "lib.openTask",
    "lib.deleteConfirm",
    "lib.next",
    "lib.minLeft",
    "lib.min",
    "lib.editEstimate",
    // Task working-view schedule indicator (#8 follow-up) — plain is literal.
    "task.scheduled",
    "task.notScheduled",
    // #11 — guest read-only settings + onboarding help (plain stays emoji-free;
    // → is a functional glyph, allowed in plain).
    "settings.ownerOnly",
    "settings.modelOwnerHint",
    "settings.integrationsOwnerHint",
    "guest.newHere",
    "guest.helpCta",
  ];

  for (const key of plainOnlyKeys) {
    it(`t("${key}", "plain") contains no emoji`, () => {
      expect(hasEmoji(t(key, "plain"))).toBe(false);
    });
  }
});
