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
    // #253 — no leading tick. The glyph cost a permanently-visible row control
    // width it did not earn at 360px, and it said nothing the word did not.
    ["action.complete", "plain", "Complete"],
    ["action.complete", "playful", "Complete"],
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
    ["prompt.breakNow", "playful", "🍿 Snack-size it now?"],
    ["action.reviewNow", "plain", "Review now"],
    ["action.reviewNow", "playful", "🥫 Review now"],
    // v6 dropdown full-labels + short button.
    //
    // #253 renamed three of them so each names the STATE IT PRODUCES in the words
    // the destination bucket already uses — "multi-step to-do" and "single-task
    // to-do" are `section.multiStep` / `section.singleTask`, and Schedule says
    // where the row is actually sent. `action.completeFull` was left alone in that
    // pass and the pair is the reason why: `section.completed` reads "Completed",
    // so "Mark as completed" already agreed with its destination and a draft
    // "Mark as complete" would have broken the agreement it was meant to create.
    // The app-wide sweep of the same rule is #259; #253 renames only the ▾ entries
    // it renders. Both voices are pinned here because the rename has to carry the
    // playful variant with it (#86) — same emoji, new words.
    ["action.breakdownFull", "plain", "Add as multi-step to-do"],
    ["action.breakdownFull", "playful", "🍿 Add as multi-step to-do"],
    // #253 F1 — the navigating twin, split off `prompt.breakNow`. Both are pinned
    // here BY VALUE because the whole point of the split is that they diverge: the
    // menu entry is an imperative, the card's CTA keeps its question mark. A future
    // "tidy" that re-merges them reds two cases rather than none.
    //
    // It must also stay distinct from `action.breakdown`, the SHORT inline CTA on the
    // same row — a dedicated case for that sits at the foot of this file, because a
    // value assertion alone would not notice the two converging.
    ["action.breakNow", "plain", "Break down in the editor"],
    ["action.breakNow", "playful", "🍿 Break down in the editor"],
    ["action.addTodoFull", "plain", "Add as single-task to-do"],
    ["action.addTodoFull", "playful", "🍽️ Add as single-task to-do"],
    ["action.saveShort", "plain", "Save"],
    ["action.completeFull", "plain", "Mark as completed"],
    ["action.editTitle", "plain", "Edit task title"],
    ["action.schedule", "plain", "Schedule to calendar (send to Google Tasks)"],
    [
      "action.schedule",
      "playful",
      "🗓️ Schedule to calendar (send to Google Tasks)",
    ],
    // #253 — the same slot when the Google path is not usable yet. These exist
    // because the row's ▾ entry stopped being an inline `Connect Google →` link and
    // became NAVIGATION into the Integrations settings section, which means the
    // state has to be readable from the label. Both name the destination first and
    // the obstacle second, and both voices are pinned because the playful column
    // carries the same words with its existing emoji (#86 freezes the register).
    //
    // ⚠️ The wording is load-bearing for #128, not cosmetic: a row that says
    // "(not connected)" and takes you to settings is not a connect control, which
    // is what lets that issue's "prefer a personal account" caveat consolidate at
    // the three controls that do connect instead of being repeated per row.
    [
      "action.scheduleNotConnected",
      "plain",
      "Schedule to calendar (not connected)",
    ],
    [
      "action.scheduleNotConnected",
      "playful",
      "🗓️ Schedule to calendar (not connected)",
    ],
    [
      "action.scheduleReconnect",
      "plain",
      "Schedule to calendar (reconnect needed)",
    ],
    [
      "action.scheduleReconnect",
      "playful",
      "🗓️ Schedule to calendar (reconnect needed)",
    ],
    // #253 — one key for "open this row's focus timer" on an ITEM row, replacing
    // three spellings of one destination: two hard-coded "Start visual focus timer"
    // literals in `inbox-view.tsx` and `library-rows.tsx` reaching for
    // `step.startFocusTimer`, a STEP-grain key naming an action on an item. The
    // plain value is the inbox's existing wording, so this de-duplicated without
    // changing what anybody reads. `step.startFocusTimer` / `step.resumeFocusTimer`
    // survive for `task-steps.tsx`, where the row IS a step and the resumable
    // variant is real; whether the two grains converge is #259's call.
    ["action.startFocusTimer", "plain", "Start visual focus timer"],
    ["action.startFocusTimer", "playful", "🍽️ Start visual focus timer"],
    // #253 — the one destination the canonical entries did not already cover when
    // the nested `Move to…` picker was removed. Same phrase and same emoji as
    // `step.sendToReview`, pinned side by side so the two grains cannot drift apart
    // while #259 decides whether they merge.
    ["action.sendToReview", "plain", "Send back to review"],
    ["action.sendToReview", "playful", "🥫 Send back to review"],
    ["step.sendToReview", "plain", "Send back to review"],
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
    // #118 — the integrations shell is for a signed-OUT caller now, not a
    // non-owner. Literal in both voices; the 🔒 lives in the hint's playful copy.
    ["settings.integrationsSignedOut", "plain", "Sign in"],
    ["settings.integrationsSignedOut", "playful", "Sign in"],
    ["settings.accountHeading", "plain", "Account"],
    ["settings.accountKeyLabel", "plain", "API key"],
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

  // inbox.newAccount (#111) — the OTHER empty inbox. Both voices are the LEAD
  // of a sentence that newAccountLine() finishes with the account, so neither
  // may carry closing punctuation: "…a new account. (ada, signed in with
  // GitLab)" is two sentences where the copy is meant to be one.
  it('t("inbox.newAccount", "plain") → "Nothing here yet — this is a new account"', () => {
    expect(t("inbox.newAccount", "plain")).toBe(
      "Nothing here yet — this is a new account",
    );
  });
  it('t("inbox.newAccount", "playful") → "🍳 Nothing here yet — this account is brand new"', () => {
    expect(t("inbox.newAccount", "playful")).toBe(
      "🍳 Nothing here yet — this account is brand new",
    );
  });
  it("inbox.newAccount ends unpunctuated in both voices", () => {
    for (const voice of ["plain", "playful"] as const) {
      expect(t("inbox.newAccount", voice)).not.toMatch(/[.!?]$/);
    }
  });

  // The two empty-inbox strings must stay DISTINGUISHABLE: #111 exists because
  // one message was doing both jobs. "Inbox zero" is a congratulation for
  // clearing a queue and must never be what a brand-new account is shown.
  it("inbox.newAccount never says “inbox zero”", () => {
    for (const voice of ["plain", "playful"] as const) {
      expect(t("inbox.newAccount", voice).toLowerCase()).not.toContain(
        "inbox zero",
      );
    }
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

  // action.addTodo — NO consumer since #253 moved this act into the row's ▾ list,
  // where it renders `action.addTodoFull` ("Add as single-task to-do"). The key
  // and these two cases stay: `t()` is the public surface and a self-hoster's
  // voice override can still reach it, so its plain/playful pair is worth pinning.
  // The comment is corrected rather than deleted because "used in InboxView row
  // button" is what a reader would otherwise grep for and not find.
  //
  // `action.editTitle` is in the same state, for the same reason and on this
  // precedent — #253 dropped the ▾ "Edit task title" entry as a mirror of the
  // row's ✎ pencil. Its cases live in the table above.
  //
  // Substitute review of record, !356 — this said "the second key in this state",
  // which is the four-count era's framing. There are TEN, and the authoritative
  // list plus the re-derivation recipe are in `strings.ts` above `action.moveTo`;
  // this file is deliberately not a second copy of that list, because two copies
  // is how it went stale twice. A reader arrives here by following the recipe's own
  // allowlist (`strings.ts` AND `strings.test.ts`), so it must not contradict it.
  //
  // FOUR of the ten have no case pinned in this file: `action.confirmSteps`,
  // `focus.pauseForNow`, `focus.hyper.turnOff` and `focus.launcher.intro`.
  //
  // Four, not five (Duo review round 5, !356 — this comment contradicted the list
  // it had just promised not to contradict, in the sentence directly above). The
  // five it named came from the recipe's ELEVEN-key output and included
  // `freshness.recent`, which `strings.ts` documents as the recipe's one
  // over-report: live, reached by a computed lookup, and therefore not one of the
  // ten at all. `focus.complete` (:429) and `pill.toDo` (:313, :316) both do have
  // pinned cases, so neither belongs in a "no case pinned" list either.
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
  // #138 — the time-up copy, decided 2026-07-31. Each option COMPLETES the
  // sentence the heading asks, so the three read as parallel answers rather than
  // a verdict plus a menu. "ask Claude" names the model, not "AI": the very next
  // screen already says "Claude is re-estimating…", and "with AI" describes the
  // implementation instead of what the user gets.
  it('t("focus.timesUp", "plain") → "How did that go?"', () => {
    expect(t("focus.timesUp", "plain")).toBe("How did that go?");
  });
  it('t("focus.timesUp", "playful") → "Plate cleared?"', () => {
    expect(t("focus.timesUp", "playful")).toBe("Plate cleared?");
  });
  it('t("focus.yesDone", "plain") → "All done"', () => {
    expect(t("focus.yesDone", "plain")).toBe("All done");
  });
  it('t("focus.yesDone", "playful") → "Devoured it"', () => {
    expect(t("focus.yesDone", "playful")).toBe("Devoured it");
  });
  it('t("focus.keepGoingFor", "plain") → "Keep going for"', () => {
    expect(t("focus.keepGoingFor", "plain")).toBe("Keep going for");
  });
  it('t("focus.keepGoingFor", "playful") → "Back for seconds"', () => {
    expect(t("focus.keepGoingFor", "playful")).toBe("Back for seconds");
  });
  // Voice-neutral, but asserted in both voices anyway (Duo review): the
  // completeness test only rejects an empty string, so "min" drifting to
  // "minutes" — or the two voices quietly diverging — would pass unnoticed.
  it('t("focus.keepGoingUnit", "plain") → "min"', () => {
    expect(t("focus.keepGoingUnit", "plain")).toBe("min");
  });
  it('t("focus.keepGoingUnit", "playful") → "min"', () => {
    expect(t("focus.keepGoingUnit", "playful")).toBe("min");
  });
  // Re-estimate is reframed as "not sure", not as "no": once the keep-going row
  // exists, "no" is answered by picking 15/30/45/60. What re-estimation is FOR
  // is the case where the user cannot judge it themselves.
  it('t("focus.notYet", "plain") → "Not sure how much longer — ask Claude"', () => {
    expect(t("focus.notYet", "plain")).toBe(
      "Not sure how much longer — ask Claude",
    );
  });
  it('t("focus.notYet", "playful") → "No idea — ask Claude"', () => {
    expect(t("focus.notYet", "playful")).toBe("No idea — ask Claude");
  });
  it('t("focus.nextStep", "plain") → "Focus the next step"', () => {
    expect(t("focus.nextStep", "plain")).toBe("Focus the next step");
  });
  it('t("focus.nextStep", "playful") → "Focus the next bite"', () => {
    expect(t("focus.nextStep", "playful")).toBe("Focus the next bite");
  });

  // #66 setup screen ("one number, one action") — the ring's sub-label, the
  // duration chip row and the single quiet subordinate line. Numbers are
  // composed in JSX around these static units (t() has no interpolation).
  it('t("focus.setup.focusFor", "plain") → "Focus for"', () => {
    expect(t("focus.setup.focusFor", "plain")).toBe("Focus for");
  });
  it('t("focus.setup.ringFocusTime", "plain") → "focus time"', () => {
    expect(t("focus.setup.ringFocusTime", "plain")).toBe("focus time");
  });
  it('t("focus.setup.ringLeftOnStep", "plain") → "left on this step"', () => {
    expect(t("focus.setup.ringLeftOnStep", "plain")).toBe("left on this step");
  });
  it('t("focus.setup.ringLeftOnStep", "playful") → "left on this bite"', () => {
    expect(t("focus.setup.ringLeftOnStep", "playful")).toBe(
      "left on this bite",
    );
  });
  it('t("focus.setup.ringPickUp", "plain") → "left — pick up where you paused"', () => {
    expect(t("focus.setup.ringPickUp", "plain")).toBe(
      "left — pick up where you paused",
    );
  });
  it('t("focus.setup.onThisTask", "plain") → "on this task"', () => {
    expect(t("focus.setup.onThisTask", "plain")).toBe("on this task");
  });
  it('t("focus.setup.leftWholeTask", "plain") → "left on the whole task"', () => {
    expect(t("focus.setup.leftWholeTask", "plain")).toBe(
      "left on the whole task",
    );
  });
  it('t("focus.setup.stepsToGo", "plain") → "steps to go"', () => {
    expect(t("focus.setup.stepsToGo", "plain")).toBe("steps to go");
  });
  it('t("focus.setup.stepsToGo", "playful") → "bites to go"', () => {
    expect(t("focus.setup.stepsToGo", "playful")).toBe("bites to go");
  });
  it('t("focus.setup.stepToGo", "plain") → "step to go" (singular, so "1 steps to go" can\'t render)', () => {
    expect(t("focus.setup.stepToGo", "plain")).toBe("step to go");
    expect(t("focus.setup.stepToGo", "playful")).toBe("bite to go");
  });
  it('t("focus.setup.keepPaused", "plain") → "↻ Keep my paused session"', () => {
    expect(t("focus.setup.keepPaused", "plain")).toBe(
      "↻ Keep my paused session",
    );
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

// #136 — the lane-level cleared state. `focus.launcher.allClear` is the PAGE
// saying "there is nothing left anywhere"; this is one lane saying "you just
// emptied me", and the pair has to stay distinguishable from `bucket.empty`,
// which is what a lane that never held anything says.
describe("focus.lane.cleared (#136)", () => {
  it('t("focus.lane.cleared", "plain") is the plain celebration', () => {
    expect(t("focus.lane.cleared", "plain")).toBe(
      "Cleared — nothing left here right now. ✅",
    );
  });

  it('t("focus.lane.cleared", "playful") is the playful celebration', () => {
    expect(t("focus.lane.cleared", "playful")).toBe(
      "🎉 Plate cleared! Nothing left here right now.",
    );
  });

  // The distinction the issue is about, asserted rather than assumed: emptying a
  // lane must not render the same sentence as never having filled it.
  it("never reads as the neutral bucket.empty in either voice", () => {
    for (const voice of ["plain", "playful"] as const) {
      expect(t("focus.lane.cleared", voice)).not.toBe(t("bucket.empty", voice));
    }
  });

  // It reads as an ACKNOWLEDGEMENT, not as an absence — the /focus page already
  // draws this line with `clearedToday`, and "nothing here" is the wrong half of
  // it to show somebody who just finished the last thing in a lane.
  it("says 'cleared' in both voices", () => {
    for (const voice of ["plain", "playful"] as const) {
      expect(t("focus.lane.cleared", voice).toLowerCase()).toContain("cleared");
    }
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
    "action.breakNow",
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
    // #138 — the keep-going row's label and the reframed re-estimate answer.
    // Plain stays literal; the playful twins carry the food register instead.
    "focus.keepGoingFor",
    "focus.keepGoingUnit",
    "focus.notYet",
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
    "settings.integrationsSignedOut",
    // #118 — the Account section. Literal in plain; ✓/🔐/✅ are functional or
    // playful-only glyphs.
    "settings.accountHeading",
    "settings.accountKeyLabel",
    "settings.helpDocs",
    "guest.newHere",
    "guest.helpCta",
    // #66 — the focus setup screen's copy is literal in plain voice (↻ is a
    // functional glyph, allowed).
    "focus.setup.focusFor",
    "focus.setup.ringFocusTime",
    "focus.setup.ringLeftOnStep",
    "focus.setup.ringPickUp",
    "focus.setup.onThisTask",
    "focus.setup.leftWholeTask",
    "focus.setup.stepsToGo",
    "focus.setup.stepToGo",
    "focus.setup.keepPaused",
    // #111 — the brand-new-account empty inbox. Plain stays literal; the 🍳 is
    // playful-only flavour.
    "inbox.newAccount",
    // #136 — the emptied focus lane. Plain keeps only the functional ✅ (same
    // allowance `focus.launcher.allClear` uses); the 🎉 is playful-only.
    "focus.lane.cleared",
    // #186 — the inline-note button and its hint. The label is read out by voice
    // control and the hint is the field's DESCRIPTION, so plain stays literal;
    // the 🗒️ is playful-only flavour.
    "capture.addNote",
    "capture.noteHint",
  ];

  for (const key of plainOnlyKeys) {
    it(`t("${key}", "plain") contains no emoji`, () => {
      expect(hasEmoji(t(key, "plain"))).toBe(false);
    });
  }
});

/**
 * #253 F1 — the row's break-up labels must stay distinguishable from each other.
 *
 * Three keys name the same underlying act on three surfaces, and two of them sit on
 * the SAME ROW. `action.breakNow` was briefly "Break into steps", which is
 * character-identical to `action.breakdown`, the short inline CTA beside it — the
 * exact defect #253 removed when it took the full "Save for later" `aria-label` off
 * the inline `Save`: two controls in one row answering to one name, an ambiguous
 * voice-control target (WCAG 2.5.3's neighbourhood) and a row from which no query can
 * pick out either. It was caught by an unrelated spec's `/break into steps/i` matching
 * two elements, which is the same ambiguity a user's voice command would hit.
 *
 * A value assertion cannot see convergence — both would still "pass" while being
 * equal — so the relationship is asserted directly.
 */
describe("the break-up labels stay distinct (#253 F1)", () => {
  const keys = [
    "action.breakdown",
    "action.breakNow",
    "prompt.breakNow",
  ] as const;

  it.each(["plain", "playful"] as const)(
    "no two of the three collide in %s voice",
    (voice) => {
      const rendered = keys.map((k) => t(k, voice));
      expect(
        new Set(rendered).size,
        `two of ${JSON.stringify(rendered)} are identical`,
      ).toBe(keys.length);
    },
  );

  /**
   * Prefixes, but only for the pairs that can be on screen TOGETHER.
   *
   * ⚠️ A first version of this asserted it across all three and immediately caught a
   * real relation: `action.breakdown` ("Break into steps") is a prefix of
   * `prompt.breakNow` ("Break into steps now?"). That is NOT a defect, and the reason
   * is the whole shape of this test — those two are inline CTAs on different rows in
   * different buckets (Needs-review, and an awaiting Multi-step card), so no user and
   * no query ever sees both at once. Ambiguity is a property of a CONTEXT, not of a
   * string table.
   *
   * The two pairs that do co-occur, each on one row:
   *   • Needs-review row      — inline `action.breakdown` + ▾ `action.breakdownNow`
   *   • awaiting Multi-step   — inline `prompt.breakNow`  + ▾ `action.breakNow`
   */
  it.each([
    ["the Needs-review row", "action.breakdown"],
    ["an awaiting Multi-step card", "prompt.breakNow"],
  ] as const)(
    "on %s, the ▾ entry is neither equal to nor a prefix of the inline CTA",
    (_where, inlineKey) => {
      for (const voice of ["plain", "playful"] as const) {
        const inline = t(inlineKey, voice);
        const entry = t("action.breakNow", voice);
        expect(entry, `equal in ${voice}`).not.toBe(inline);
        expect(
          entry.startsWith(inline),
          `"${inline}" is a prefix of "${entry}" in ${voice} voice`,
        ).toBe(false);
        expect(
          inline.startsWith(entry),
          `"${entry}" is a prefix of "${inline}" in ${voice} voice`,
        ).toBe(false);
      }
    },
  );

  /**
   * ── The ▾'s own entries, which now share a construction on purpose ───────────
   *
   * The owner's rename made `action.breakdownFull` "Add as multi-step to-do" so it
   * parallels `action.addTodoFull` ("Add as single-task to-do") beneath it. That is
   * the right call for scannability AND it creates exactly the condition this file
   * guards: two labels sharing the prefix `Add as ` that **co-occur in one list**.
   *
   * Asserted rather than assumed to be fine. Sharing a leading substring is
   * harmless; what defeats a voice command or a `getByRole` name is one label being
   * EQUAL to, a PREFIX of, or CONTAINED IN another. These two diverge at "multi" vs
   * "single", so none of the three holds — and in playful they diverge at character 1
   * (🍿 against 🍽️), which is stronger still.
   *
   * `action.addToCalendar` is in the set because it also opens with "Add " and sits in
   * the same list, which the two-entry framing would have missed.
   */
  const sameList = [
    "action.breakNow",
    "action.breakdownFull",
    "action.addTodoFull",
    "action.saveForLater",
    "action.completeFull",
    "action.addToCalendar",
    "action.delete",
  ] as const;

  it.each(["plain", "playful"] as const)(
    "no ▾ entry is equal to, a prefix of, or contained in another (%s)",
    (voice) => {
      const rendered = sameList.map((k) => [k, t(k, voice)] as const);
      for (const [ka, a] of rendered) {
        for (const [kb, b] of rendered) {
          if (ka === kb) continue;
          expect(a, `${ka} equals ${kb}`).not.toBe(b);
          expect(
            b.startsWith(a),
            `${ka} ("${a}") is a prefix of ${kb} ("${b}")`,
          ).toBe(false);
          expect(
            b.includes(a),
            `${ka} ("${a}") is contained in ${kb} ("${b}")`,
          ).toBe(false);
        }
      }
    },
  );

  it("the menu entry is an imperative and the card's prompt is a question", () => {
    // The owner's split, pinned so a later pass cannot quietly re-merge the register.
    for (const voice of ["plain", "playful"] as const) {
      expect(t("prompt.breakNow", voice)).toMatch(/\?$/);
      expect(t("action.breakNow", voice)).not.toMatch(/\?$/);
    }
  });
});
