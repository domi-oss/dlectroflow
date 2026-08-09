/**
 * Voice string layer — pure module, safe to import from both server and client.
 *
 * Voice "plain"   — default; self-evident labels, no decorative emoji.
 *                   Functional glyphs only: status dots, ✅, ▶/⏸/➕/➖, 🗑️, 🔒, ⚠️
 * Voice "playful" — opt-in delight skin; same labels + flavour emoji + signature nouns.
 *
 * Vocabulary source: docs/wireframe/IMPLEMENTATION-HANDOFF.md (Plain ↔ Playful table).
 */

export type Voice = "plain" | "playful";

export const STRINGS = {
  // ── Actions ────────────────────────────────────────────────────────────────
  "action.breakdown": {
    plain: "Break into steps",
    playful: "🍿 Snack-size it",
  },
  "action.addTodo": { plain: "Add to-do", playful: "🍽️ Add to-do" },
  "action.saveForLater": {
    plain: "Save for later",
    playful: "🥫 Save for later",
  },
  "action.confirmSteps": {
    plain: "Confirm steps",
    playful: "✅ Confirm steps",
  },
  "action.startFocus": {
    plain: "Start focusing",
    playful: "🍽️ Start focusing",
  },
  "action.moreSteps": { plain: "More steps", playful: "🍞 More steps" },
  "action.fewerSteps": { plain: "Fewer steps", playful: "🥖 Fewer steps" },
  "action.backToInbox": { plain: "Back to inbox", playful: "🍳 Back to inbox" },
  "action.addStep": { plain: "Add a step", playful: "🍞 Add a step" },
  "action.removeStep": { plain: "Remove step", playful: "🥖 Remove step" },
  "action.dismiss": { plain: "Dismiss", playful: "Not now" },
  "action.stillNeeded": { plain: "Still need it", playful: "Still want it" },
  "action.delete": { plain: "Delete", playful: "Delete" },
  "action.cancel": { plain: "Cancel", playful: "Cancel" },
  // Single canonical "✓ complete" label — deliberately IDENTICAL across voices
  // (like "focus.timer.completeStep" below) so the inbox row, task-step, and
  // focus-lane Complete affordances render as the exact same button everywhere
  // instead of drifting between a bare word and a bare glyph (owner report).
  "action.complete": { plain: "✓ Complete", playful: "✓ Complete" },
  "action.reopen": { plain: "Reopen", playful: "Reopen" },
  "action.reopenSelected": {
    plain: "Reopen selected",
    playful: "Reopen selected",
  },
  "action.reopenAll": { plain: "Reopen all", playful: "Reopen all" },
  "action.moveTo": { plain: "Move to…", playful: "Move to…" },

  // v6 row redesign — short CTA on the visible buttons, full descriptive wording
  // in the ▾ dropdown. The button variants above stay short; these are the
  // dropdown's full-length mirrors (+ a short "Save" for the button).
  "action.breakdownFull": {
    plain: "Break into smaller steps",
    playful: "🍿 Snack-size into smaller steps",
  },
  "action.addTodoFull": {
    plain: "Add as single task to do",
    playful: "🍽️ Add as single task to do",
  },
  "action.saveShort": { plain: "Save", playful: "🥫 Save" },
  "action.completeFull": {
    plain: "Mark as completed",
    playful: "✅ Mark as completed",
  },
  "action.editTitle": { plain: "Edit task title", playful: "Edit task title" },
  "action.schedule": { plain: "Schedule", playful: "🗓️ Schedule" },
  "action.addToCalendar": {
    plain: "Add to calendar (.ics)",
    playful: "📅 Add to calendar (.ics)",
  },

  // ── Step rows (TaskSteps working view, #25) ────────────────────────────────
  // Voice-aware labels for the redesigned step rows. Plain = literal; playful =
  // food-themed to match the rest of the row (🍽️/🍴 = at the table, focusing).
  "step.startFocus": { plain: "▶ Start Focus", playful: "▶ Start Focus" },
  "step.resumeFocus": { plain: "▶ Resume Focus", playful: "▶ Resume Focus" },
  "step.startFocusTimer": {
    plain: "Start focus timer",
    playful: "🍽️ Start focus timer",
  },
  "step.resumeFocusTimer": {
    plain: "Resume focus timer",
    playful: "🍴 Resume focus timer",
  },
  "step.complete": { plain: "Complete step", playful: "✅ Complete step" },
  // #198 — the inverse of step.complete, on a done row. Same wording in both
  // voices: the playful register belongs on an achievement, not on correcting
  // one. Phrased as the state being restored ("not done") rather than as the
  // operation ("un-complete"), which is jargon for a database write the user
  // never thinks about.
  "step.uncomplete": {
    plain: "Mark not done",
    playful: "Mark not done",
  },
  "step.editEstimate": {
    plain: "Edit time estimate",
    playful: "⏱️ Edit time estimate",
  },
  "step.editTitle": { plain: "Edit step title", playful: "✏️ Edit step title" },
  "step.sendToReview": {
    plain: "Send back to review",
    playful: "🥫 Send back to review",
  },

  // ── Inbox section headers ──────────────────────────────────────────────────
  "section.needsReview": { plain: "Needs review", playful: "Needs review" },
  "section.toDo": { plain: "To do", playful: "To do" },
  "section.singleTask": {
    plain: "Single-task to-dos",
    playful: "😋 Quick bites",
  },
  "section.multiStep": { plain: "Multi-step to-dos", playful: "✅ Sorted" },
  "section.savedLater": { plain: "Saved for later", playful: "🥫 Pantry" },
  "section.completed": { plain: "Completed", playful: "🍽️ Cleared plate" },
  "section.completedToday": {
    plain: "Completed today",
    playful: "Cleared today",
  },

  // ── Bucket board (Phase B) ─────────────────────────────────────────────────
  "bucket.empty": { plain: "Nothing here yet", playful: "Nothing here yet" },

  // ── Nav / hub labels ───────────────────────────────────────────────────────
  "nav.inbox": { plain: "Inbox", playful: "🧠 Inbox" },
  "nav.dashboard": { plain: "Activity", playful: "🎉 Activity" },
  "nav.everything": { plain: "Library", playful: "🍱 Larder" },
  "nav.done": { plain: "Done", playful: "🍽️ Devoured" },
  "nav.focusTimer": { plain: "Focus Timer", playful: "⏱️ Focus Timer" },
  "nav.settings": { plain: "Settings", playful: "⚙️ Settings" },
  "nav.help": { plain: "Help", playful: "🆘 Help" },
  // #199 — a menu entry rather than a Library tab, because every Library tab is
  // a bucket of BrainDumpItems (inbox/bucket.ts) and a tab there would say "this is
  // a kind of task". Only rendered when Settings.shoppingList is on.
  "nav.shopping": { plain: "Shopping list", playful: "🛒 Shopping list" },

  // ── Freshness tiers ────────────────────────────────────────────────────────
  "freshness.recent": { plain: "Recent", playful: "Fresh" },
  "freshness.aging": { plain: "Aging", playful: "Softening" },
  "freshness.overdue": { plain: "Overdue", playful: "Soggy" },
  "freshness.wayOverdue": { plain: "Way overdue", playful: "Stale" },

  // ── Dashboard stats ────────────────────────────────────────────────────────
  "stat.pointsToday": { plain: "Points today", playful: "Crumbs today" },
  "stat.currentStreak": { plain: "Current streak", playful: "On a roll" },
  "stat.focusMinsToday": {
    plain: "Focus mins today",
    playful: "Time at the table",
  },
  "stat.stepsToday": { plain: "Steps today", playful: "Bites today" },
  "stat.totalPoints": {
    plain: "Total points earned",
    playful: "Total crumbs earned",
  },

  // ── Dashboard section headings ─────────────────────────────────────────────
  "heading.bestStreaks": { plain: "Best streaks", playful: "🏆 Best streaks" },

  // ── Badge labels ───────────────────────────────────────────────────────────
  "badge.first_breakdown": {
    plain: "First breakdown",
    playful: "🍰 First Slice",
  },
  "badge.first_schedule": {
    plain: "First scheduled",
    playful: "🍽️ First Plate-up",
  },
  "badge.first_focus": { plain: "First focus", playful: "😋 First Bite" },
  "badge.task_complete": { plain: "Task complete", playful: "🧽 Clean Plate" },
  "badge.streak_5": { plain: "Full work week", playful: "🔥 Full Week" },
  "badge.inbox_zero": { plain: "Inbox zero", playful: "🧺 Empty Tray" },
  "badge.comeback": { plain: "Comeback", playful: "📦 Back for Seconds" },
  "badge.ten_steps_day": {
    plain: "10 steps in a day",
    playful: "🔟 Ten-Bite Day",
  },
  "badge.beat_best_streak": {
    plain: "Beat your best streak",
    playful: "🏆 New Record",
  },
  "badge.sectionTitle": { plain: "Badges", playful: "Badges" },
  "badge.legend": {
    plain: "· faded = not earned yet",
    playful: "· faded = not earned yet",
  },
  "badge.earned": { plain: "Earned", playful: "Earned" },
  "badge.notEarned": { plain: "Not earned yet", playful: "Not earned yet" },

  // ── Focus timer labels ─────────────────────────────────────────────────────
  "focus.startTimer": {
    plain: "▶ Start focusing",
    playful: "▶ Start focusing",
  },
  "focus.complete": { plain: "✅ Complete", playful: "✅ Complete" },
  "focus.pause": { plain: "⏸️ Pause", playful: "⏸️ Pause" },
  "focus.resume": { plain: "▶ Resume", playful: "▶ Resume" },
  // ── #138 — the time-up screen's three answers ──────────────────────────────
  // Decided with the owner on 2026-07-31. The heading asks a question and each
  // option COMPLETES it, so the three read as parallel answers rather than a
  // verdict plus a menu. The old set ("Time's up — did you finish?" / "Yes,
  // done!" / "Not yet") named the mechanism instead of the choice.
  //
  // Two decisions here are easy to undo by accident, so they are written down:
  //
  // 1. Re-estimation is reframed as "not sure", NOT as "no". Once the keep-going
  //    row exists, plain "no" is answered by tapping 15/30/45/60. What
  //    re-estimation is actually FOR is the case where the user cannot judge it
  //    themselves — so the label describes that state, not the mechanism.
  // 2. It names Claude, not "AI". The very next screen already says "Claude is
  //    re-estimating…", so "ask Claude" is consistent and concrete, and tells
  //    the user what will happen. "with AI" describes the implementation and
  //    ages badly.
  //
  // The playful twins stay inside the food register already shipped (🍱 Larder,
  // 🍽️ Devoured, Cleared plate) rather than inventing a new metaphor — that is
  // what lets them survive being seen several times a day.
  "focus.timesUp": {
    plain: "How did that go?",
    playful: "Plate cleared?",
  },
  "focus.yesDone": { plain: "All done", playful: "Devoured it" },
  // The label opening the 15/30/45/60 row, mirroring focus.setup.focusFor's
  // "Focus for [chips]" shape. The row reads as one sentence — "Keep going for
  // 15 / 30 / 45 / 60 min" — so the buttons hold bare numbers and the unit is
  // said once, by focus.keepGoingUnit below.
  "focus.keepGoingFor": {
    plain: "Keep going for",
    playful: "Back for seconds",
  },
  // Voice-neutral UI furniture, like focus.timer.of and focus.timer.steps: an
  // abbreviated unit has no plain/playful register to differ in. `aria-hidden`
  // at the call site, because each button already says "Add N minutes" in full —
  // without that a screen reader would read the row as "…60, min".
  "focus.keepGoingUnit": { plain: "min", playful: "min" },
  "focus.notYet": {
    plain: "Not sure how much longer — ask Claude",
    playful: "No idea — ask Claude",
  },
  "focus.nextStep": {
    plain: "Focus the next step",
    playful: "Focus the next bite",
  },
  "focus.pauseForNow": {
    plain: "⏸️ Pause for now",
    playful: "⏸️ Pause for now",
  },
  // #27 — setup screen for a step with a truly-paused session: offered
  // alongside the normal Start button (owner decision: ask, don't silently
  // resume). "focus.resume"'s "▶ Resume" pairs with the composed "~Xm left"
  // (mirrors focus.hero.left's "~Xm left" pattern on the launcher hero).
  "focus.startFresh": { plain: "↻ Start fresh", playful: "↻ Start fresh" },

  // ── #142 — the auto-advance countdown after a step is completed ────────────
  //
  // Deliberately IDENTICAL across voices, for the same reason as the #137 error
  // strings above but the opposite emotion: this copy is a *timed navigation*
  // notice, and it is the only thing standing between the user and a screen
  // change they did not ask for. A playful synonym for "Stay here" would make
  // the escape harder to find at exactly the wrong moment, and the announcement
  // names the button by its literal label — if the two ever drift, the spoken
  // instruction points at a control that isn't there.
  "focus.advance.in": { plain: "in", playful: "in" },
  "focus.advance.seconds": { plain: "seconds", playful: "seconds" },
  "focus.advance.goNow": { plain: "Go now", playful: "Go now" },
  "focus.advance.stayHere": { plain: "Stay here", playful: "Stay here" },
  // WCAG 2.2.1 — the non-visual half of "turn the time limit off". Spoken
  // before the countdown can run out, and Escape needs no tabbing to reach, so
  // a screen-reader user is not racing the clock to find a button.
  "focus.advance.escapeHint": {
    plain: 'Press Escape, or choose "Stay here", to stay on this screen.',
    playful: 'Press Escape, or choose "Stay here", to stay on this screen.',
  },
  "focus.advance.cancelled": {
    plain: "Staying here. Move on whenever you're ready.",
    playful: "Staying here. Move on whenever you're ready.",
  },
  "focus.advance.nextStep": { plain: "Next step", playful: "Next step" },
  "focus.advance.nextTodo": { plain: "Next to-do", playful: "Next to-do" },

  // #142 — "hyper focus mode": chain single-task to-dos after one completes.
  // The NAME is fixed copy in both voices because the issue names it, the
  // completion screen offers it by that name, and the launcher toggle turns it
  // off by that name — three surfaces that must say the same words. The
  // supporting line is where the voice lives.
  "focus.hyper.name": {
    plain: "Hyper focus mode",
    playful: "Hyper focus mode",
  },
  "focus.hyper.on": { plain: "on", playful: "on" },
  "focus.hyper.off": { plain: "off", playful: "off" },
  "focus.hyper.help": {
    plain:
      "When a single-task to-do is done, roll straight into the next one instead of coming back here.",
    playful:
      "Clear a snack and the next one lands in front of you, instead of coming back here.",
  },
  "focus.hyper.turnOn": {
    plain: "Turn on hyper focus mode",
    playful: "Turn on hyper focus mode",
  },
  "focus.hyper.turnOff": {
    plain: "Turn off hyper focus mode",
    playful: "Turn off hyper focus mode",
  },

  // #142 — the end of a whole task, and the end of everything.
  "focus.done.taskComplete": {
    plain: "Task complete. 🏁",
    playful: "Whole plate cleared. 🏁",
  },
  "focus.done.singleComplete": {
    plain: "That one's done. 🏁",
    playful: "Devoured. 🏁",
  },
  // The finish deserves a real pause, so stopping is a first-class answer here
  // rather than a link hiding under the next thing.
  "focus.done.doneForNow": {
    plain: "Done for now",
    playful: "Done for now",
  },
  "focus.done.backToFocus": {
    plain: "Back to focus",
    playful: "Back to focus",
  },
  // #198 — the undo, offered on the done screen because that is where the
  // accidental completion #197 produced actually happens. Worded as what the
  // user knows ("I hadn't finished") rather than as the mechanism
  // ("un-complete"): they are not undoing a database write, they are correcting
  // a claim the app made about their work. No exclamation in either voice — this
  // is a mistake being fixed, and the playful register would be badly timed.
  "focus.done.undo": {
    plain: "Actually, I hadn't finished",
    playful: "Actually, I hadn't finished",
  },
  "focus.done.undone": {
    plain: "Put back. The step is open again.",
    playful: "Put back. The step is open again.",
  },
  "focus.done.queueEmpty": {
    plain: "No multi-step tasks left. Work through the single-task to-dos?",
    playful: "No big plates left. Work through the snacks?",
  },
  "focus.done.allClear": {
    plain: "That's everything. Nothing left in the queue.",
    playful: "Kitchen's clear. Nothing left on the pass.",
  },
  // #142 — the dashboard's way onward, so the empty-queue destination is not a
  // cul-de-sac. The Library rather than the Inbox: the Inbox is the fullest
  // screen in the app and lands a demand where a reward just was.
  "focus.done.findSomethingElse": {
    plain: "Find something else →",
    playful: "Find something else →",
  },
  "focus.done.seeYourDay": {
    plain: "See how today went →",
    playful: "See how today went →",
  },

  // ── #137 — what the timer says when a server action fails ──────────────────
  // It used to say nothing: a rejected action left the screen on "Claude is
  // re-estimating…" indefinitely. These are the words that replace the spinner.
  //
  // Deliberately IDENTICAL across voices, like "settings.saveError" above: the
  // playful skin is a delight layer, and a session that has just gone wrong —
  // alarm ringing, decision half-made — is not where delight belongs. Each
  // message says what did not happen AND what is still true, because the
  // unanswerable question at that moment is "did I just lose my work?".
  "focus.error.stale": {
    plain:
      "The app updated while this was open, so that didn't go through. Reload to carry on — nothing is lost.",
    playful:
      "The app updated while this was open, so that didn't go through. Reload to carry on — nothing is lost.",
  },
  "focus.error.reestimate": {
    plain: "Couldn't get a new estimate just now.",
    playful: "Couldn't get a new estimate just now.",
  },
  "focus.error.requeue": {
    plain: "Couldn't save that — your step hasn't changed.",
    playful: "Couldn't save that — your step hasn't changed.",
  },
  // #142 — opening the next single-task to-do failed. Names the thing that
  // did not happen rather than the function that failed, and pressing again is
  // the whole remedy, so the shared Retry button is enough.
  "focus.error.chain": {
    plain: "Couldn't open the next to-do.",
    playful: "Couldn't open the next to-do.",
  },
  "focus.error.complete": {
    plain: "Couldn't finish the step just now — nothing is lost.",
    playful: "Couldn't finish the step just now — nothing is lost.",
  },
  // #198 — a failed UNDO needs its own line, because the reassurance that fits
  // every other failure here ("nothing is lost") is the one thing that is not
  // true: the step really is still marked done, and saying otherwise would leave
  // someone believing they had recovered work they had not.
  "focus.error.undo": {
    plain: "Couldn't put the step back just now — it is still marked done.",
    playful: "Couldn't put the step back just now — it is still marked done.",
  },
  "focus.error.session": {
    plain: "Couldn't reach the server just now.",
    playful: "Couldn't reach the server just now.",
  },
  "focus.error.retry": { plain: "Try again", playful: "Try again" },
  // Announced from inside the notice while a retry is in flight, so the wait is
  // not silent and the Retry button can keep focus instead of being `disabled`.
  "focus.error.retrying": { plain: "Trying again…", playful: "Trying again…" },
  "focus.error.reload": {
    plain: "Reload the page",
    playful: "Reload the page",
  },
  // The escape hatch from a failed re-estimate: the session ends in a requeue
  // either way, just with a number the user chose instead of one Claude did.
  "focus.error.pickTime": {
    plain: "Skip — pick a time myself",
    playful: "Skip — pick a time myself",
  },

  // ── #66 setup screen: "one number, one action" ─────────────────────────────
  // The setup phase used to stack four figures (ring countdown, the step-context
  // minutes line, the Resume button's own "~Xm left", and a Duration number
  // input). These are the units of the replacement hierarchy: ONE ring sub-label
  // naming what the single big number means, a chip row instead of the number
  // field, and ONE quiet subordinate line for the task total. Numbers are
  // composed in JSX around them (t() has no interpolation). ↻ is a functional
  // glyph (allowed in plain); on the timer it's rendered as a lucide icon and
  // stripped from the label (stripLeadingGlyph).
  "focus.setup.focusFor": { plain: "Focus for", playful: "Focus for" },
  "focus.setup.ringFocusTime": { plain: "focus time", playful: "focus time" },
  "focus.setup.ringLeftOnStep": {
    plain: "left on this step",
    playful: "left on this bite",
  },
  "focus.setup.ringPickUp": {
    plain: "left — pick up where you paused",
    playful: "left — pick up where you paused",
  },
  "focus.setup.onThisTask": {
    plain: "on this task",
    playful: "on this task",
  },
  "focus.setup.leftWholeTask": {
    plain: "left on the whole task",
    playful: "left on the whole task",
  },
  "focus.setup.stepsToGo": { plain: "steps to go", playful: "bites to go" },
  "focus.setup.stepToGo": { plain: "step to go", playful: "bite to go" },
  "focus.setup.keepPaused": {
    plain: "↻ Keep my paused session",
    playful: "↻ Keep my paused session",
  },

  // ── Resume banner (Phase 5, #8) — surfaces the most-recent paused/open focus
  // step on the Inbox so a user can jump straight back in. ⏸/→ are functional
  // status glyphs, allowed in Plain voice.
  "focus.pausedBanner": {
    plain: "⏸ Paused focus step —",
    playful: "⏸ Paused focus step —",
  },
  "focus.resumeArrow": { plain: "resume →", playful: "resume →" },

  // ── Focus launcher (/focus step-picker) ────────────────────────────────────
  // ⏸ is an allowed functional glyph (see the plain-voice glyph note above).
  "focus.launcher.intro": {
    plain: "Pick a step to focus on.",
    playful: "Pick a bite to focus on.",
  },
  "focus.launcher.empty": {
    plain:
      "Nothing to focus yet. Capture something in your Inbox and break it into steps, then come back to focus.",
    playful:
      "Nothing on the menu yet. Capture something in your Inbox and snack-size it into steps, then come back to focus.",
  },
  "focus.paused": { plain: "⏸ paused", playful: "⏸ paused" },

  // ── Focus launcher redesign (MR ①) — meta line, resume hero, lanes ──────────
  // 🔥 / ▶ / ✓ / ⏸ are functional glyphs (allowed in plain). Numbers are
  // composed in JSX around these static units (t() has no interpolation).
  "focus.meta.focusedToday": {
    plain: "focused today",
    playful: "focused today",
  },
  "focus.meta.dayStreak": { plain: "-day streak", playful: "-day streak" },
  "focus.meta.toClear": { plain: "to clear", playful: "to clear" },
  "focus.hero.left": { plain: "left", playful: "left" },
  "focus.hero.next": { plain: "next →", playful: "next →" },
  "focus.hero.resume": {
    plain: "▶ Resume focus",
    playful: "▶ Resume focusing",
  },
  "focus.lane.start": { plain: "▶ Start", playful: "▶ Start" },
  "focus.lane.open": { plain: "▶ Open", playful: "▶ Open" },
  "focus.launcher.allClear": {
    plain: "All caught up — nothing left to focus right now. ✅",
    playful: "🎉 Plates cleared! Nothing left to focus right now.",
  },
  // #136 — ONE lane emptied, as opposed to the whole page (allClear above) and
  // as opposed to a lane that never held anything (`bucket.empty`, which stays
  // exactly as it is). Completing the last row in a lane used to leave a blank
  // box; the copy it now gets has to read as an ACKNOWLEDGEMENT, because the
  // /focus page already draws that line with `clearedToday` and "nothing here"
  // is the wrong half of it to show somebody who just finished something.
  //
  // Deliberately "right now", echoing allClear: a multi-step row is replaced by
  // its task's next step once `router.refresh()` lands, so this must not claim
  // more than "there is nothing in this lane at this moment". ✅ is a functional
  // glyph (allowed in plain, same as allClear); the 🎉 is playful-only, and
  // "plate" is the playful vocabulary's word for a cleared lane (section.completed).
  "focus.lane.cleared": {
    plain: "Cleared — nothing left here right now. ✅",
    playful: "🎉 Plate cleared! Nothing left here right now.",
  },

  // ── Focus timer redesign (MR ②) — timer page, hint, settings group ──────────
  // ✓ / ⏰ / 🎧 / ⏱️ are functional or playful-only glyphs (see the voice note
  // at the top). Numbers are composed in JSX around these static units.
  "focus.timer.completeStep": {
    plain: "✓ Complete step",
    playful: "✓ Complete step",
  },
  "focus.timer.of": { plain: "of", playful: "of" },
  "focus.timer.steps": { plain: "steps", playful: "steps" },
  "focus.tip.body": {
    plain: "Make this timer yours — style, sounds, alarm & more.",
    playful: "✨ Make this timer yours — style, sounds, alarm & more.",
  },
  "focus.tip.cta": { plain: "Open settings →", playful: "Open settings →" },
  "focusSettings.heading": { plain: "Focus timer", playful: "⏱️ Focus timer" },
  "focusSettings.intro": {
    plain: "How the focus timer looks and behaves.",
    playful: "How your focus timer looks and behaves.",
  },
  "focusSettings.style": { plain: "Timer style", playful: "Timer style" },
  "focusSettings.styleRing": { plain: "Ring", playful: "Ring" },
  "focusSettings.styleDigits": { plain: "Digits", playful: "Digits" },
  "focusSettings.styleBar": { plain: "Bar", playful: "Bar" },
  "focusSettings.styleMug": { plain: "Mug", playful: "🍵 Mug" },
  "focusSettings.minimal": {
    plain: "Minimal / distraction-free",
    playful: "Minimal / distraction-free",
  },
  "focusSettings.minimalHint": {
    plain:
      "Hide the streak, task context and step tracker while the timer runs.",
    playful:
      "Hide the streak, task context and step tracker while the timer runs.",
  },
  "focusSettings.keepAwake": {
    plain: "Keep screen awake",
    playful: "Keep screen awake",
  },
  "focusSettings.keepAwakeHint": {
    plain:
      "Stop the screen dimming while a timer is running (where your device supports it).",
    playful:
      "Stop the screen dimming while a timer is running (where your device supports it).",
  },
  "focusSettings.alarm": {
    plain: "Alarm at time's-up",
    playful: "⏰ Alarm at time's-up",
  },
  "focusSettings.alarmHint": {
    plain:
      "Play a short chime (and vibrate on mobile) when the timer reaches zero.",
    playful:
      "Play a short chime (and vibrate on mobile) when the timer reaches zero.",
  },
  // #180 — the label of the one music control left on this page. It is a switch
  // now, so the label has to name the THING rather than an option within it.
  "focusSettings.sound": { plain: "Focus sounds", playful: "🎧 Focus sounds" },
  // #68 — the timer plays a real playlist now (it advances itself and only
  // wraps once every track has played), so this copy must not promise a loop.
  "focusSettings.soundHint": {
    plain: "Play a calm lo-fi playlist while you focus.",
    playful: "Play a calm lo-fi playlist while you focus.",
  },
  // #180 — where the ten tracks, their previews and the category playlists went.
  // This line is the whole mitigation for the removal reading as a lost feature,
  // so it names both of the things that moved and where they moved TO; "in the
  // player" alone would leave someone hunting on this page.
  "focusSettings.soundPlayerHint": {
    plain:
      "Choose which playlists and which track from the player, while a session is running.",
    playful:
      "Choose which playlists and which track from the player, while a session is running. 🎧",
  },
  // #65 — the opt-in music↔timer pause coupling. The label gets a playful glyph
  // anchor (same convention as the alarm toggle) and the hint spells out the
  // CONSEQUENCE in both directions, including what off means: someone reaching
  // for the player's pause button normally just wants quiet, so "this also
  // stops your session" has to be on screen before they turn it on.
  "focusSettings.pauseTogether": {
    plain: "Pause music and timer together",
    playful: "⏸️ Pause music and timer together",
  },
  "focusSettings.pauseTogetherHint": {
    plain:
      "Pausing the music in the player also pauses the timer, and playing it again resumes both. Off, the music pauses on its own and the timer keeps running.",
    playful:
      "Pausing the music in the player also pauses the timer, and playing it again resumes both. Off, the music pauses on its own and the timer keeps running.",
  },
  // #43 — in-timer mini-player controls (aria labels + visible now-playing text).
  "focus.sound.region": { plain: "Focus sound", playful: "🎧 Focus sound" },
  "focus.sound.nowPlaying": { plain: "Now playing", playful: "Now playing" },
  "focus.sound.play": {
    plain: "Play focus sound",
    playful: "Play focus sound",
  },
  "focus.sound.pause": {
    plain: "Pause focus sound",
    playful: "Pause focus sound",
  },
  "focus.sound.next": { plain: "Next track", playful: "Next track" },
  "focus.sound.prev": { plain: "Previous track", playful: "Previous track" },
  "focus.sound.volume": { plain: "Volume", playful: "Volume" },
  "focus.sound.volumeLevel": { plain: "Volume level", playful: "Volume level" },
  "focus.sound.progress": {
    plain: "Playback progress",
    playful: "Playback progress",
  },
  // #68 — playlist shuffle. A functional toggle, so the label is identical in
  // both voices and stays constant in both states (aria-pressed carries the
  // state); "Shuffled" repeats that state as text in the now-playing line so it
  // is never conveyed by colour alone.
  "focus.sound.shuffle": { plain: "Shuffle tracks", playful: "Shuffle tracks" },
  "focus.sound.shuffled": { plain: "Shuffled", playful: "Shuffled" },
  // #65 — the mini-player's transport labels WHEN the pause coupling is on. The
  // button then stops the session as well as the audio, so the accessible name
  // has to say both; "Pause focus sound" would under-promise what pressing it
  // costs. Functional control ⇒ identical in both voices, and the state itself
  // is still carried by aria-pressed.
  "focus.sound.pauseTogether": {
    plain: "Pause music and timer",
    playful: "Pause music and timer",
  },
  "focus.sound.resumeTogether": {
    plain: "Resume music and timer",
    playful: "Resume music and timer",
  },
  // #181 — the in-player playlist + jump panel. Every one of these is a
  // functional control on a screen someone is using to concentrate, so they read
  // identically in both voices: a playful flourish here would be the panel
  // drawing attention to itself, which is the one thing it must not do.
  //
  // The disclosure keeps ONE label in both states, like the shuffle toggle above:
  // aria-expanded carries open/closed, and a label that changed under the user
  // would be a second thing to re-read on every press.
  "focus.sound.panel": {
    plain: "Playlists and tracks",
    playful: "Playlists and tracks",
  },
  "focus.sound.playlists": { plain: "Playlists", playful: "Playlists" },
  // Says how to leave the all-tracks state, because "All tracks" is the only row
  // that cannot be unticked directly — you leave it by ticking a playlist. A
  // control whose off-switch is elsewhere has to say where.
  "focus.sound.playlistsHint": {
    plain: "Tick a playlist to narrow what plays.",
    playful: "Tick a playlist to narrow what plays.",
  },
  "focus.sound.allTracks": { plain: "All tracks", playful: "All tracks" },
  "focus.sound.tracks": { plain: "Tracks", playful: "Tracks" },
  // The playing track's mark, in text. aria-current announces it to a screen
  // reader; this is the half that keeps it off colour alone (WCAG 1.4.1).
  "focus.sound.playing": { plain: "Playing", playful: "Playing" },
  // Counts belong INSIDE each checkbox's accessible name — a bare "(21)" beside
  // a label is invisible to a screen reader reading the label alone — so the
  // visible parenthesised figure is aria-hidden and these spell it out instead.
  "focus.sound.trackOne": { plain: "track", playful: "track" },
  "focus.sound.trackMany": { plain: "tracks", playful: "tracks" },

  // ── Breakdown confirm ──────────────────────────────────────────────────────
  "breakdown.looksRight": { plain: "Looks right", playful: "👍 Looks right" },

  // ── Schedule status banner (ground truth, Phase 4) ─────────────────────────
  // Reflects the PERSISTED task.scheduledAt marker — never optimistic UI. ⚠️/✅
  // are functional glyphs (allowed in plain); 🔌 is playful-only flavour.
  "banner.scheduled": {
    plain: "✅ Scheduled — these steps are on your calendar.",
    playful: "✅ Scheduled — these steps are on your calendar.",
  },
  "banner.notScheduled": {
    plain:
      "⚠️ Not scheduled yet — connect a calendar to send these steps automatically.",
    playful:
      "🔌 Not scheduled yet — connect a calendar to send these steps automatically.",
  },

  // ── Breakdown step counter ─────────────────────────────────────────────────
  "step.counter": { plain: "Step", playful: "bite" },

  // ── Capture confirm ────────────────────────────────────────────────────────
  "capture.confirm": { plain: "captured ✓", playful: "captured ✓" },

  // ── The inline note affordance on a brain-dump field (#186) ────────────────
  //
  // `capture.*` rather than `note.*` on purpose: `note.trigger` below is #44's
  // task/step note disclosure, which is a different control on a different
  // column. These two belong to the brain-dump text field — the capture bar and
  // the ✎ row editor, which are the same field at two moments.
  //
  // ONE fixed word, never "Add" swapped for "Edit". Same argument
  // `note.trigger` makes: the label must not change width (and shift the row)
  // the instant a note exists, and "add" is what the person is doing either way
  // — the button's job is to open a place to write, whether or not braces are
  // already there. 🗒️ is flavour, so playful only.
  "capture.addNote": { plain: "Add note", playful: "🗒️ Add note" },
  // The only thing on screen that says the syntax exists (#179 shipped the
  // parser with nothing announcing it). It states the POSITION as well as the
  // punctuation, because "at the end" is the entire rule — a group anywhere else
  // stays literal, and someone who learns only the braces will meet that
  // refusal as a bug.
  //
  // Safe to write braces here and NOT in JSX text, where `{` opens an
  // expression: this is a plain string the renderer interpolates.
  "capture.noteHint": {
    plain: "Put a note in {curly braces} at the end.",
    playful: "Tuck a note in {curly braces} at the end.",
  },
  // ── #210: a capture that did not land ──────────────────────────────────────
  // Identical across voices, for the same reason the focus.error.* family is:
  // the playful skin is a delight layer, and "did I just lose that thought?" is
  // not where delight belongs. Each message says what did not happen AND what is
  // still true, because that question is the only one the user has.
  //
  // Named under `capture.` rather than reusing focus.error.retry / .reload,
  // whose values are identical today: the `focus.` prefix is a lie in the inbox,
  // and re-tuning the focus timer's copy must not silently re-word the capture
  // bar. The duplication is two short button labels; the coupling would be
  // permanent.
  //
  // Both messages END on a colon — the words the write could not save are
  // rendered, quoted, immediately after, so the notice itself is a copy of them
  // and they survive even when the input has moved on.
  "capture.error.failed": {
    plain: "Couldn't save that just now — your words are still here:",
    playful: "Couldn't save that just now — your words are still here:",
  },
  "capture.error.stale": {
    plain:
      "The app updated while this was open, so that didn't save. Reload to carry on — your words are still here:",
    playful:
      "The app updated while this was open, so that didn't save. Reload to carry on — your words are still here:",
  },
  // Duo review round 2 — the one failure whose verdict is genuinely unknown. A
  // server action cannot be aborted from the client, so a timeout bounds how
  // long the UI waits, not the write: the insert may still land, and a retry
  // after it does leaves two identical items. Saying "couldn't save that" here
  // would be a claim the client cannot support — the same unverifiable
  // confirmation as the `captured ✓` this issue is about, pointing the other
  // way. So it says what it knows, names the one thing that resolves the
  // ambiguity, and lets the user choose: a duplicate is one tap to delete, an
  // unwritten thought is not recoverable at all.
  "capture.error.timeout": {
    plain:
      "No answer from the server, so this may already have saved. Check your inbox before trying again — your words are still here:",
    playful:
      "No answer from the server, so this may already have saved. Check your inbox before trying again — your words are still here:",
  },
  "capture.error.retry": { plain: "Try again", playful: "Try again" },
  "capture.error.reload": {
    plain: "Reload the page",
    playful: "Reload the page",
  },
  // Announced from inside the notice while a write is in flight, so the wait is
  // not silent and Retry can keep focus instead of being `disabled`. "Saving…"
  // rather than "Trying again…" because the same flag is raised by a FRESH
  // capture typed while an older failure's notice is still on screen.
  "capture.error.saving": { plain: "Saving…", playful: "Saving…" },

  // ── Prompts ────────────────────────────────────────────────────────────────
  "prompt.stillNeeded": {
    plain: "This has been sitting a while — still needed?",
    playful: "🕐 This snack's been sitting a while — still want it?",
  },
  "prompt.breakNow": {
    plain: "Break into steps now?",
    playful: "🍿 Snack-size it now?",
  },
  "prompt.reopenWhich": {
    plain: "Which steps still need doing?",
    playful: "Which steps go back on the plate?",
  },

  // ── Inbox empty state ──────────────────────────────────────────────────────
  // Two empty inboxes, not one. This pair is the whole of #111: "Inbox zero"
  // congratulates you for CLEARING a queue, which is the wrong sentence — and in
  // playful voice a celebratory one — to greet an account that never had a queue
  // with. It stays, unchanged, for the account that really did clear one.
  "inbox.zero": {
    plain: "Inbox zero. Nothing to review.",
    playful: "🎉 Inbox zero! Nothing to review.",
  },
  // The LEAD of a sentence that `newAccountLine()` finishes by naming the
  // account, so neither voice carries closing punctuation — "…a new account.
  // (ada, signed in with GitLab)" would be two sentences where this is one.
  // Naming the account here answers the #74/#100 question in the place the
  // alarming version of it is actually asked: signing in with the second of two
  // provider accounts produces an empty workspace, and an empty workspace is
  // read on the inbox, not in the header.
  "inbox.newAccount": {
    plain: "Nothing here yet — this is a new account",
    playful: "🍳 Nothing here yet — this account is brand new",
  },

  // ── Links ──────────────────────────────────────────────────────────────────
  "link.seeAll": { plain: "see all →", playful: "see all →" },

  // ── Pills ──────────────────────────────────────────────────────────────────
  "pill.toDo": { plain: "▶ to-do", playful: "▶ to-do" },
  "action.reviewNow": { plain: "Review now", playful: "🥫 Review now" },

  // ── Progress ───────────────────────────────────────────────────────────────
  "progress.done": { plain: "done", playful: "done" },

  // ── First-run welcome card (Phase 5, #8) ──────────────────────────────────
  // v2: the card links out using the app's own section vocabulary (nav.everything
  // for /library, nav.focusTimer for /focus). welcome.help stays voice-neutral,
  // Welcome body is composed from fragments so the Focus Timer / Library / Help
  // links can sit INLINE in the sentences (see welcome-card.tsx). The 👋 lives
  // in the lead (the separate title was dropped). welcome.* keys are exempt from
  // the emoji-free-Plain guard, so the 👋 in Plain is intentional.
  "welcome.lead": {
    plain:
      "👋 Welcome to dlectroflow, you are in the inbox. Write down anything on your mind in the box below. Break big tasks into smaller steps, use the ",
    playful:
      "👋 Welcome to dlectroflow, you're in the inbox. Dump anything on your mind in the box below. Snack-size big tasks into bite-size steps, use the ",
  },
  "welcome.focusLink": { plain: "Focus Timer", playful: "Focus Timer" },
  "welcome.afterFocus": {
    plain:
      " to focus on a task at a time, and tick them off as you go, earning points for your activity! Everything you have captured lives in your ",
    playful:
      " to chew through one bite at a time, and check them off as you go — racking up points for every bite! Everything you've captured keeps in your ",
  },
  "welcome.libraryLink": { plain: "Library", playful: "Larder" },
  "welcome.afterLibrary": { plain: ". View the ", playful: ". Peek at the " },
  "welcome.helpLink": { plain: "Help section", playful: "Help section" },
  "welcome.afterHelp": {
    plain: " for further information.",
    playful: " for the full recipe.",
  },
  "welcome.dismiss": { plain: "Got it", playful: "Got it" },
  // ── Phase 6 — auto-save affordance ─────────────────────────────────────────
  // ✓ is a functional glyph (allowed in plain); → in link/body text likewise.
  "settings.saved": { plain: "Saved ✓", playful: "Saved ✓" },
  "settings.saveError": {
    plain: "Couldn't save — still editable, try again.",
    playful: "Couldn't save — still editable, try again.",
  },

  // ── Phase 6 — Notifications settings ───────────────────────────────────────
  "notify.heading": { plain: "Notifications", playful: "🔔 Notifications" },
  "notify.intro": {
    plain:
      "Choose which desktop notifications you'd like. Each needs your browser's permission.",
    playful: "Pick your desktop nudges. Each needs your browser's permission.",
  },
  "notify.roundup": {
    plain: "End-of-day round-up",
    playful: "🌇 End-of-day round-up",
  },
  "notify.roundupHint": {
    plain:
      "A desktop notification when your workday ends. The in-app recap still shows either way.",
    playful:
      "A desktop nudge when your workday wraps. The in-app recap shows either way.",
  },
  "notify.aging": { plain: "Aging reminders", playful: "🍞 Aging reminders" },
  "notify.agingHint": {
    plain:
      "A desktop notification when an inbox item has been sitting too long.",
    playful: "A desktop nudge when a snack's been sitting too long.",
  },
  "notify.dailyReview": {
    plain: "Daily review nudge",
    playful: "🌙 Daily review nudge",
  },
  "notify.dailyReviewHint": {
    plain: "A once-a-day reminder to review your inbox.",
    playful: "A once-a-day nudge to tidy your tray.",
  },
  "notify.nudgeTime": { plain: "Nudge time", playful: "Nudge time" },
  "notify.enable": {
    plain: "Enable desktop notifications",
    playful: "🔔 Enable desktop notifications",
  },
  "notify.blocked": {
    plain: "Notifications are blocked in your browser settings.",
    playful: "Notifications are blocked in your browser settings.",
  },
  "notify.nudgeTitle": {
    plain: "Time for your daily review",
    playful: "🌙 Time for your daily review",
  },
  "notify.nudgeBody": {
    plain: "Open your inbox to see what's left →",
    playful: "Open your inbox to see what's left →",
  },
  // ── Library "Everything" hub (#8 Phase 3) ──────────────────────────────────
  // Tab labels are the SHORT forms the hub uses (the Inbox sub-headers keep the
  // longer "…to-dos" wording via section.* above). Saved-for-later reuses
  // section.savedLater; Done reuses nav.done.
  "action.back": { plain: "← Back", playful: "← Back" },
  "lib.tab.singleTask": { plain: "Single-task", playful: "😋 Quick bites" },
  "lib.tab.multiStep": { plain: "Multi-step", playful: "✅ Sorted" },
  "lib.intro": {
    plain:
      "Everything that's left your inbox — committed single tasks, stored items, and finished breakdowns.",
    playful:
      "Everything that's left your inbox — committed single tasks, stored items, and finished breakdowns.",
  },
  "lib.plated.hint": {
    plain:
      "Single action items you committed without breaking into steps. Do them whole, or break one into steps later.",
    playful:
      "Single action items you committed without breaking into steps. Do them whole, or snack-size one later.",
  },
  "lib.pantry.hint": {
    plain:
      "Stored for later — the freshness clock is paused until each one wakes.",
    playful:
      "Stored for later — the freshness clock is paused until each one wakes.",
  },
  "lib.sorted.hint": {
    plain:
      "Broken-down tasks in progress — the count shows how many steps you've done. Finished ones move to Done. Tap to reopen.",
    playful:
      "Broken-down tasks in progress — the count shows how many steps you've done. Finished ones move to Done. Tap to reopen.",
  },
  "lib.done.hint": {
    plain: "Finished — every step done.",
    playful: "Finished — every step done. 🎉",
  },
  "lib.added": { plain: "added", playful: "added" },
  "lib.wakes": { plain: "wakes", playful: "wakes" },
  "lib.aToDo": { plain: "a to-do", playful: "a to-do" },
  "lib.select": { plain: "Select", playful: "Select" },
  "lib.selectAll": { plain: "Select all", playful: "Select all" },
  "lib.collapseAll": { plain: "Collapse all", playful: "Collapse all" },
  "lib.expandAll": { plain: "Expand all", playful: "Expand all" },
  "lib.selected": { plain: "selected", playful: "selected" },
  "lib.openTask": { plain: "Open task", playful: "Open task" },
  "lib.deleteConfirm": { plain: "Delete these?", playful: "Delete these?" },
  "lib.next": { plain: "Next:", playful: "Next:" },
  "lib.minLeft": { plain: "min left", playful: "min left" },
  "lib.min": { plain: "min", playful: "min" },
  // #27 follow-up — the active-step pill on a multi-step row (Library +
  // Inbox), distinguishing "time left on the step you're mid-way through"
  // from the row's task-total pill (lib.minLeft).
  "lib.minOnStep": { plain: "min on step", playful: "min on step" },
  "lib.editEstimate": { plain: "Edit estimate", playful: "Edit estimate" },

  // ── Task working-view — schedule indicator (#8 follow-up) ─────────────────
  // Mirrors the Inbox row's hardcoded "Scheduled ✓" text (row-actions.tsx) —
  // kept identical across voices, same as capture.confirm, rather than
  // inventing new playful copy for a status marker.
  "task.scheduled": { plain: "Scheduled ✓", playful: "Scheduled ✓" },
  "task.notScheduled": {
    plain: "Not scheduled yet",
    playful: "Not scheduled yet",
  },
  // ── Scheduled-event focus deep-link note (S6, #39) — embedded in the .ics
  // VEVENT DESCRIPTION and the Google Task notes so tapping the scheduled item
  // drops the user straight into /focus. ▶ is a functional glyph (allowed in
  // plain); 🍽️ is the playful "at the table" flavour used across focus copy.
  "schedule.focusNote": {
    plain: "▶ Open the focus timer for this:",
    playful: "🍽️ Open the focus timer for this:",
  },
  // Task working-view header eyebrow (!83 top redesign) — a small structural
  // label so the open-task view reads as distinct from the Library hub at a
  // glance. Structural chrome, not a flavour opportunity, so it's kept
  // identical across voices (same call as task.scheduled/notScheduled above).
  "task.eyebrow": { plain: "Task", playful: "Task" },

  // ── #44 — the note disclosure, on a task and on a step row ────────────────
  // ONE noun, never "Add"/"Edit". Both of those describe a one-off action and
  // this is a persistent autosaving field, not an action. The switch also told
  // a lie in a case that is about to be common — #179 carries a note in from a
  // brain dump via `{curly brace}` syntax, so a note can exist before anyone
  // has "added" anything. A fixed word additionally means the control does not
  // change width the instant somebody types their first character, so the row
  // does not shift under them.
  //
  // This is the VISIBLE label only — the component appends the task or step it
  // belongs to for assistive tech, so a list of steps does not present a dozen
  // buttons with identical names. Keeping it a PREFIX of the accessible name is
  // what keeps WCAG 2.5.3 (Label in Name) satisfied for voice control.
  // 🗒️ is flavour, so playful only: plain voice is emoji-free app-wide.
  "note.trigger": { plain: "Note", playful: "🗒️ Note" },
  // The field's accessible name (`aria-label` on the textarea). Same word in
  // both voices and deliberately emoji-free: it is read out every time the
  // field takes focus. There is no longer a VISIBLE label element — the trigger
  // directly above the field already reads "Note", and two identical words
  // stacked for one field is noise. See note-field.tsx for what that removal
  // had to preserve.
  "note.label": { plain: "Note", playful: "Note" },
  // Inside the box, matching the brain-dump capture input's pattern (owner).
  // An EXAMPLE of the kind of thing a note is for, not a restatement of the
  // word "Note" — the owner's own illustration when specifying #44 was "water
  // can under sink needs a wash" against a task called "water the office
  // plants": a detail that changes how you do the thing.
  //
  // Short on purpose: a step row's textarea is two rows tall and a long
  // placeholder truncates. It is NOT the accessible name — a placeholder is
  // unreliable across assistive tech and vanishes on the first keystroke, so
  // the textarea keeps an explicit `aria-label`.
  "note.placeholder": {
    plain: "Anything worth knowing when you start…",
    playful: "Anything worth knowing when you sit down…",
  },
  "note.hint": {
    plain:
      "Rides along into your calendar event or Google Task when you schedule this. Saves automatically.",
    playful:
      "Tags along into your calendar event or Google Task when you plate this up. Saves itself.",
  },

  // ── MR ③ — Appearance (theme + app-wide completion style) ──────────────────
  // ✓ is a functional glyph (allowed in plain).
  "appearance.heading": { plain: "Appearance", playful: "🎨 Appearance" },
  "appearance.theme": { plain: "Theme", playful: "Theme" },
  "appearance.completionIntro": {
    plain: "How finished to-dos and steps look across the app.",
    playful: "How your checked-off bites look across the app.",
  },
  "appearance.strike": {
    plain: "Strike through completed",
    playful: "Strike through completed",
  },
  "appearance.tick": { plain: "Tick colour", playful: "Tick colour" },
  "appearance.tickGreen": { plain: "Green", playful: "Green" },
  "appearance.tickBlack": { plain: "Black", playful: "Black" },
  "appearance.previewText": { plain: "Done to-do", playful: "Done to-do" },

  // ── #40 — Appearance typeface picker (a11y). The intro carries the
  // accessibility note in both voices; option labels stay as the font names. ──
  "appearance.typeface": { plain: "Typeface", playful: "Typeface" },
  "appearance.typefaceIntro": {
    plain:
      "The font used across the app. Atkinson Hyperlegible and OpenDyslexic are designed to make reading easier for low-vision and dyslexic readers.",
    playful:
      "Pick the font that reads best for you — Atkinson Hyperlegible and OpenDyslexic are built to help with low-vision and dyslexia.",
  },
  "appearance.typefaceFigtree": {
    plain: "Figtree (default)",
    playful: "Figtree (default)",
  },
  "appearance.typefaceAtkinson": {
    plain: "Atkinson Hyperlegible",
    playful: "Atkinson Hyperlegible",
  },
  "appearance.typefaceOpenDyslexic": {
    plain: "OpenDyslexic",
    playful: "OpenDyslexic",
  },
  "appearance.typefaceSystem": { plain: "System", playful: "System" },
  "appearance.typefacePreview": {
    plain: "The quick brown fox jumps over the lazy dog.",
    playful: "The quick brown fox jumps over the lazy dog.",
  },

  // ── #11 — guest read-only settings + onboarding help ───────────────────────
  // Guests see owner-only controls (AI breakdown model, integrations) as
  // disabled shells so they can tell what the app offers, never the owner's
  // actual values. The "owner-only" copy stays emoji-free in plain (🔒 is added
  // in the markup as an allowed functional glyph, not baked into the string).
  "settings.ownerOnly": { plain: "Owner-only", playful: "Owner-only" },
  "settings.modelOwnerHint": {
    plain:
      "The workspace owner chooses which model powers AI breakdowns. Guests get a fast model automatically.",
    playful:
      "The workspace owner picks which model does the AI breakdowns. As a guest you get a speedy one, on the house.",
  },
  // #118 Phase C — integrations are PER USER now, so the read-only shell is for
  // a caller with no ACCOUNT rather than for anyone who is not the owner.
  // `settings.integrationsOwnerHint` is gone with it; `settings.ownerOnly` stays
  // because BreakdownModelSection is still genuinely owner-only.
  "settings.integrationsSignedOut": { plain: "Sign in", playful: "Sign in" },
  // #118 Phase C — the Account section. A member's own API key: what storing one
  // changes (it pays for their breakdowns, so no instance cap applies) is the one
  // thing they cannot discover, so the copy states it outright.
  "settings.accountHeading": { plain: "Account", playful: "Account" },
  "settings.accountKeyLabel": { plain: "API key", playful: "API key" },
  "settings.accountKeyHint": {
    plain:
      "Add your own API key and your AI breakdowns run on it instead of this instance's — so no usage limit applies to you. It is encrypted before it is stored and never shown again, not even to you.",
    playful:
      "Bring your own API key and your breakdowns run on your tab instead of the instance's — no usage limit for you. 🔐 Encrypted on the way in, never shown again, not even to you.",
  },
  "settings.accountKeyInUse": {
    plain: "Your own key is in use — no instance usage limit applies to you.",
    playful:
      "✅ Your own key is in use — no instance usage limit applies to you.",
  },
  "settings.accountKeyRemoveConfirm": {
    plain:
      "Remove your key? AI will go back to this instance's key and its usage limits.",
    playful:
      "Remove your key? AI goes back to this instance's key — and its usage limits.",
  },
  "settings.accountKeySaved": { plain: "Key saved ✓", playful: "Key saved ✓" },
  "settings.accountKeyRemoved": {
    plain: "Key removed ✓",
    playful: "Key removed ✓",
  },
  "settings.accountKeyRejected": {
    plain: "That key was not accepted. Check you pasted all of it.",
    playful: "That key was not accepted — check you pasted the whole thing.",
  },
  "settings.accountKeySignedOut": {
    plain: "You are no longer signed in. Reload and sign in again.",
    playful: "You are no longer signed in. Reload and sign in again.",
  },
  "settings.integrationsSignInHint": {
    plain:
      "Sign in to connect your own Google account. Your connection is yours alone — nobody else on this instance can see or use it.",
    playful:
      "Sign in to hook up your own Google account. Yours alone — nobody else gets a peek. 🔒",
  },
  // Settings footer link → in-app /help docs. Dedicated key (not the shared
  // nav.help label) so the footer reads "Help & Docs" — both words capitalised
  // — without disturbing the nav-menu "Help" item or the "← Back" button.
  "settings.helpDocs": { plain: "Help & Docs", playful: "🆘 Help & Docs" },
  // Guest sandbox onboarding link → in-app /help docs (#29). → is a functional
  // glyph (allowed in plain); 🆘 is playful-only flavour.

  // ── #199 Shopping list mode ────────────────────────────────────────────────
  // A list-shaped thing that is NOT a task. The copy leans on that deliberately:
  // nothing here mentions estimates, steps, scheduling or streaks, because the
  // feature is outside all four and copy that borrowed their vocabulary would
  // promise behaviour the page does not have.
  "shopping.intro": {
    plain:
      "A plain list. No estimates, no steps, nothing lands in your calendar, and ticking one off does not touch your streak.",
    playful:
      "🛒 Just a list. No estimates, no steps, nothing hits your calendar — and ticking one off won't touch your streak.",
  },
  "shopping.addLabel": { plain: "Add to the list", playful: "Add to the list" },
  "shopping.addPlaceholder": {
    plain: "e.g. oat milk",
    playful: "e.g. oat milk 🥛",
  },
  "shopping.add": { plain: "Add", playful: "➕ Add" },
  // The three refusals are separate keys, not one "that didn't work": a capture
  // field that fails without saying which rule was broken is the failure mode
  // that makes people stop trusting it.
  "shopping.errorEmpty": {
    plain: "Type something first.",
    playful: "Type something first.",
  },
  "shopping.errorTooLong": {
    plain: "That is too long for one line — 200 characters is the limit.",
    playful: "Whoa, that's a paragraph — 200 characters is the limit.",
  },
  "shopping.errorFull": {
    plain:
      "This list is full at 500 items. Tick a few off and delete them to make room.",
    playful: "This list is full at 500 items. Clear a few to make room. 🧹",
  },
  "shopping.sectionActive": { plain: "To buy", playful: "🛒 To buy" },
  "shopping.sectionSaved": {
    plain: "Saved for later",
    playful: "🥫 Saved for later",
  },
  "shopping.savedHint": {
    plain:
      "Nothing here comes back on its own — pull an item up when you want it again.",
    playful:
      "Nothing here comes back on its own — pull it up when you want it again.",
  },
  "shopping.empty": {
    plain: "Nothing on the list yet.",
    playful: "Nothing on the list yet.",
  },
  // Counted noun, split so a count reads "1 item" / "3 items". Same shape as
  // focus.sound.trackOne/trackMany, and #199 part 2's inbox summary reuses these
  // keys rather than spelling the word again.
  "shopping.itemOne": { plain: "item", playful: "item" },
  "shopping.itemMany": { plain: "items", playful: "items" },
  "shopping.stillToBuy": { plain: "still to buy", playful: "still to buy" },
  // #199 — the inbox summary line, composed as
  // `<count> <shopping.itemOne|itemMany> <shopping.summaryOn>`. Composed rather
  // than one templated string because this table carries no interpolation, and
  // reusing the counted noun is what stops the inbox and the /shopping header
  // disagreeing about what one item is called.
  "shopping.summaryOn": {
    plain: "on your shopping list",
    // The emoji sits before the NOUN, not at the head of the fragment: the label is
    // composed as `<count> <item|items> <this>`, so a leading glyph would read
    // "3 items 🛒 on your shopping list" — an emoji dropped into the middle of a
    // sentence rather than decorating the thing it depicts.
    playful: "on your 🛒 shopping list",
  },
  "shopping.summaryDismiss": {
    plain: "Not now",
    playful: "Not now",
  },
  // "the list grows", not "you add something" (Duo review, !295). Adding is one
  // of the THREE writes `syncShoppingSummary` resurfaces a dismissed summary on —
  // the others are un-ticking an item and pulling one back up from saved-for-later
  // — and this hint is the only place the app explains what "Not now" does. Naming
  // one trigger made the other two look like a bug: un-tick something, watch the
  // line return, and the app has contradicted the last thing it told you about
  // that control. "Grows" is the rule itself, in fewer words than listing them,
  // and it is already how `shopping-summary-sync.ts` and `dismissShoppingSummary`
  // both state it — the string was the one place that disagreed.
  //
  // Identical across voices, like `summaryDismiss` above: this is the sentence
  // that keeps a temporary control from reading as a delete, and the one place
  // where flavour would be paid for in comprehension.
  "shopping.summaryDismissHint": {
    plain: "Back when the list grows.",
    playful: "Back when the list grows.",
  },
  // Duo review, !295 — a rejected `dismissShoppingSummary()` used to clear the
  // pending flag and say nothing, so the user believed "Not now" had worked until
  // the line turned up again. The sentence has to contradict that belief with the
  // fact they can check for themselves — the line is still here — rather than the
  // generic "something went wrong", which leaves them guessing which half failed.
  //
  // No emoji in the playful variant, and no joke: this is the copy that lands on
  // somebody whose press just did not work, and flavour there is paid for by the
  // one person least able to spare it. Only the contraction differs, which is the
  // same plain/playful split `shopping.errorTooLong` uses.
  "shopping.summaryDismissError": {
    plain: "That did not go through — the line is still here. Try again.",
    playful: "That didn't go through — the line's still here. Try again.",
  },
  // Accessible names. Each one names the ITEM, because "Delete" repeated down a
  // list of twelve rows is unusable in a screen reader's element list.
  "shopping.tickOff": { plain: "Tick off", playful: "Tick off" },
  "shopping.saveForLater": {
    plain: "Save for later",
    playful: "Save for later",
  },
  "shopping.moveBackUp": {
    plain: "Move back to the list",
    playful: "Move back to the list",
  },
  "shopping.delete": { plain: "Delete", playful: "Delete" },
  "shopping.rename": { plain: "Rename", playful: "Rename" },
  // Settings section.
  "shopping.settingsHeading": {
    plain: "Shopping list",
    playful: "🛒 Shopping list",
  },
  "shopping.settingsToggle": {
    plain: "Show the shopping list",
    playful: "Show the shopping list",
  },
  "shopping.settingsHint": {
    plain:
      "Adds a Shopping list to the menu: a plain list for things that are not tasks. Off by default. Turning it off hides the list without deleting it.",
    playful:
      "Adds a 🛒 Shopping list to the menu — a plain list for things that aren't tasks. Off by default, and turning it off hides the list rather than binning it.",
  },
  "guest.newHere": { plain: "New here?", playful: "New here?" },
  "guest.helpCta": {
    plain: "See the help & docs →",
    playful: "🆘 See the help & docs →",
  },
} as const;

export type StringKey = keyof typeof STRINGS;

/**
 * Resolve a localized string by key and voice.
 * Pure function — no side effects, no imports from SDK or DB.
 */
export function t(key: StringKey, voice: Voice): string {
  return STRINGS[key][voice];
}
