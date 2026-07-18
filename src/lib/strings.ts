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
  "action.breakdown":    { plain: "Break into steps",  playful: "🍿 Snack-size it" },
  "action.addTodo":      { plain: "Add to-do",         playful: "🍽️ Add to-do" },
  "action.saveForLater": { plain: "Save for later",    playful: "🥫 Save for later" },
  "action.confirmSteps": { plain: "Confirm steps",     playful: "✅ Confirm steps" },
  "action.startFocus":   { plain: "Start focusing",    playful: "🍽️ Start focusing" },
  "action.pauseForNow":  { plain: "Pause for now",     playful: "⏸️ Pause for now" },
  "action.moreSteps":    { plain: "More steps",        playful: "🍞 More steps" },
  "action.fewerSteps":   { plain: "Fewer steps",       playful: "🥖 Fewer steps" },
  "action.backToInbox":  { plain: "Back to inbox",     playful: "🍳 Back to inbox" },
  "action.backToLibrary": { plain: "Back to Library",  playful: "🍱 Back to the Larder" },
  "action.addStep":      { plain: "Add a step",        playful: "🍞 Add a step" },
  "action.removeStep":   { plain: "Remove step",       playful: "🥖 Remove step" },
  "action.dismiss":      { plain: "Dismiss",           playful: "Not now" },
  "action.stillNeeded":  { plain: "Still need it",     playful: "Still want it" },
  "action.delete":       { plain: "Delete",            playful: "Delete" },
  "action.cancel":       { plain: "Cancel",            playful: "Cancel" },
  "action.complete":     { plain: "Complete",          playful: "✅ Complete" },
  "action.reopen":       { plain: "Reopen",            playful: "Reopen" },
  "action.reopenSelected": { plain: "Reopen selected", playful: "Reopen selected" },
  "action.reopenAll":    { plain: "Reopen all",        playful: "Reopen all" },
  "action.moveTo":       { plain: "Move to…",          playful: "Move to…" },

  // v6 row redesign — short CTA on the visible buttons, full descriptive wording
  // in the ▾ dropdown. The button variants above stay short; these are the
  // dropdown's full-length mirrors (+ a short "Save" for the button).
  "action.breakdownFull":{ plain: "Break into smaller steps", playful: "🍿 Snack-size into smaller steps" },
  "action.addTodoFull":  { plain: "Add as single task to do", playful: "🍽️ Add as single task to do" },
  "action.saveShort":    { plain: "Save",                      playful: "🥫 Save" },
  "action.completeFull": { plain: "Mark as completed",         playful: "✅ Mark as completed" },
  "action.editTitle":    { plain: "Edit task title",           playful: "Edit task title" },
  "action.schedule":     { plain: "Schedule",                  playful: "🗓️ Schedule" },
  "action.addToCalendar": { plain: "Add to calendar (.ics)", playful: "📅 Add to calendar (.ics)" },

  // ── Step rows (TaskSteps working view, #25) ────────────────────────────────
  // Voice-aware labels for the redesigned step rows. Plain = literal; playful =
  // food-themed to match the rest of the row (🍽️/🍴 = at the table, focusing).
  "step.startFocus":       { plain: "▶ Start Focus",       playful: "▶ Start Focus" },
  "step.resumeFocus":      { plain: "▶ Resume Focus",      playful: "▶ Resume Focus" },
  "step.startFocusTimer":  { plain: "Start focus timer",   playful: "🍽️ Start focus timer" },
  "step.resumeFocusTimer": { plain: "Resume focus timer",  playful: "🍴 Resume focus timer" },
  "step.complete":         { plain: "Complete step",       playful: "✅ Complete step" },
  "step.editEstimate":     { plain: "Edit time estimate",  playful: "⏱️ Edit time estimate" },
  "step.editTitle":        { plain: "Edit step title",     playful: "✏️ Edit step title" },
  "step.sendToReview":     { plain: "Send back to review", playful: "🥫 Send back to review" },

  // ── Inbox section headers ──────────────────────────────────────────────────
  "section.needsReview":    { plain: "Needs review",      playful: "Needs review" },
  "section.toDo":           { plain: "To do",             playful: "To do" },
  "section.singleTask":     { plain: "Single-task to-dos",playful: "😋 Quick bites" },
  "section.multiStep":      { plain: "Multi-step to-dos", playful: "✅ Sorted" },
  "section.savedLater":     { plain: "Saved for later",   playful: "🥫 Pantry" },
  "section.completed":      { plain: "Completed",         playful: "🍽️ Cleared plate" },
  "section.completedToday": { plain: "Completed today",   playful: "Cleared today" },

  // ── Bucket board (Phase B) ─────────────────────────────────────────────────
  "bucket.empty":        { plain: "Nothing here yet",  playful: "Nothing here yet" },

  // ── Nav / hub labels ───────────────────────────────────────────────────────
  "nav.inbox":           { plain: "Inbox",             playful: "🧠 Inbox" },
  "nav.dashboard":       { plain: "Dashboard",         playful: "🎉 Dashboard" },
  "nav.everything":      { plain: "Library",           playful: "🍱 Larder" },
  "nav.done":            { plain: "Done",              playful: "🍽️ Devoured" },
  "nav.focusTimer":      { plain: "Focus Timer",       playful: "⏱️ Focus Timer" },
  "nav.settings":        { plain: "Settings",          playful: "⚙️ Settings" },
  "nav.help":            { plain: "Help",              playful: "🆘 Help" },

  // ── Freshness tiers ────────────────────────────────────────────────────────
  "freshness.recent":    { plain: "Recent",            playful: "Fresh" },
  "freshness.aging":     { plain: "Aging",             playful: "Softening" },
  "freshness.overdue":   { plain: "Overdue",           playful: "Soggy" },
  "freshness.wayOverdue":{ plain: "Way overdue",       playful: "Stale" },

  // ── Dashboard stats ────────────────────────────────────────────────────────
  "stat.pointsToday":    { plain: "Points today",      playful: "Crumbs today" },
  "stat.currentStreak":  { plain: "Current streak",    playful: "On a roll" },
  "stat.focusMinsToday": { plain: "Focus mins today",  playful: "Time at the table" },
  "stat.stepsToday":     { plain: "Steps today",       playful: "Bites today" },
  "stat.totalPoints":    { plain: "Total points earned", playful: "Total crumbs earned" },

  // ── Dashboard section headings ─────────────────────────────────────────────
  "heading.bestStreaks":        { plain: "Best streaks",       playful: "🏆 Best streaks" },

  // ── Badge labels ───────────────────────────────────────────────────────────
  "badge.first_breakdown":      { plain: "First breakdown",   playful: "🍰 First Slice" },
  "badge.first_schedule":       { plain: "First scheduled",   playful: "🍽️ First Plate-up" },
  "badge.first_focus":          { plain: "First focus",       playful: "😋 First Bite" },
  "badge.task_complete":        { plain: "Task complete",     playful: "🧽 Clean Plate" },
  "badge.streak_5":             { plain: "Full work week",    playful: "🔥 Full Week" },
  "badge.inbox_zero":           { plain: "Inbox zero",        playful: "🧺 Empty Tray" },
  "badge.comeback":             { plain: "Comeback",          playful: "📦 Back for Seconds" },
  "badge.ten_steps_day":        { plain: "10 steps in a day", playful: "🔟 Ten-Bite Day" },
  "badge.beat_best_streak":     { plain: "Beat your best streak", playful: "🏆 New Record" },

  // ── Focus timer labels ─────────────────────────────────────────────────────
  "focus.startTimer":   { plain: "▶ Start focusing",   playful: "▶ Start focusing" },
  "focus.complete":     { plain: "✅ Complete",          playful: "✅ Complete" },
  "focus.pause":        { plain: "⏸️ Pause",            playful: "⏸️ Pause" },
  "focus.resume":       { plain: "▶ Resume",            playful: "▶ Resume" },
  "focus.giveUp":       { plain: "Pause for now",       playful: "⏸️ Pause for now" },
  "focus.timesUp":      { plain: "Time's up — did you finish?",    playful: "⏰ Time's up — did you finish?" },
  "focus.yesDone":      { plain: "✅ Yes, done!",        playful: "✅ Yes, done!" },
  "focus.notYet":       { plain: "Not yet",             playful: "🔁 Not yet" },
  "focus.nextStep":     { plain: "Focus the next step", playful: "Focus the next bite" },

  // ── Breakdown confirm ──────────────────────────────────────────────────────
  "breakdown.looksRight": { plain: "Looks right",       playful: "👍 Looks right" },

  // ── Breakdown step counter ─────────────────────────────────────────────────
  "step.counter":        { plain: "Step",              playful: "bite" },

  // ── Capture confirm ────────────────────────────────────────────────────────
  "capture.confirm":     { plain: "captured ✓",        playful: "captured ✓" },

  // ── Prompts ────────────────────────────────────────────────────────────────
  "prompt.stillNeeded":  { plain: "This has been sitting a while — still needed?", playful: "🕐 This snack's been sitting a while — still want it?" },
  "prompt.breakNow":     { plain: "Break into steps now?", playful: "🍿 Snack-size it now?" },
  "prompt.reopenWhich":  { plain: "Which steps still need doing?", playful: "Which steps go back on the plate?" },

  // ── Inbox empty state ──────────────────────────────────────────────────────
  "inbox.zero":          { plain: "Inbox zero. Nothing to review.", playful: "🎉 Inbox zero! Nothing to review." },

  // ── Links ──────────────────────────────────────────────────────────────────
  "link.seeAll":         { plain: "see all →",         playful: "see all →" },

  // ── Pills ──────────────────────────────────────────────────────────────────
  "pill.toDo":           { plain: "▶ to-do",           playful: "▶ to-do" },
  "action.reviewNow":    { plain: "Review now",        playful: "🥫 Review now" },

  // ── Progress ───────────────────────────────────────────────────────────────
  "progress.done":       { plain: "done",              playful: "done" },

  // ── Library "Everything" hub (#8 Phase 3) ──────────────────────────────────
  // Tab labels are the SHORT forms the hub uses (the Inbox sub-headers keep the
  // longer "…to-dos" wording via section.* above). Saved-for-later reuses
  // section.savedLater; Done reuses nav.done.
  "action.back":         { plain: "← Back",            playful: "← Back" },
  "lib.tab.singleTask":  { plain: "Single-task",       playful: "😋 Quick bites" },
  "lib.tab.multiStep":   { plain: "Multi-step",        playful: "✅ Sorted" },
  "lib.intro":           {
    plain: "Everything that's left your inbox — committed single tasks, stored items, and finished breakdowns.",
    playful: "Everything that's left your inbox — committed single tasks, stored items, and finished breakdowns.",
  },
  "lib.plated.hint":     {
    plain: "Single action items you committed without breaking into steps. Do them whole, or break one into steps later.",
    playful: "Single action items you committed without breaking into steps. Do them whole, or snack-size one later.",
  },
  "lib.pantry.hint":     {
    plain: "Stored for later — the freshness clock is paused until each one wakes.",
    playful: "Stored for later — the freshness clock is paused until each one wakes.",
  },
  "lib.sorted.hint":     {
    plain: "Broken-down tasks in progress — the count shows how many steps you've done. Finished ones move to Done. Tap to reopen.",
    playful: "Broken-down tasks in progress — the count shows how many steps you've done. Finished ones move to Done. Tap to reopen.",
  },
  "lib.done.hint":       {
    plain: "Finished — every step done.",
    playful: "Finished — every step done. 🎉",
  },
  "lib.added":           { plain: "added",             playful: "added" },
  "lib.wakes":           { plain: "wakes",             playful: "wakes" },
  "lib.aToDo":           { plain: "a to-do",           playful: "a to-do" },
  "lib.select":          { plain: "Select",            playful: "Select" },
  "lib.selectAll":       { plain: "Select all",        playful: "Select all" },
  "lib.selected":        { plain: "selected",          playful: "selected" },
  "lib.openTask":        { plain: "Open task",         playful: "Open task" },
  "lib.deleteConfirm":   { plain: "Delete these?",     playful: "Delete these?" },
  "lib.next":            { plain: "Next:",             playful: "Next:" },
  "lib.minLeft":         { plain: "min left",          playful: "min left" },
  "lib.min":             { plain: "min",               playful: "min" },
  "lib.editEstimate":    { plain: "Edit estimate",     playful: "Edit estimate" },

  // ── Task working-view — schedule indicator (#8 follow-up) ─────────────────
  // Mirrors the Inbox row's hardcoded "Scheduled ✓" text (row-actions.tsx) —
  // kept identical across voices, same as capture.confirm, rather than
  // inventing new playful copy for a status marker.
  "task.scheduled":      { plain: "Scheduled ✓",       playful: "Scheduled ✓" },
  "task.notScheduled":   { plain: "Not scheduled yet", playful: "Not scheduled yet" },
} as const;

export type StringKey = keyof typeof STRINGS;

/**
 * Resolve a localized string by key and voice.
 * Pure function — no side effects, no imports from SDK or DB.
 */
export function t(key: StringKey, voice: Voice): string {
  return STRINGS[key][voice];
}
