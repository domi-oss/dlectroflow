// Allowed string values for SQLite-backed status/role/outcome columns
// (Prisma enums aren't supported on SQLite). Mirror of the inline comments
// in prisma/schema.prisma — import these instead of hardcoding literals.

export const BrainDumpStatus = {
  Inbox: "inbox",
  Triaged: "triaged",
  Archived: "archived",
} as const;
export type BrainDumpStatus =
  (typeof BrainDumpStatus)[keyof typeof BrainDumpStatus];

export const TaskStatus = {
  Active: "active",
  Done: "done",
  Archived: "archived",
} as const;
export type TaskStatus = (typeof TaskStatus)[keyof typeof TaskStatus];

export const TaskSource = {
  BrainDump: "braindump",
  Manual: "manual",
} as const;
export type TaskSource = (typeof TaskSource)[keyof typeof TaskSource];

export const TurnRole = {
  User: "user",
  Assistant: "assistant",
} as const;
export type TurnRole = (typeof TurnRole)[keyof typeof TurnRole];

export const FocusOutcome = {
  Completed: "completed",
  Requeued: "requeued",
  GaveUp: "gaveup",
} as const;
export type FocusOutcome = (typeof FocusOutcome)[keyof typeof FocusOutcome];

export const RewardType = {
  StepDone: "step_done",
  SessionFinished: "session_finished",
  InboxZero: "inbox_zero",
  BreakdownConfirmed: "breakdown_confirmed",
  Scheduled: "scheduled",
  TaskComplete: "task_complete",
} as const;
export type RewardType = (typeof RewardType)[keyof typeof RewardType];

export const RewardPoints: Record<RewardType, number> = {
  step_done: 10,
  session_finished: 5,
  inbox_zero: 15,
  breakdown_confirmed: 10,
  scheduled: 10,
  task_complete: 25,
};

export const SparkSource = {
  AI: "ai",
  Fallback: "fallback",
} as const;
export type SparkSource = (typeof SparkSource)[keyof typeof SparkSource];

export const BadgeKey = {
  FirstBreakdown: "first_breakdown",
  FirstSchedule: "first_schedule",
  FirstFocus: "first_focus",
  Streak5: "streak_5",
  TenStepsDay: "ten_steps_day",
  BeatBestStreak: "beat_best_streak",
  TaskComplete: "task_complete",
  InboxZero: "inbox_zero",
  Comeback: "comeback",
} as const;
export type BadgeKey = (typeof BadgeKey)[keyof typeof BadgeKey];

// The badges shown on the dashboard, in display order: the seven named badges
// (wireframe § Dashboard) followed by the two legacy badges the owner chose to
// surface (owner decision on !82). Full work week = the 5-working-day streak
// (`streak_5`).
export const DASHBOARD_BADGE_KEYS: readonly BadgeKey[] = [
  BadgeKey.FirstBreakdown,
  BadgeKey.FirstSchedule,
  BadgeKey.FirstFocus,
  BadgeKey.TaskComplete,
  BadgeKey.Streak5,
  BadgeKey.InboxZero,
  BadgeKey.Comeback,
  // Legacy badges, surfaced per owner decision on !82.
  BadgeKey.TenStepsDay,
  BadgeKey.BeatBestStreak,
];

export const SINGLETON_ID = "singleton";

export const OWNER_WORKSPACE_ID = "owner";

export function isGuestWorkspace(workspaceId: string): boolean {
  return workspaceId !== OWNER_WORKSPACE_ID;
}

export const WorkspaceKind = {
  Owner: "owner",
  Guest: "guest",
} as const;
export type WorkspaceKind = (typeof WorkspaceKind)[keyof typeof WorkspaceKind];

// ── Phase 2 — breakdown model selection ───────────────────────────────────
// Owner-selectable models (validated server-side). claude-fable-5 is shown in
// the UI but deliberately NOT allowlisted — it can never be selected/honored.
export const OWNER_BREAKDOWN_ALLOWLIST = [
  "claude-haiku-4-5",
  "claude-sonnet-4-6",
  "claude-opus-4-8",
] as const;
export type BreakdownModel = (typeof OWNER_BREAKDOWN_ALLOWLIST)[number];

export const OWNER_BREAKDOWN_MODEL_DEFAULT = "claude-sonnet-4-6";
export const GUEST_BREAKDOWN_MODEL_DEFAULT = "claude-haiku-4-5";

// ── MR ② — Focus timer redesign (Focus-timer settings) ─────────────────────
// focusTimerStyle + focusSound are String columns guarded by Postgres CHECK
// constraints (Settings_focusTimerStyle_check / Settings_focusSound_check).
// These objects are the single source of truth for the allowed sets; the CHECK
// migration + enum-constraint-sync test mirror them. focusTimerStyle is nullable
// (null → the timer resolves a style from the voice); focusSound defaults "off".
export const FocusTimerStyle = {
  Ring: "ring",
  Digits: "digits",
  Bar: "bar",
  Mug: "mug",
} as const;
export type FocusTimerStyle =
  (typeof FocusTimerStyle)[keyof typeof FocusTimerStyle];

export const FocusSound = {
  Off: "off",
  LofiCalm: "lofi_calm",
} as const;
export type FocusSound = (typeof FocusSound)[keyof typeof FocusSound];

// ── MR ③ — app-wide completion style (Appearance settings) ─────────────────
// completeTickColor is a String column guarded by a Postgres CHECK constraint
// (Settings_completeTickColor_check). This object is the single source of truth
// for the allowed set; the CHECK migration + enum-constraint-sync test mirror it.
export const CompleteTickColor = {
  Green: "green",
  Black: "black",
} as const;
export type CompleteTickColor =
  (typeof CompleteTickColor)[keyof typeof CompleteTickColor];

// ── #40 — user-selected UI typeface (Appearance, a11y) ─────────────────────
// typeface is a String column guarded by a Postgres CHECK constraint
// (Settings_typeface_check). This object is the single source of truth for the
// allowed set; the CHECK migration + enum-constraint-sync test mirror it. An
// out-of-set value degrades to Figtree (the app default) at both the resolver
// (typefaceRootAttrs) and the server-action upsert. Atkinson Hyperlegible and
// OpenDyslexic are legibility/dyslexia aids; System uses the native font stack.
export const Typeface = {
  Figtree: "figtree",
  Atkinson: "atkinson",
  OpenDyslexic: "opendyslexic",
  System: "system",
} as const;
export type Typeface = (typeof Typeface)[keyof typeof Typeface];
