# Standalone /focus page (Focus launcher) — design + plan

**Date:** 2026-07-18 · **Branch/MR:** `feat/focus-page` → new MR · **Milestone:** v0.1.0 (part of the wireframe→product polish; owner-requested)
**Status:** approved design (owner chose "Focus launcher / step-picker"), pending build.

## Context
The ☰ nav already links **`/focus`** (`app-menu.tsx` DESTINATIONS: `{ key: "nav.focusTimer", href: "/focus" }`, string `nav.focusTimer` = "Focus Timer"), but no `/focus` route exists → it 404s. The focus timer is step-based (`/focus/[stepId]`). The P5 welcome card also wants to link "Focus" somewhere real. Build a standalone `/focus` **launcher** that lists focusable steps and routes to `/focus/[stepId]`.

## Design (owner: Focus launcher / step-picker)
New Server Component `src/app/(app)/focus/page.tsx` (`export const dynamic = "force-dynamic"`):
- **Data (workspace-scoped):** load this workspace's tasks with steps (mirror `inbox/page.tsx`'s query incl. `focusSessions: { where: { endedAt: null }, take: 1 }` for `resumable`). Derive **one focusable entry per in-progress task** = the task's **next incomplete step** (`steps.find(s => !s.done)`), for tasks that have ≥1 incomplete step. Fields: `{ stepId, stepText, subtaskEmoji, estMinutes, taskId, taskTitle, resumable }`. Order: **resumable (paused) first**, then by task recency.
- **Render:** a heading (`t("nav.focusTimer", voice)`), a short intro, then a list of focusable steps — each row: parent task title + step text (+ emoji, est), a **resumable "paused" badge** when `resumable`, and the whole row links to **`/focus/${stepId}`** (styled like the Library rows). Voice-aware.
- **Empty state** (no focusable steps — the new-user case): a friendly card — *"Nothing to focus yet. Capture something in your Inbox and break it into steps, then come back to focus."* with a link to `/inbox`. Voice-aware.
- No new data model, no migration, no new server action (read-only page reusing existing step data + the existing `/focus/[stepId]` timer).

## Strings (new, plain/playful, Plain emoji-free)
`focus.launcher.intro` ("Pick a step to focus on."), `focus.launcher.empty` (the empty-state copy above), `focus.paused` ("paused" badge — ⏸ is an allowed functional glyph). Reuse `nav.focusTimer` for the title, `progress.*`/existing step strings where possible.

## Files
- Create `src/app/(app)/focus/page.tsx` + a small client/presentational row component if needed (`src/components/focus/focus-launcher.tsx`) — keep the page a Server Component doing the query, delegate list rendering.
- Modify `src/lib/strings.ts` (new keys).
- Tests: `focus-launcher` (or page-level) — focusable derivation (next incomplete step per task; resumable-first order; excludes fully-done tasks), empty state, links to `/focus/[stepId]`, workspace scoping.

## Gates
tsc clean · lint 0 errors · vitest (exclude integration) green · `next build` compiles (the /focus route renders). Isolated worktree (own node_modules) — safe to `prisma generate` here.

## Plan (TDD, subagent or direct)
1. Strings + a pure `focusableSteps(tasks)` helper + unit tests (derivation + ordering + empty).
2. `focus-launcher.tsx` presentational list + row (links to `/focus/[stepId]`, paused badge) + RTL test.
3. `focus/page.tsx` Server Component: query + map + render launcher or empty state.
4. Gates + open MR (v0.1.0, @GitLabDuo reviewer).

## Downstream
- P5 welcome card "Focus" link (!84 welcome v2) → `/focus` once this ships.
- The ☰ `/focus` link starts working (no longer 404).
