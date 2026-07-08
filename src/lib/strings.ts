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

  // ── Inbox section headers ──────────────────────────────────────────────────
  "section.needsReview": { plain: "Needs review",      playful: "Needs review" },
  "section.toDo":        { plain: "To do",             playful: "To do" },
  "section.singleTask":  { plain: "Single-task to-dos",playful: "😋 Quick bites" },
  "section.multiStep":   { plain: "Multi-step to-dos", playful: "✅ Sorted" },
  "section.savedLater":  { plain: "Saved for later",   playful: "🥫 Pantry" },

  // ── Nav / hub labels ───────────────────────────────────────────────────────
  "nav.inbox":           { plain: "Inbox",             playful: "🧠 Inbox" },
  "nav.dashboard":       { plain: "Dashboard",         playful: "🎉 Dashboard" },
  "nav.everything":      { plain: "Everything",        playful: "🍱 Larder" },
  "nav.done":            { plain: "Done",              playful: "🍽️ Devoured" },

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
} as const;

export type StringKey = keyof typeof STRINGS;

/**
 * Resolve a localized string by key and voice.
 * Pure function — no side effects, no imports from SDK or DB.
 */
export function t(key: StringKey, voice: Voice): string {
  return STRINGS[key][voice];
}
