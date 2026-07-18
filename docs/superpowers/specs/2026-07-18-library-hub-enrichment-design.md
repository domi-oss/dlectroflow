# Library hub enrichment — design

**Date:** 2026-07-18
**Branch / MR:** `feat/library-hub` / !83 (lands as new commits on the existing Phase 3 MR)
**Issue / milestone:** #8 (wireframe → product build) · v0.1.0
**Status:** approved (owner), pending spec review

## Context

Phase 3 (!83) shipped the Library "Everything" hub: four deep-linkable tabs
(Single-task / Multi-step / Saved for later / Done), with interactive rows on the
in-flight tabs (Single-task / Saved for later) reusing the Inbox's `RowActions` +
`CompleteButton` and the workspace-scoped braindump actions.

After reviewing the deployed review app, the owner wants the hub to feel as alive
and ADHD-supportive as the Inbox (which received far more polish). This spec covers
four workstreams plus one folded-in reviewer nit. It builds **only** on existing
patterns; the polished `inbox-view.tsx` is left untouched to avoid regressions.

## Goals

1. Rename the hub to a word that "clicks."
2. Make the **Multi-step** tab come alive: inline step expansion at Inbox parity.
3. Add **bulk edit** (Select mode) to the two to-do tabs.
4. Add curated **ADHD-enriching row meta** to collapsed rows.
5. Fold in GitLabDuo's !83 nit: de-duplicate the time formatters.

## Non-goals

- No changes to `inbox-view.tsx` behavior (only a mechanical import swap for the
  shared formatter, §5).
- No bulk **Schedule** (each item needs its own time — out of v1, owner decision).
- Minimal schema change only: one additive nullable column
  (`BrainDumpItem.estMinutes`) for the editable single-task estimate
  (display-default 5); no backfill, no other model changes.
- Sorted/Done "closure" semantics unchanged except the Multi-step tab gaining
  expansion (Done stays a static closure view).

## Design

### 1. Rename: "Everything" → "Library"

Single string change in [src/lib/strings.ts](../../../src/lib/strings.ts):

```
"nav.everything": { plain: "Library", playful: "🍱 Larder" }
```

Only the **plain** voice changes ("Everything" → "Library"). Playful "🍱 Larder"
stays. Drives the page `<h1>` and the nav item. Route stays `/library`. The key
name (`nav.everything`) is left as-is to avoid a rename churn across call sites;
its *value* is what changes.

### 2. Multi-step tab — inline expansion at Inbox parity

Today the Multi-step ("sorted") tab renders static `LibraryRow`s whose whole body
links to `/tasks/[id]`. Replace with an interactive client component modeled on the
Inbox's multi-step row (`inbox-view.tsx`, the `expandedId` pattern).

- **New component** `src/components/library/library-multistep.tsx` (`"use client"`).
  Renders the Multi-step bucket rows with:
  - **Single-open expansion** via a single `expandedId` state (opening one collapses
    the previous), exactly like the Inbox. Tapping the title line toggles; the
    control carries `aria-expanded` and is keyboard-operable.
  - **Default open = latest.** On mount, `expandedId` initializes to the most
    recently created row (bucket is already `createdAt desc`, so the first row).
  - **Expanded panel = full parity:** reuse the Inbox's inline step list
    (`TaskSteps` from `src/components/breakdown/task-steps.tsx`) — see steps +
    progress, tick steps done, **Start focusing** the next step (via existing
    `ensureFocusStep`) — plus an explicit **Open task** link to `/tasks/[id]`.
  - **Collapsed row** shows the meta from §4.
- The Library page wires the `sorted` tab to `<LibraryMultistep>` instead of the
  static list; **Done** keeps the existing static `LibraryRow`.

### 3. Bulk edit — "Select mode" (Single-task + Multi-step tabs)

Owner picked the **Select-mode** pattern (clean by default; explicit entry), which
also avoids fighting the §2 tap-to-expand gesture.

- **Entry:** a **Select** button in the tab header of the Single-task and Multi-step
  tabs. Tapping enters select-mode.
- **In select-mode:** each row shows a leading checkbox; header shows **Select all**
  + **Cancel**; a sticky bottom **action bar** shows **"N selected"** + the three
  actions. A row tap toggles its checkbox (expand/open/navigation suppressed while
  selecting). **Cancel**, or completing an action, exits select-mode.
- **Actions** (run over the selected id set):
  - **Complete** → `completeItem` per id (Multi-step → graduates to Done via the
    existing bucketing rules).
  - **Save for later** → `snoozeBrainDumpItem(id, 60)` per id (matches the Inbox's
    fixed 60-minute save-for-later default; factor to a shared constant). Moves them
    to Saved for later.
  - **Delete** → action bar swaps to a **"Delete N? · Confirm · Cancel"** step
    (mirrors the existing two-step row delete), then `deleteBrainDumpItem` per id.
- **New server action** `bulkBrainDumpAction(ids: string[], action: "complete" |
  "saveForLater" | "delete")` in [src/app/actions/braindump.ts](../../../src/app/actions/braindump.ts):
  - Workspace-scoped + IDOR-safe: filter ids to the current workspace before acting
    (same `currentWorkspaceId()` + `where: { workspaceId }` guard the per-item
    actions use).
  - Wraps the per-item logic in a single `prisma.$transaction` where practical;
    revalidates the Library + Inbox paths once at the end (not per item).
  - Returns a small result (counts) for the client to surface / recover from.
- **Selection state** lives in a client wrapper. Single-task rows already render via
  the `LibraryRows` client component; extend it (or a thin parent) to own select
  state. The Multi-step client component (§2) gains the same select-mode props.

### 4. ADHD-enriching collapsed-row meta

Design principle: **lower activation energy / bound overwhelm** — not maximize data.
All six approved, with the **time estimate positioned far-right on both row types**
(on Multi-step, the `done` pill sits inboard, estimate rightmost — consistent
eye-line). Plain voice stays clean; the emoji anchor is **playful-voice only**.

Multi-step collapsed row, left→right:
`#.` · emoji (playful) · **title** + `Next: <first undone step>` · progress bar ·
age (amber when aging) · `done/total` pill · `≈N min left` (rightmost)

Single-task collapsed row:
`#.` · **title** · age · `≈N min` **(editable, rightmost)**

| # | Element | Source | Notes |
|---|---------|--------|-------|
| A | Next-step preview | `steps.find(s => !s.done)?.text` | Multi-step only. |
| B | Time estimate | **Multi-step:** Σ `estMinutes` of undone steps (read-only; steps edited in breakdown). **Single-task:** `item.estMinutes ?? 5` — new nullable column, display-default 5, **editable inline** (number input mirroring the breakdown step editor; persists via `setItemEstimate`). | Rightmost on both. |
| C | Row number | list index + 1 | Tabular, subtle. |
| D | Progress bar | `stepsDone / stepsTotal` | Multi-step only; thin bar. |
| E | Staleness accent | `isAging(createdAt, agingSettings)` from `aging.ts` | Age text turns amber, reusing the Inbox rule + settings. |
| F | Emoji anchor | first undone `step.subtaskEmoji` (fallback first step) | **Playful voice only.** |
| — | ~~"Quick win" tag~~ | — | **Dropped** (owner-approved follow-on): the now-visible editable estimate conveys size directly; a tag on every 5-min default would just be noise. |

Meta rendering is pure/presentational (a `LibraryRowMeta` helper or inline
sub-components), unit-testable independent of the interactive shells.

### 5. Fold-in: GitLabDuo !83 nit — shared time formatter

`formatAgo` (byte-identical in `library-rows.tsx` and `inbox-view.tsx`) and
`formatWake` (library only) are extracted to **`src/lib/format.ts`** and imported in
both. Removes the drift risk Duo flagged. Behavior identical — pure move.

## Components & boundaries

- `src/lib/format.ts` — pure `formatAgo(ms)` / `formatWake(when)`. No deps.
- `src/components/library/library-row-meta.tsx` — pure presentational meta
  (next-step, estimate, number, bar, age, emoji) given an `Item` + index + voice +
  agingSettings. No state. (The editable single-task estimate input is a small
  client control that lives with the interactive rows, not here.)
- `src/components/library/library-multistep.tsx` — client; expansion + (select-mode)
  for the Multi-step tab; reuses `TaskSteps`.
- `src/components/library/library-rows.tsx` — existing; extended for select-mode on
  Single-task (and Saved-for-later keeps current behavior).
- `src/app/actions/braindump.ts` — add `bulkBrainDumpAction` and
  `setItemEstimate(id, minutes)` (both workspace-scoped + IDOR-safe).
- `prisma/schema.prisma` + migration `<date>_braindump_item_est_minutes` — add
  `estMinutes Int?` to `BrainDumpItem` (additive, nullable, no backfill).
- `src/components/inbox/bucket.ts` — add `estMinutes: number | null` to `Item`
  (and thread it through the `libraryBuckets` mapping in the page).
- `src/app/(app)/library/page.tsx` — wire Multi-step → new component; pass
  `agingSettings` + `now` for meta; select `estMinutes`; keep Done static.
- `src/lib/strings.ts` — rename value + new keys (below).

## New strings (plain + playful)

**Note:** `t(key, voice)` returns a **static** string — there is no `{n}`
interpolation. Dynamic numbers are composed in JSX around static unit strings
(e.g. `{n} {t("lib.selected", voice)}`, `≈{mins} {t("lib.minLeft", voice)}`),
matching how the codebase already composes labels.

`nav.everything` value change; plus static keys: `lib.select` ("Select"),
`lib.selectAll` ("Select all"), `action.cancel` (exists), `lib.selected`
("selected" — composed as "{n} selected"), `lib.openTask` ("Open task"),
`lib.deleteConfirm` ("Delete these?" — with the count composed in front),
`lib.next` ("Next:"), `lib.minLeft` ("min left" — composed as "≈{n} min left"),
`lib.min` ("min" — single-task, composed as "≈{n} min"), `lib.editEstimate`
("Edit estimate" — aria-label on the inline number input). Follow the existing
STRINGS formatting; keep a11y-adjacent strings clear in both voices.

## Testing

RTL/unit (jsdom) + pure unit, run under `vitest` (exclude integration):

- **Meta (pure):** next-step picks first undone step; Multi-step estimate sums undone
  step minutes; single-task estimate falls back to 5 when `estMinutes` is null and
  shows the stored value otherwise; numbering; aging accent toggles via `isAging`;
  emoji only in playful; single-task vs multi-step layouts (estimate rightmost).
- **Single-task estimate edit:** inline input persists via `setItemEstimate`;
  `setItemEstimate` is workspace-scoped (rejects other-workspace ids) and clamps to a
  sane positive integer.
- **Multi-step expand:** latest open by default; single-open toggle (opening B
  collapses A); step actions inside (tick done, Start focusing calls
  `ensureFocusStep`); Open task link href; `aria-expanded` correctness.
- **Bulk edit:** enter/exit select-mode; Select all; each action calls
  `bulkBrainDumpAction` with the right ids + type; delete confirm + cancel; row tap
  toggles selection (does not expand) while selecting.
- **Server action:** `bulkBrainDumpAction` is workspace-scoped (ids from another
  workspace are filtered out); each action type produces the right state change;
  single revalidate.
- **Rename:** `nav.everything` resolves to "Library" (plain) / "🍱 Larder"
  (playful).
- **Formatter:** `format.ts` unit tests; both call sites import it (no local dupes).

## Gates (before push)

`npx tsc --noEmit` clean · `npm run lint` 0 errors · `npx vitest run --exclude
'**/*.integration.test.ts'` all green. Then push to `feat/library-hub` (!83).
Do **not** merge — owner sign-off + GitLabDuo re-review first.

## Risks / call-outs

- **Row density:** six meta elements is a lot. Plain stays clean (no emoji); if it
  reads busy in the real app, dropping D/E is a one-line change. Flagged, accepted.
- **Select-mode vs expand:** both live on the Multi-step tab; select-mode suppresses
  expansion to avoid gesture conflict (explicitly tested).
- **MR size:** !83 grows notably. Acceptable — it's all Phase 3, keeps #8 tidy
  (owner decision).
