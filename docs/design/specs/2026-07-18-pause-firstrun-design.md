# Phase 5 — Delete confirms · Pause-for-now · First-run/empty · Demo toggle — design

**Date:** 2026-07-18
**Branch / MR:** `feat/pause-firstrun` → new MR (Phase 5 of #8), milestone v0.1.0
**Status:** approved (owner), pending spec review
**Source of truth:** `docs/wireframe/dlectroflow-wireframe.html` (Focus / Inbox first-run / Settings Demo) + `docs/wireframe/IMPLEMENTATION-HANDOFF.md` (L80–81).

## Context

Phase 5 of the wireframe→product build. Four small, mostly-independent slices. Owner scope note (2026-07-18): **light** pause-for-now now; true persisted pause (elapsed-time resume) is deferred to **#27**. Built on latest `main` (post-#29 scheduling + release groundwork).

## Goals / decisions (owner-confirmed)

1. **Inline delete confirms** — extend the existing two-step confirm to any remaining one-tap destructive deletes.
2. **Pause-for-now (light)** — a first-class low-shame exit from the Focus timer that keeps the step and surfaces an Inbox **resume banner**; reuses the existing *unfinished-session → `resumable`* heuristic (no persisted elapsed time).
3. **First-run welcome + empty states** — a **dismissible** welcome card (persisted `welcomeDismissedAt`) offering the Plain/Playful choice, a **decent "what to do" description**, and a **link to /help**; plus voice-aware empty states.
4. **Demo toggle** — Settings "Demo: First-run preview": a persisted, auto-saved per-workspace flag (`firstRunPreview`) that **forces** the welcome + empty Inbox view (visually hides real items, non-destructive) to demo the new-user experience.

## Non-goals

- True persisted pause/resume with saved elapsed time → **#27**.
- Forcing the empty view across Dashboard/Library — `firstRunPreview` is **Inbox-scoped** for v1 (the screen the wireframe's first-run lives on). Flag for later if broader demo emptying is wanted.
- No new scheduling/notification behavior (that's P6/#29).

## Design

### 1. Inline delete confirms
The two-step confirm (first tap reveals "Delete · Cancel", only the second deletes) already exists in inbox + library rows (`confirmDeleteId` pattern). Audit remaining **one-tap** deletes and convert them:
- Enumerate in the plan via `grep` for delete affordances that call a delete action directly on first click (candidates: the task/breakdown editor step delete, focus/step deletes, any settings/integration disconnect). Convert each to the shared two-step pattern (or a shared confirm helper). Purely additive UX safety — no data-model change.

### 2. Pause-for-now (light)
- Add a **`⏸️ Pause for now`** control on the Focus timer (`focus-timer.tsx`), visually distinct from the existing countdown ⏸️ Pause (`focus.pause`). New voice string `focus.pauseForNow` (plain/playful per HANDOFF: both "⏸️ Pause for now").
- On click: **leave focus without completing the step** — the step stays in its task and remains **resumable** via the existing unfinished-`FocusSession` heuristic (see `task-steps.tsx` `resumable` + `focus.ts`). No elapsed-time persistence (that's #27). Navigate to the **Inbox**.
- **Inbox resume banner:** the Inbox surfaces any workspace step with an open (unfinished) focus session as a low-shame banner: *"⏸ Focus step '<step text>' paused — resume →"* (voice-aware). Tapping **resume →** navigates to `/focus/<stepId>` (running). If several are paused, show the most recent (single banner; keep it simple).
  - Data: the Inbox page reads the workspace's open `FocusSession`(s) (endedAt null) → the associated step text + id. Workspace-scoped.
- Lands the user in a calm place (Inbox), never a failure state; streak untouched.

### 3. First-run welcome + empty states
- **Welcome card** (new `src/components/inbox/welcome-card.tsx`, client): green box, **"👋 Welcome to dlectroflow"** (👋 in both voices per wireframe), a **description of what to do** (capture-first: e.g. "Jot anything on your mind in the box above. Break big things into steps, focus one at a time, and tick them off — everything you capture lives in your Library."), the **Plain/Playful voice toggle** (reuse the existing `updateVoice` action / voice control), a **"How it works →" link to `/help`**, and a **Dismiss** ("Got it") that calls a new `dismissWelcome` action setting `welcomeDismissedAt`.
- **Visibility:** render the welcome card when `firstRunPreview === true` **OR** `welcomeDismissedAt == null`. Dismiss persists so it never returns naturally; the Demo toggle can still force it.
- **Empty states:** per-bucket `EmptyBucket` already exists in the inbox; ensure the top-level "Nothing here yet." capture-first empty is present + voice-aware. Confirm Library/Done empty copy reads cleanly (already `bucket.empty`). New/adjusted string keys as needed (plain/playful).

### 4. Demo toggle (First-run preview)
- **Settings** (`settings-panel.tsx`): a "Demo" section with a **"First-run preview"** toggle + description ("For demos — show the app as a brand-new user sees it: welcome card + empty Inbox."). **Auto-saves on change** (per the P6-established auto-save direction; matches voice/model pickers) via `updateSettings` extended with `firstRunPreview`.
- **Effect:** when `firstRunPreview === true`, the **Inbox** renders the welcome card + **empty buckets** — real items are visually suppressed (not deleted). Implement as a page-level presentation override: if `firstRunPreview`, pass empty bucket lists to `InboxView` (and force the welcome card). Flip off → normal.

## Data model (additive migration, one)

`Settings` gets two nullable/defaulted columns (no backfill):
- `welcomeDismissedAt DateTime?`
- `firstRunPreview Boolean @default(false)`

Threaded into `getSettings` reads + the settings action allow-list. (No DB reachable in the worktree → hand-author the migration SQL + `prisma generate`, per the !83 P2 pattern.)

## Components & boundaries
- `src/components/inbox/welcome-card.tsx` — new client card (voice choice + description + /help link + dismiss).
- `src/app/actions/braindump.ts` (or `settings.ts`) — `dismissWelcome()` action (workspace-scoped) setting `welcomeDismissedAt`.
- `src/app/actions/settings.ts` — extend the settings update allow-list with `firstRunPreview` (+ auto-save wiring).
- `src/components/focus/focus-timer.tsx` — add `⏸️ Pause for now` control + navigation.
- `src/components/inbox/inbox-view.tsx` + `src/app/(app)/inbox/page.tsx` — resume banner (from open FocusSessions), welcome-card render gating, `firstRunPreview` empty override.
- `src/components/settings/settings-panel.tsx` — Demo section toggle (auto-save).
- Delete-confirm coverage — files identified in the plan.
- `src/lib/strings.ts` — new keys (welcome title/body/dismiss, `focus.pauseForNow`, resume banner, demo labels) plain+playful.
- `prisma/schema.prisma` + migration.

## Testing
Unit/RTL (jsdom), workspace-scoped, run under `vitest` (exclude integration):
- Welcome card: renders when not dismissed / hidden after `welcomeDismissedAt` set; Dismiss calls `dismissWelcome`; /help link href; voice toggle present; shown when `firstRunPreview` even if dismissed.
- Demo toggle: `firstRunPreview` on → Inbox shows welcome + empty buckets (real items suppressed); off → items shown; setting auto-saves.
- Pause-for-now: control ends focus without completing the step; step remains resumable; Inbox resume banner appears for an open session + "resume →" targets `/focus/<stepId>`; no confetti/streak change.
- Delete confirms: each converted affordance requires the second confirming tap.
- Migration additive; `getSettings` returns the new fields.

## Gates
`tsc --noEmit` clean · `lint` 0 errors · `vitest` (exclude integration) green · `next build` compiles. Additive migration named + `prisma generate`. Workspace-scoping preserved. New MR ties to #8 Phase 5 + v0.1.0; @GitLabDuo reviewer.

## Risks / call-outs
- **`firstRunPreview` data suppression** is a presentation override — ensure it never mutates/deletes real data (tests assert data returns when toggled off).
- **Resume banner source** relies on open `FocusSession` rows; confirm that model + the `resumable` heuristic in `focus.ts`/`task-steps.tsx` during planning (exact field names).
- Delete-confirm audit scope is discovered at plan time — keep it to genuine one-tap destructive actions (don't double-confirm already-guarded ones).
