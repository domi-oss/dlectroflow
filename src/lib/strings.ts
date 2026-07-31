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
  "focus.timesUp": {
    plain: "Time's up — did you finish?",
    playful: "⏰ Time's up — did you finish?",
  },
  "focus.yesDone": { plain: "✅ Yes, done!", playful: "✅ Yes, done!" },
  "focus.notYet": { plain: "Not yet", playful: "🔁 Not yet" },
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
  "focusSettings.sound": { plain: "Focus sounds", playful: "🎧 Focus sounds" },
  // #68 — the timer plays a real playlist now (it advances itself and only
  // wraps once every track has played), so this copy must not promise a loop.
  "focusSettings.soundHint": {
    plain: "Play a calm lo-fi playlist while you focus.",
    playful: "Play a calm lo-fi playlist while you focus.",
  },
  "focusSettings.soundOff": { plain: "Off", playful: "Off" },
  "focusSettings.soundLofiCalm": {
    plain: "Lo-fi (calm)",
    playful: "Lo-fi (calm)",
  },
  // #43 — lo-fi library picker + preview. Labels stay identical across voices
  // (functional controls); the composed aria-labels append the track title.
  "focusSettings.soundPickerHint": {
    plain:
      "Pick the track your focus playlist starts on, or preview each one first.",
    playful:
      "Pick the track your focus playlist starts on, or preview each one first. 🎧",
  },
  "focusSettings.preview": { plain: "Preview", playful: "Preview" },
  "focusSettings.stopPreview": {
    plain: "Stop preview",
    playful: "Stop preview",
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
