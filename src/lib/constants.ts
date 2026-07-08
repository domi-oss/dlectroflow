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
} as const;
export type RewardType = (typeof RewardType)[keyof typeof RewardType];

export const RewardPoints: Record<RewardType, number> = {
  step_done: 10,
  session_finished: 5,
  inbox_zero: 15,
  breakdown_confirmed: 10,
  scheduled: 10,
};

export const SparkSource = {
  AI: "ai",
  Fallback: "fallback",
} as const;
export type SparkSource = (typeof SparkSource)[keyof typeof SparkSource];

export const BadgeKey = {
  FirstBreakdown: "first_breakdown",
  FirstSchedule: "first_schedule",
  Streak5: "streak_5",
  TenStepsDay: "ten_steps_day",
  BeatBestStreak: "beat_best_streak",
} as const;
export type BadgeKey = (typeof BadgeKey)[keyof typeof BadgeKey];

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
