# Complete + Completed bucket + inbox bucket board (drag-to-move) — Design

> Status: **APPROVED (2026-07-10).** Decisions locked: drag=@dnd-kit/core; two MRs (A completion core, then B bucket board); multi-step→review keeps the task (un-triage only); completed-drag auto-reopens then applies; TaskComplete=25 pts; Completed bucket = 10 most-recent + see-all→Done stub. Feature branch `feat/complete-bucket`; rebase onto current main (!27/!28/!29 merged) before building. Milestone v0.0.2, relates to work item #8. Next: writing-plans (Phase A).

## Goal

Turn the inbox into a **bucket board** the user can move items around directly:

1. Mark work as **done** from the inbox and the task page; finished things collect in a **Completed** bucket (with a "Completed today" counter) and, later (Phase 3), the Everything **Done** view. Completion feeds gamification (points + badge + streak); steps can be finished without the focus timer.
2. The **To-Do area shows four buckets at all times** — Multi-step to-dos, Single-task to-dos, Saved for later, Completed — each with a "nothing here yet" empty state, so the structure is always legible.
3. Items can be **dragged between buckets** (including back to **Needs review**); **the drop performs that bucket's action** (triage, save-for-later, complete, send-to-review…), not just a visual move.
4. **Multi-step rows** show a step-count indicator ("10 steps · 0 done"); tapping a row expands its step list inline, from which the focus timer can be started.

### Suggested build sequence (phased MRs under this one spec)

- **Phase A — Completion core:** schema `completedAt`, rewards/badge, `completeItem`/`completeStep`/`reopenItem`, the Completed bucket + "Completed today", Complete buttons, task-page ✓ Complete. (Everything in the original spec below.)
- **Phase B — Bucket board:** always-visible buckets + empty states, drag-to-move with action-on-drop, the multi-step drop prompt, multi-step inline expand + focus, `moveToReview`.

Phase A is independently shippable; Phase B builds on it. **Decided: two MRs (A then B).**

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

- **`RewardType.TaskComplete = "task_complete"`**, `RewardPoints.task_complete = 25`.
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
- Award `RewardType.TaskComplete` (25) once.
- `touchStreakOnCompletion(workspaceId)`.
- Award `BadgeKey.TaskComplete` (first-ever) and re-check `TenStepsDay` (step-done count today may have crossed 10).

### `completeStep(stepId: string)`
Used by the new **✓ Complete** button beside **▶ Focus** on the task page — finish a step without the focus timer.

- Guard step ownership (`step.task.workspaceId === workspaceId`). If already `done` → no-op.
- `step.done = true`; sync Reclaim/Google via the existing `completeGoogleTaskForStep(step)`.
- Award `RewardType.StepDone` (10) + `touchStreakOnCompletion` + re-check `TenStepsDay`. **Not** `SessionFinished` — that stays the focus session's bonus.
- If this was the **last** incomplete step → set `task.status = "done"`, stamp `completedAt` on the linked item(s), award `RewardType.TaskComplete` (25) once + `BadgeKey.TaskComplete`.

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

---

# Phase B — Inbox bucket board (drag-to-move)

## Always-visible buckets + empty states

The inbox renders, in order: **Needs review** (unchanged), then a **To-Do board** with four always-present buckets — **Multi-step to-dos**, **Single-task to-dos**, **Saved for later**, **Completed** — each rendering a muted "nothing here yet" helper (`bucket.empty`) when its list is empty (instead of the current "hide when empty" behavior). Completed still caps at 10 with `see all →`. `bucketItems` already returns all four arrays + `completedTodayCount`; only the rendering changes (always show, empty state).

## Drag-to-move with action-on-drop

Each bucket (including **Needs review**) is a **drop zone**. Dropping item *X* onto bucket *B* runs *B*'s action on *X*, regardless of where *X* came from — the destination defines the outcome:

| Drop target | Action on the item | Server action |
|---|---|---|
| **Needs review** | Un-triage back to the inbox review queue | `moveToReview(id)` (new) |
| **Single-task to-dos** | Triage as a plain to-do (no steps) | `triageBrainDumpItem(id)` (exists) |
| **Multi-step to-dos** | **Prompt** (see below) — needs a breakdown first | `startBreakdown(id)` or `snoozeBrainDumpItem` |
| **Saved for later** | Snooze into the future | `snoozeBrainDumpItem(id, mins)` (exists) |
| **Completed** | Complete it | `completeItem(id)` (Phase A) |

- If dropping where the item already lives (same bucket), it's a no-op (Phase B does not reorder within a bucket).
- Dropping a **Completed** item elsewhere first **reopens** it (`reopenItem`) then applies the target action; dragging a completed multi-step is allowed but uses the whole-task reopen (no per-step picker mid-drag).

### `moveToReview(id)` (new action, workspace-scoped)
**Decision: keep the task, just un-triage.** Sets `status = "inbox"`, clears `triagedAt`, `snoozedUntil`, `completedAt`. **Leaves `taskId` and the task's steps intact** — the item returns to the review queue but stays linked to its existing breakdown, so re-triaging later reuses the same task/steps (`startBreakdown` returns the existing `taskId`). Revalidate `/inbox`.

- Edge case to handle in the view: a step-bearing item that's back in review and then dropped onto **Single-task** is still `triageBrainDumpItem`'d, but because it has steps it renders in the **Multi-step** bucket (bucket placement follows `stepsTotal`, not the drop target). That's acceptable — the drop triages it; the board reflects reality. (We don't strip steps on a single-task drop.)

## Multi-step drop prompt

Dropping onto **Multi-step to-dos** can't silently create steps, so it asks:

- **Break into steps now** → `startBreakdown(id)` then navigate to `/tasks/[taskId]` (the editor).
- **Save for later** → `snoozeBrainDumpItem(id, …)` (lands in Saved for later instead).

Rendered as a small inline prompt / popover anchored to the drop (reusing the confirm-style pattern), dismissible with Escape (no-op on cancel).

## Multi-step rows: step count + inline expand + focus

- Each multi-step row shows **`N steps · M done`** (`progress.stepCount`) from `stepsTotal`/`stepsDone` (already on `Item`).
- **Tapping the row toggles an inline step list** (reusing/adapting the `TaskSteps` client component from MR !28): each step shows **▶ Focus** (→ `/focus/[stepId]`), the direct **✓ Complete** (Phase A `completeStep`), and **↗ Send to review** (!28). This means the inbox page query must `include` each multi-step item's `steps { id, order, text, done, estMinutes }` (extends the Phase-A include already needed for the reopen picker).
- The row is both a **drag source** and a **tap-to-expand** target; the drag handle (grip) initiates drag so a tap on the row body expands without triggering a drag.

## Drag mechanism — DECIDED: `@dnd-kit/core`

Add **`@dnd-kit/core`** (MIT, maintained) for pointer + touch + keyboard drag sensors — the inbox is a primary mobile surface and ADHD users need low-friction touch, which native HTML5 DnD can't do. Buckets are `useDroppable` zones; item cards are `useDraggable`. On the multi-step row, the drag activator is the grip handle only (so a tap on the row body expands the step list instead of starting a drag).

**Still required for a11y:** a per-item **"Move to…" menu** (keyboard + screen-reader + non-pointer fallback) that invokes the exact same drop-action dispatch. Drag and the menu share one `moveItemToBucket(itemId, targetBucket)` dispatcher so they can't diverge.

## Guest / permission notes

All drop actions map to existing workspace-scoped mutations, so guests are already constrained the same way as the buttons. `completeItem`/`moveToReview` reuse the same scoping.

## Voice strings (`src/lib/strings.ts`, Plain 100% emoji-free)

| key | plain | playful (illustrative) |
|---|---|---|
| `action.complete` | Complete | ✅ Complete |
| `action.reopen` | Reopen | Reopen |
| `section.completed` | Completed | 🍽️ Cleared plate |
| `section.completedToday` | Completed today | Cleared today |
| `bucket.empty` (Phase B) | Nothing here yet | Nothing here yet |
| `progress.stepCount` (Phase B) | *(templated, e.g. "3 of 10 done" — built from numbers, not a fixed string)* | — |
| `action.moveTo` (Phase B) | Move to… | Move to… |
| `prompt.breakNow` (Phase B) | Break into steps now | 🍿 Snack-size it now |
| `prompt.saveInstead` (Phase B) | Save for later | 🥫 Save for later |

(Final playful wording confirmed against `docs/wireframe` vocabulary during implementation; Plain values are fixed above.)

## Testing (TDD — vitest, tsc, build all green before MR)

- **bucket.test.ts** — `completed` bucket membership + `completedAt`-desc order + 10-cap; `completedTodayCount` (today vs earlier); completed items excluded from every active bucket.
- **braindump / actions tests** — `completeItem` (workspace scoping, idempotency, stamps `completedAt`, sets task done + steps done, credits StepDone per not-done step + TaskComplete, badge, streak); `reopenItem` (clears `completedAt`, whole-task vs `stepIds` subset, ≥1-not-done guard, task reactivates); `completeStep` (scoping, StepDone but no SessionFinished, last-step ⇒ task done + item stamped + TaskComplete).
- **rewards / constants** — `TaskComplete` reward + `task_complete` badge award-once.
- **strings.test.ts** — new keys render (plain + playful) and Plain is emoji-free.
- **inbox-view.test.tsx** — Complete button on active rows calls `completeItem`; Completed section renders with today chip; Undo on a single-task reopens; Undo on a multi-step shows the step picker and `reopenItem` is called with the selected `stepIds`.
- **task page** — `CompleteStepButton` calls `completeStep`.

### Phase B tests
- **`moveToReview`** — un-triages (status inbox, clears triagedAt/snoozedUntil/completedAt), detaches + archives a linked task, workspace-scoped, revalidates.
- **drop-action dispatch** (pure mapping unit) — bucket id → action name, so the wiring can't silently invert (mirrors the !28 More/Fewer regression lesson).
- **bucket board render** — all four buckets show even when empty (`bucket.empty` visible); multi-step row shows `progress.stepCount`; tapping expands the step list.
- **multi-step drop prompt** — choosing "Break into steps now" calls `startBreakdown`; "Save for later" calls `snoozeBrainDumpItem`.
- **"Move to…" menu** (a11y fallback) — selecting a target invokes the same action as dropping there.

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
| **Phase B** — `src/app/actions/braindump.ts` | `moveToReview` |
| **Phase B** — `src/components/inbox/inbox-view.tsx` (+ test) | always-visible buckets + empty states, drag sources/drop zones, "Move to…" menu, multi-step drop prompt, inline multi-step expand |
| **Phase B** — `src/components/inbox/task-steps.tsx` (from !28) | reuse for inline step list on multi-step rows |
| **Phase B** — `src/app/(app)/inbox/page.tsx` | `include` steps for multi-step rows (inline list) |
| **Phase B** — drag lib (if Option 1) | add `@dnd-kit/core` |

## Open dependency & sequencing

- **!27, !28, !29 are all merged to main + live in prod.** This branch (`feat/complete-bucket`, based on the pre-!28 state) must be **rebased onto current `main`** before Phase A work — it will pick up !28's `TaskSteps` client component, which Phase A's task-page ✓ Complete slots into (Complete beside the existing Focus / Send-to-review) and Phase B reuses for the inline multi-step list.
- **All prior decisions resolved:** drag = `@dnd-kit/core`; phasing = two MRs (A then B); multi-step→review keeps the task (un-triage only); completed-drag auto-reopens then applies.
