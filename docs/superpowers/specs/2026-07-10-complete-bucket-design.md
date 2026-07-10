# Complete button + unified Completed bucket — Design

> Status: approved (2026-07-10). Feature branch `feat/complete-bucket` (off `fast-follows-phase2`, which carries MR !27). Milestone v0.0.2, relates to work item #8.

## Goal

Let the user mark work as **done** directly from the inbox and the task page, and surface finished work in a **Completed** bucket. Every finished thing — a needs-review item, a single-task to-do, or a whole multi-step task — flows into one Completed list on the inbox (with a "Completed today" counter) and, later (Phase 3), into the Everything **Done** view. Completion feeds the existing gamification (points + badge + streak). Steps can be finished without the focus timer.

## Non-goals / scope boundary

- The Everything (`/library`) **Done** view stays a **stub** in this MR — the `see all →` link points at `/library?tab=done` (already 404-safe). The real Done view is Phase 3.
- No changes to the focus-timer flow itself beyond framing its `SessionFinished` (+5) as the timer's distinguishing bonus.

## Core model — one source of truth

Add a single nullable timestamp:

- **`BrainDumpItem.completedAt DateTime?`** — set when the item (or its task) is finished; the sole signal for "this is in the Completed bucket". Sorting and the "today" counter both read it.

Rationale: a status enum would create two sources of truth (`BrainDumpStatus` vs `Task.status`) with no timestamp to order or count by; a separate `CompletionEvent` table is YAGNI. `Task.status = "done"` is still set for multi-step tasks (existing consumers rely on it), but `completedAt` on the linked item is what the inbox reads.

Additive migration (Postgres + SQLite), matching the existing raw-SQL style:

```sql
ALTER TABLE "BrainDumpItem" ADD COLUMN "completedAt" TIMESTAMP;
```

## Rewards / constants

- **`RewardType.TaskComplete = "task_complete"`**, `RewardPoints.task_complete = 15`.
- **`BadgeKey.TaskComplete = "task_complete"`** — the `badge.task_complete` string already exists in `strings.ts` but the badge was never in the `BadgeKey` enum and is never awarded today. This wires it up (awarded once, on first-ever completion).
- `strings.test.ts` iterates `Object.values(BadgeKey)` asserting each has a string — adding `TaskComplete` is satisfied by the existing `badge.task_complete` entry.

## Actions (`src/app/actions/braindump.ts`, `src/app/actions/focus.ts`)

All workspace-scoped (resolve `currentWorkspaceId()`, gate on `{ id, workspaceId }`), idempotent on the `completedAt` null→set transition, and `revalidatePath` the affected routes (`/inbox`, `/dashboard`, and `/tasks/[taskId]` when a task is involved).

### `completeItem(id: string)`
Used by the **Complete** button on needs-review, single-task, and multi-step rows.

- If already completed (`completedAt != null`) → no-op.
- Stamp `completedAt = now`.
- If the item has a `taskId`:
  - set `task.status = "done"`;
  - mark **all** its steps `done = true`;
  - for each step that was **not** already done, award `RewardType.StepDone` (credits the steps, so the row-level Complete earns the same as finishing them one-by-one — the focus-timer's `SessionFinished` +5 remains the only extra).
- Award `RewardType.TaskComplete` (15) once.
- `touchStreakOnCompletion(workspaceId)`.
- Award `BadgeKey.TaskComplete` (first-ever) and re-check `TenStepsDay` (step-done count today may have crossed 10).

### `completeStep(stepId: string)`
Used by the new **✓ Complete** button beside **▶ Focus** on the task page — finish a step without the focus timer.

- Guard step ownership (`step.task.workspaceId === workspaceId`). If already `done` → no-op.
- `step.done = true`; sync Reclaim/Google via the existing `completeGoogleTaskForStep(step)`.
- Award `RewardType.StepDone` (10) + `touchStreakOnCompletion` + re-check `TenStepsDay`. **Not** `SessionFinished` — that stays the focus session's bonus.
- If this was the **last** incomplete step → set `task.status = "done"`, stamp `completedAt` on the linked item(s), award `RewardType.TaskComplete` (15) once + `BadgeKey.TaskComplete`.

> `completeStep` shares reward logic with `completeFocus`; extract a small helper (e.g. `rewardStepDone(workspaceId)`) so the two stay in sync without duplicating the streak/badge/day-count code.

### `reopenItem(id: string, stepIds?: string[])`
Used by the **Undo** control on a Completed row.

- Clear `completedAt`.
- No task (needs-review / single-task) → done; the item returns to its prior bucket. `stepIds` ignored.
- Has a task (multi-step):
  - set `task.status = "active"`;
  - reset the chosen steps to `done = false`. `stepIds` empty/omitted ⇒ **whole task** (reset all steps).
  - **Guard:** the reopen must leave **≥1** step not-done (else the task still reads as fully-done via `isFullyDone` and won't return to To-do). Rule: if the requested reset (or empty `stepIds`) would leave every step done, additionally reset the **last** step, so re-entry into To-do is always guaranteed. (Empty/omitted `stepIds` resets all steps anyway, so this only bites a caller-supplied subset that happens to cover nothing.)
- Reopening does **not** claw back already-awarded points (keep it forgiving; rewards are append-only events).

## Bucketing (`src/components/inbox/bucket.ts`)

- Add `completedAt: Date | null` to the `Item` type.
- New `completed: Item[]` — items with `completedAt != null`, sorted `completedAt` desc, **capped to 10**.
- New `completedTodayCount: number` — count of items whose `completedAt >= startOfToday(now)` (compute local midnight from the passed `now`; the module stays pure).
- Exclude completed items from `needsReview`, `singleTask`, `multiStep`, and `savedLater` (add `completedAt == null` to their filters). `isFullyDone` stays as a defensive secondary signal.

## Inbox page query (`src/app/(app)/inbox/page.tsx`)

- Map `completedAt` into the `Item` props (alongside the existing `freshenedAt`/`promptDismissedAt`/step scalars).
- Multi-step Completed rows need their steps for the reopen picker → include `task.steps { id, order, text, done }` (already partly included for step counts) mapped to the item, or a compact `steps: {id,text,done,order}[]`.

## Inbox UI (`src/components/inbox/inbox-view.tsx`)

- **Complete** button (`action.complete`) on every active row: needs-review `ItemRow`, single-task rows, multi-step rows. Wire to `run(() => completeItem(id))`.
- New **Completed** `<section>`:
  - header: `section.completed` label + chip **"Completed today (N)"** (`section.completedToday`) using `completedTodayCount`;
  - up to 10 rows (text + relative completion time), each with an **Undo** control (`action.reopen`);
  - multi-step rows: **Undo** expands an inline **step picker** (checkboxes per step + "Reopen whole task" + "Reopen selected"), following the existing inline-confirm pattern (like delete-confirm). Single-task/needs-review rows: **Undo** reopens immediately.
  - `see all →` (`link.seeAll`) → `/library?tab=done`.

## Task page (`src/app/(app)/tasks/[taskId]/page.tsx`)

- Each **incomplete** step row currently shows **▶ Focus** (link) / **✓** (when done). Add a **✓ Complete** button beside **▶ Focus** for incomplete steps → `completeStep(step.id)`.
- The page is a server component; add a small **client** component (e.g. `CompleteStepButton`) that calls the server action, so the rest of the page stays server-rendered.

## Voice strings (`src/lib/strings.ts`, Plain 100% emoji-free)

| key | plain | playful (illustrative) |
|---|---|---|
| `action.complete` | Complete | ✅ Complete |
| `action.reopen` | Reopen | Reopen |
| `section.completed` | Completed | 🍽️ Cleared plate |
| `section.completedToday` | Completed today | Cleared today |

(Final playful wording confirmed against `docs/wireframe` vocabulary during implementation; Plain values are fixed above.)

## Testing (TDD — vitest, tsc, build all green before MR)

- **bucket.test.ts** — `completed` bucket membership + `completedAt`-desc order + 10-cap; `completedTodayCount` (today vs earlier); completed items excluded from every active bucket.
- **braindump / actions tests** — `completeItem` (workspace scoping, idempotency, stamps `completedAt`, sets task done + steps done, credits StepDone per not-done step + TaskComplete, badge, streak); `reopenItem` (clears `completedAt`, whole-task vs `stepIds` subset, ≥1-not-done guard, task reactivates); `completeStep` (scoping, StepDone but no SessionFinished, last-step ⇒ task done + item stamped + TaskComplete).
- **rewards / constants** — `TaskComplete` reward + `task_complete` badge award-once.
- **strings.test.ts** — new keys render (plain + playful) and Plain is emoji-free.
- **inbox-view.test.tsx** — Complete button on active rows calls `completeItem`; Completed section renders with today chip; Undo on a single-task reopens; Undo on a multi-step shows the step picker and `reopenItem` is called with the selected `stepIds`.
- **task page** — `CompleteStepButton` calls `completeStep`.

## Files touched

| File | Action |
|---|---|
| `prisma/schema.prisma` + new migration | add `completedAt` |
| `src/lib/constants.ts` | `RewardType.TaskComplete`, `RewardPoints`, `BadgeKey.TaskComplete` |
| `src/lib/rewards.ts` | extract `rewardStepDone` helper; nothing else structural |
| `src/app/actions/braindump.ts` | `completeItem`, `reopenItem` |
| `src/app/actions/focus.ts` | `completeStep` (+ shared reward helper) |
| `src/components/inbox/bucket.ts` (+ test) | `completed` bucket, `completedTodayCount`, exclusions |
| `src/app/(app)/inbox/page.tsx` | map `completedAt` + steps for picker |
| `src/components/inbox/inbox-view.tsx` (+ test) | Complete buttons, Completed section, Undo picker |
| `src/components/inbox/complete-step-button.tsx` (client) or under `tasks/` | new (+ test) |
| `src/app/(app)/tasks/[taskId]/page.tsx` | wire ✓ Complete per step |
| `src/lib/strings.ts` (+ test) | new keys |

## Open dependency

Built on `fast-follows-phase2` (MR !27). Should merge **after** !27 lands on main; if !27 changes during review, rebase this branch onto the updated base.
