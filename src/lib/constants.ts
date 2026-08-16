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

/**
 * The kinds of qualifying engagement recorded in the per-day ledger (#233).
 *
 * ── This is NOT a subset of `RewardType`, and the difference is the point ────
 *
 * The two vocabularies overlap and neither contains the other, which is why the
 * ledger is its own table rather than a nullable column on `RewardEvent`:
 *
 *  * `Capture` writes NO `RewardEvent` at all — capturing earns a streak day and
 *    no points — so a reward row cannot represent it.
 *  * `inbox_zero`, `scheduled` and `session_finished` are rewards that are NOT
 *    engagements: none of them calls `touchStreakOnEngagement`, so counting them
 *    as engagement days would credit days the streak never advanced on.
 *  * `RewardEvent` rows are REVERSED (deleted) by an undo — `reopenItem`,
 *    `uncompleteStep` — while the engagement they record genuinely happened and
 *    does not un-happen. `rewards.ts` states that rule for the streak in as many
 *    words. Reusing the reward rows as the ledger would make every undo silently
 *    withdraw a streak day.
 *
 * Mirrors `EngagementDay.kind`, CHECK-constrained by
 * `20260815120000_engagement_day_ledger`; Prisma cannot express a CHECK, so the
 * constraint is registered in `src/lib/enum-constraint-sync.integration.test.ts`.
 */
export const EngagementKind = {
  /** A brain-dump capture that was actually written (`writeCapture`). */
  Capture: "capture",
  /** Confirming an AI breakdown into steps (`confirmBreakdown`). */
  BreakdownConfirmed: "breakdown_confirmed",
  /** Completing a single step, from the focus timer or directly. */
  StepDone: "step_done",
  /** Completing a whole to-do (`completeItem`). */
  TaskComplete: "task_complete",
} as const;
export type EngagementKind =
  (typeof EngagementKind)[keyof typeof EngagementKind];

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

// #118 Phase C: SINGLETON_ID is GONE. GoogleAuth is one row per User, keyed on
// `userId` (src/lib/google.ts) — there is no instance-wide credential left for a
// magic id to name. The scoping harness asserts every call names its user.

// #35 Phase A: OWNER_WORKSPACE_ID and the synchronous isGuestWorkspace() that
// compared against it are GONE. Workspaces belong to User records now, so
// "is this the owner?" is a role question (isOwnerRequest) and "is this a guest
// sandbox?" is a database question (src/lib/workspace-kind.ts). The scoping
// harness asserts the constant cannot come back.

export const WorkspaceKind = {
  // Legacy (#35 Phase A): the pre-accounts singleton workspace, id "owner".
  // Kept in the value set ONLY so the Workspace_kind_check constraint still
  // validates the row that already exists in production — `ALTER TABLE … ADD
  // CONSTRAINT` re-validates every existing row, so dropping "owner" here would
  // make the accounts migration fail on deploy. Nothing writes it any more; the
  // row is exported + purged by hand in Phase D, and this value goes with it.
  Owner: "owner",
  // A real signed-in account's workspace (1:1 with a User row).
  User: "user",
  Guest: "guest",
} as const;
export type WorkspaceKind = (typeof WorkspaceKind)[keyof typeof WorkspaceKind];

// ── #35 Phase A — accounts / per-user identity ─────────────────────────────
// User.role / User.status / User.aiPolicy and Allowlist.role are String columns
// guarded by Postgres CHECK constraints (User_role_check, User_status_check,
// User_aiPolicy_check, Allowlist_role_check). These objects are the single
// source of truth for the allowed sets; the CHECK migration + the
// enum-constraint-sync integration test mirror them.

/** `owner` manages people + policy; `member` is an ordinary invited account. */
export const UserRole = {
  Owner: "owner",
  Member: "member",
} as const;
export type UserRole = (typeof UserRole)[keyof typeof UserRole];

/**
 * #252 — longest `User.displayName` we will store.
 *
 * Not a guess at how long names get: it is the width the HEADER can absorb. The
 * label is `truncate`d at 64px on a phone and 160px above `sm`, so anything past
 * roughly 30 characters is already being clipped, and 60 is double that. The
 * bound exists so a paste accident cannot put a wall of text through a column
 * rendered on every page and interpolated into an `aria-label`.
 *
 * **Here rather than in `src/app/actions/account.ts`, and that is not a taste
 * call.** A `"use server"` module may only export async functions — Next refuses
 * the build outright with "the module has no exports at all" — so a bound shared
 * by the action that enforces it and the field that sets its `maxLength` from it
 * cannot live beside the action. One number either way, so the field stops
 * accepting characters at exactly the length the server accepts and a user cannot
 * reach a refusal by typing.
 *
 * No CHECK constraint mirrors this one: it is a display bound, not a data
 * invariant, and a longer name arriving from a hand-edited row renders truncated
 * rather than wrongly.
 */
export const MAX_DISPLAY_NAME_LENGTH = 60;

/** `revoked` freezes sign-in immediately; the data is purged later (Phase D). */
export const UserStatus = {
  Active: "active",
  Revoked: "revoked",
} as const;
export type UserStatus = (typeof UserStatus)[keyof typeof UserStatus];

/**
 * Who pays for this account's AI. `own_key` = they brought their own LLM key;
 * `capped` = instance key, metered against UserAiUsage; `uncapped` = instance
 * key, no meter. Enforcement lands in Phase B — Phase A only stores the value.
 */
export const AiPolicy = {
  Uncapped: "uncapped",
  Capped: "capped",
  OwnKey: "own_key",
} as const;
export type AiPolicy = (typeof AiPolicy)[keyof typeof AiPolicy];

/**
 * Which LLM adapter serves a request — `LLM_PROVIDER` for the instance, or a
 * user's `User.llmProvider` for an account that brought its own key (#35 Phase
 * B/C). Mirrored by the `User_llmProvider_check` constraint; NULL on a User
 * means "use the instance default".
 *
 * Lives here rather than in src/lib/llm/index.ts because constants.ts is the
 * single source of truth the CHECK-constraint sync test reads, and importing
 * llm/index.ts into a test would pull the provider SDKs in with it.
 */
export const LlmProvider = {
  Anthropic: "anthropic",
  OpenAICompatible: "openai-compatible",
} as const;
export type LlmProvider = (typeof LlmProvider)[keyof typeof LlmProvider];

// ── Phase 2 — breakdown model selection (anthropic provider) ────────────────
// Owner-selectable models for the `anthropic` LLM_PROVIDER (validated
// server-side). claude-fable-5 is shown in the UI but deliberately NOT
// allowlisted — it can never be selected/honored. Other providers
// (openai-compatible) use LLM_MODEL/LLM_OWNER_MODEL/LLM_GUEST_MODEL instead
// and have no fixed allowlist — see src/lib/models.ts.
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

// #180 — focus sound is a switch, not a track picker.
//
// It held eleven values until #180: "off" plus one per bundled #43 track, so the
// column answered "is there music" and "which track does the session open on" at
// once. Choosing what to hear is a decision you make while listening, so it moved
// to the in-session player, and nothing persists an opening track any more — a
// session opens on the head of the pass built from Settings.focusSoundCategories.
// The bundled track ids still exist as ids (BundledFocusTrack in
// src/lib/focus-sounds.ts); they are simply no longer a thing this column can
// hold, which is why the narrowing needed a paired Settings_focusSound_check
// migration converting stored track ids to "on".
//
// New accounts default to "on" (see the Prisma default), because a catalogue
// nobody can hear without first finding a settings page is a feature in hiding.
export const FocusSound = {
  Off: "off",
  On: "on",
} as const;
export type FocusSound = (typeof FocusSound)[keyof typeof FocusSound];

// #70 — the ten open-lofi categories, as a persistable value set.
//
// #180 — `Settings.focusSoundCategories` is a `text[]` holding zero or more of
// these, guarded by a CONTAINMENT check (Settings_focusSoundCategories_check),
// so this object is the single source of truth the constraint and
// enum-constraint-sync both mirror. An EMPTY array means the whole catalogue,
// which is what #70's NULL used to mean; collapsing "nothing narrowed" onto the
// empty array leaves exactly one way to express it, and exactly one way to get
// silence (FocusSound.Off).
//
// `FOCUS_SOUND_TRACKS` in src/lib/focus-sounds.ts reads its `category` values
// from here, which is what keeps the slug a picker offers, the slug a bundled
// track carries and the slug the DB will accept from ever being three different
// strings.
//
// These are open-lofi's OWN slugs, deliberately not paraphrases: #70's first
// version invented `ambient`, `asian` and `seasonal`, and the corrected list is
// what a future streamed manifest has to match for a category to group at all.
//
// A NEW category is not just a constant: it needs a paired
// Settings_focusSoundCategories_check migration, or enum-constraint-sync goes red.
export const FocusSoundCategory = {
  AmbientLofi: "ambient-lofi",
  Chillhop: "chillhop",
  Jazzhop: "jazzhop",
  SoulRnb: "soul-rnb",
  LateNight: "late-night",
  FunkSoul: "funk-soul",
  AsianLofi: "asian-lofi",
  SeasonalWeather: "seasonal-weather",
  Activities: "activities",
  Hybrid: "hybrid",
} as const;
export type FocusSoundCategory =
  (typeof FocusSoundCategory)[keyof typeof FocusSoundCategory];

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

/**
 * #225 — how long a brain-dump→Task write may spend, including time spent
 * WAITING for another caller's row lock.
 *
 * Explicit rather than Prisma's default, and the default is what makes it
 * necessary: at `timeout: 5000` a loser that waits longer than five seconds for
 * the lock is killed with `P2028 Transaction already closed` and rolled back
 * (measured, !306 substitute review — a lock held 6.5s produced exactly that).
 * That turns the no-op these guards promise into an error raised at somebody who
 * pressed a button twice, which is the sentence the guards are documented by.
 *
 * Deliberately LONGER than `inbox-view.tsx`'s `INBOX_ACTION_TIMEOUT_MS` (10s),
 * the point at which the client stops waiting and offers a Retry. A server
 * action cannot be aborted from the client, so the choice is between a write that
 * lands late and one that is thrown away — and landing late is strictly better
 * here, because every one of these writes is now idempotent: the late arrival
 * adopts whatever exists rather than duplicating it, and the notice's copy for a
 * timeout already says "this may already have gone through". Cutting the budget
 * to match the client would discard work for no benefit.
 *
 * `maxWait` is time to acquire a CONNECTION from the pool, which is a different
 * failure (the app is saturated) and stays short: waiting longer for a connection
 * only deepens the queue.
 */
export const TASK_WRITER_TX_BUDGET = {
  timeout: 15_000,
  maxWait: 5_000,
} as const;
