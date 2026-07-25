# /focus launcher + timer redesign — design + plan

**Date:** 2026-07-19 · **Branch/MR:** `feat/focus-page` → !86 · **Milestone:** v0.2.0
**Status:** approved design (owner, via visual-companion brainstorm 2026-07-19), pending build.
**Supersedes/extends:** `2026-07-18-focus-page-design.md` (the v0.1.0 launcher core, already built on this branch). This is the v0.2.0 "richer, more meta, single/multi-aware" redesign of **both** the launcher and the timer, plus new timer + appearance settings.

## Context

- The v0.1.0 launcher (`src/app/(app)/focus/page.tsx`, `src/lib/focus-launcher.ts`, `src/components/focus/focus-launcher.tsx`) lists one row per in-progress **multi-step** task (its next incomplete step), resumable-first. It does **not** show single-task to-dos, has no meta/dashboard context, and no resume hero.
- The timer (`src/app/(app)/focus/[stepId]/page.tsx`, `src/components/focus/focus-timer.tsx`) is a phase machine (setup → running/paused → timeup → reestimate → done/requeued/gaveup) with a countdown ring, add-time, AI re-estimate, low-shame "pause for now", and a celebration.
- **Single vs multi is already first-class** in the app: the Inbox/Library split `singleTask` (plated) from `multiStep` (sorted) via `libraryBuckets` (`src/components/inbox/bucket.ts`). Section labels come from `strings.ts` (`section.singleTask`="Single-task to-dos"/"😋 Quick bites", `section.multiStep`="Multi-step to-dos"/"✅ Sorted"), each header rendered by the Inbox `SubHeader` with a `link.seeAll` ("see all →") deep-link (`/library?tab=plated` / `?tab=sorted`).
- Single-task focus already works headlessly: `ensureFocusStep(itemId)` (`src/app/actions/braindump.ts:194`) lazily creates a one-step task and returns a `stepId` → `/focus/[stepId]`.
- Dashboard is the "meta" surface: `getDashboardData(workspaceId)` (`src/lib/rewards.ts:230`) returns `{ currentStreak, focusMinToday, stepsDoneToday, … }`.
- Reward/marker + `completeStep` (`src/app/actions/focus.ts:75`), `completeItem` (`braindump.ts:231`), `completeFocus`/`beginFocus`/`requeueFocus`/`proposeNewEstimate` (`focus.ts`) already exist.

## Goals

1. Make `/focus` a **richer picker**: slim dashboard meta line, a **resume hero**, and two labelled lanes (single-task / multi-step) using the exact inbox verbiage + "see all →", with inline ✓ quick-complete.
2. Redesign the **timer** to be **single/multi-aware**, with a step tracker, clearer hierarchy, 4 visual styles, symmetric ±time, focus sounds/alarm/keep-awake, and a consistent ← Back.
3. Add persisted **Settings**: a "Focus timer" group and an app-wide "Appearance" (completion style) group.
4. Apply the **a11y 4-item sweep** to both pages (Phase 8 !88 did not cover `/focus`).

## Non-goals / out of scope (future)

- **Streaming search/playback** (YouTube / Spotify / SoundCloud) for focus sounds — future release (OAuth/embedding/licensing). We ship 1–2 bundled CC0 loops only.
- Per-user accounts (#35) / scheduling seam (#34) — unrelated.
- No new data models beyond `Settings` columns. Launcher stays read-only, reusing `ensureFocusStep`.

---

## Design — A. `/focus` launcher

Server Component (`export const dynamic = "force-dynamic"`), workspace-scoped via `currentWorkspaceId()`, voice-aware.

**Layout (top → bottom):**
1. **← Back** (top-left) → `/inbox`, matching the Library page exactly (`t("action.back")`, `text-muted-foreground hover:text-foreground inline-flex items-center text-sm`).
2. **Title** — `t("nav.focusTimer")`.
3. **Meta line** (glanceable, one line) → links to `/dashboard`: `{focusMinToday}m focused today · 🔥 {currentStreak}-day streak · ~{minutesToClear}m to clear`. Data from `getDashboardData`. `minutesToClear` = Σ estMinutes of the next incomplete step of every multi-step task + Σ estMinutes of single-task to-dos (a rough "clear everything" figure).
4. **Resume hero** (only if a resumable step exists) — the **most-recently-active paused step** (a step with an open `FocusSession`): parent task, `step X of Y`, thin progress bar, `~Nm left`, next-step peek, big **▶ Resume focus** → `/focus/[stepId]`. Highlighted (amber) card.
5. **Single-task to-dos** lane — `SubHeader`(`section.singleTask`, count, see-all → `/library?tab=plated`); rows = in-flight single-task `BrainDumpItem`s (the `singleTask` bucket from `libraryBuckets`, excluding done/archived). Each row: text · `estMinutes`m · **▶ Start** (calls `ensureFocusStep` then routes) · inline **✓** quick-complete (`completeItem`).
6. **Multi-step to-dos** lane — `SubHeader`(`section.multiStep`, count, see-all → `/library?tab=sorted`); rows = multi-step tasks' next incomplete step (existing `focusableSteps` logic), excluding the resume-hero item (no duplication). Each row: task title · step text (+emoji) · thin progress `k/n` · `~Nm` · **▶** open timer · inline **✓** quick-complete (`completeStep`).
7. **Empty states** — brand-new (nothing focusable) → friendly card → `/inbox`; **all-cleared** (had focusable work, now none) → inbox-zero-style "all done" moment (reuse `inbox.zero` tone).

**Ordering:** hero = most-recent open-session step. Within each lane: paused/started first, then recency + aging (mirror Inbox). Reuse Inbox aging settings threading if aging labels are shown.

**Selection logic** lives in a pure, unit-tested module (extend `src/lib/focus-launcher.ts`): given the workspace's tasks + single-task items, produce `{ resumeHero: FocusableStep | null, singleTasks: SingleFocusable[], multiStep: FocusableStep[], meta: { minutesToClear } }`. No React/DB in the pure layer.

**Quick-complete** is optimistic (client component wrapping the rows), reusing `completeItem` / `completeStep`; on success the row leaves its lane and `router.refresh()` updates counts/meta.

---

## Design — B. Timer `/focus/[stepId]`

Keep the phase machine, add-time, AI re-estimate, and celebration. Changes:

**Header & hierarchy**
- **← Back** (top-left) → `/focus` (the launcher is the logical parent; leaving makes no server call, so the `FocusSession` stays open/resumable — this replaces the removed "pause for now").
- **Active step is the focal line:** task title → `text-sm` semibold/muted (context); active step text → `text-xl` bold. (Single-task: the step text is just the to-do, same larger treatment.)
- Corner: `🔥{streak} · {focusMinToday}m today` (from `getDashboardData`; hidden in minimal mode).

**Multi-step context (hidden entirely for single-task focus & in minimal mode)**
- `step X of Y · ~Nm left in task`.
- **Segmented tracker** under the header: n segments (done / **current** / upcoming) + a `steps ▾` toggle.
- **Expandable full step list** (`steps ▾`): vertical stepper (`✓` done · `●` now · `○` upcoming) with per-step est. **Auto-expands on pause / time's-up / complete** (calm while running, orienting when stopped).
- **Next-step peek** below controls: `next → <emoji> <text>`.

**Timer visual — 4 styles** (new `TimerVisual` component, switches on resolved style):
- `ring` (existing SVG ring), `digits` (large digital only), `bar` (linear depleting bar), `mug` (a cup that drains). Each shows the readable `mm:ss` + `of Nm` (never colour-only) and has a reduced-motion variant.
- **Resolved style** = `settings.focusTimerStyle ?? (voice === "playful" ? "mug" : "ring")`.

**Controls (running/paused)** — bigger, fewer, ≥44px:
- Primary **✓ Complete step** (green, prominent) → `completeFocus`.
- **⏸ Pause / ▶ Resume** (countdown toggle).
- **−5m / +5m** (labelled ±`addTimeIncrementMin`, default 5). `+` = existing `addTime`; **new** `removeTime(mins)` reduces planned + remaining, **clamped** so remaining never drops below elapsed (min 1:00). The "+Xm added" note becomes a signed net "±Xm".
- **Remove** the "Pause for now" tertiary action and the `gaveup` phase/screen.
- **Time's-up** choices unchanged: **✓ Done · +5m · not yet (AI re-estimate → requeue)**.

**Audio / device (new, from settings)**
- **Alarm** (`focusAlarmEnabled`, default on): play a short chime at time's-up (+ `navigator.vibrate` on mobile where available). Audio is unlocked by the user's Start tap.
- **Focus sounds** (`focusSound`, default off): loop a bundled CC0 lofi track while `running`; pause with the countdown; stop on complete/leave.
- **Keep awake** (`focusKeepAwake`, default on): hold `navigator.wakeLock` during `running`; release on pause/end/unmount; degrade silently where unsupported.
- **Minimal / distraction-free** (`focusMinimalMode`, default off): hide streak, task context, segmented tracker & next-peek while running — just step text + timer + controls.

**First-run customization hint** — a one-time, dismissible callout on the timer ("Make this timer yours — style, sounds, alarm & more" → `/settings`, voice-aware), gated on `focusTimerTipDismissedAt`; dismiss (✕) or tap-through sets it.

---

## Design — C. Settings

New per-workspace `Settings` columns (one migration), surfaced in the settings hub with the existing auto-save pattern (`use-save-status`). Value-set string columns get `constants.ts` constants + Postgres `CHECK` constraints + sync-test entries, **consistent with #38** (see Coordination).

**Focus timer group** (new `focus-timer-section.tsx`):
| Setting | Column | Type / values | Default |
|---|---|---|---|
| Timer style | `focusTimerStyle` | `String?` — `ring`\|`digits`\|`bar`\|`mug` (null → voice) | null (ring/mug by voice) |
| Minimal / distraction-free | `focusMinimalMode` | `Boolean` | false |
| Keep screen awake | `focusKeepAwake` | `Boolean` | true |
| Alarm at time's-up | `focusAlarmEnabled` | `Boolean` | true |
| Focus sounds | `focusSound` | `String` — `off`\|`lofi_calm`\|`lofi_…` | `off` |
| (existing) Add/remove step | `addTimeIncrementMin` | `Int` | 5 |
| (existing) Start from estimate | `defaultFromEstimate` | `Boolean` | true |
| Hint dismissed | `focusTimerTipDismissedAt` | `DateTime?` | null |

**Appearance group** (new `appearance-section.tsx`, **app-wide**):
| Setting | Column | Type / values | Default |
|---|---|---|---|
| Strike through completed | `completeStrikethrough` | `Boolean` | true |
| Tick colour | `completeTickColor` | `String` — `green`\|`black` | `green` |

## Design — D. App-wide completion style

Implement once, not threaded through every component. In the app shell (`src/app/(app)/layout.tsx`), read the two Appearance settings and set root data attributes / CSS custom properties (e.g. `<div data-complete-strike data-tick="green">` or `--tick-color`, `--complete-decoration`). Shared completion styling (the ✓ glyph colour and the line-through on finished text) references those vars, so Inbox done rows, Library `ProgressPill`/Done view, task steps, focus done screens and any "done" pill all follow the setting automatically. Provide a tiny helper/util + Tailwind classes; audit the completion render sites and point them at the shared treatment.

## a11y (the 4-item sweep — both pages + completion style)

- **prefers-reduced-motion:** ring `stroke-dashoffset` transition, mug drain, confetti (`Celebration`), and any ambient motion collapse to instant/none. Reuse the reduced-motion approach from Phase 8 (!88) after resync; if none exists, add `motion-reduce:` utilities / a `useReducedMotion` guard.
- **WCAG-AA contrast** in light **and** dark for all new text/badges/tiles (amber hero, streak, paused badge, tick colours, "see all →").
- **≥44px** hit targets for all controls, lane row Start/✓, see-all links, hero CTA, timer buttons.
- **Status not colour-only:** paused = ⏸ + "paused"; done = ✓ glyph (+ optional strike-through) + text; current step = `●` + bold, not colour alone; segmented tracker pairs shape/position with colour.

## Data model / migrations

- One migration adding the 8 `Settings` columns above (+ CHECK constraints for `focusTimerStyle`, `focusSound`, `completeTickColor` derived from new `constants.ts` sets). No other model changes.
- **Coordination:** this branch must **rebase on `main` after #38 (!92) merges** so the new CHECK constraints + `enum-constraint-sync.integration.test.ts` registry pattern are present, and the new columns are added the same way. Also reconcile the #36 (!94) rename `reclaimSynced → googleSynced` (the timer `done` screen currently reads `result.reclaimSynced`) and the dropped `Step.reclaimTaskId`/`FocusSession.reclaimSynced`.

## Files

**Create:** `src/components/focus/timer-visual.tsx` (4 styles), `src/components/focus/focus-step-tracker.tsx` (segmented + expandable), `src/components/focus/timer-customization-hint.tsx`, `src/components/settings/focus-timer-section.tsx`, `src/components/settings/appearance-section.tsx`, `src/lib/focus-sounds.ts` (audio/wake-lock helpers), bundled audio asset(s) under `public/audio/` (+ LICENSE note), completion-style util/CSS.
**Modify:** `src/lib/focus-launcher.ts` (richer selection), `src/components/focus/focus-launcher.tsx` (hero + lanes + quick-complete), `src/app/(app)/focus/page.tsx` (expanded query incl. single-task items + dashboard data), `src/components/focus/focus-timer.tsx` (hierarchy, tracker, styles, ±5, back, audio, minimal, remove pause-for-now), `src/app/(app)/focus/[stepId]/page.tsx` (pass streak/settings/step-list/nextStep), `src/app/(app)/settings/page.tsx` (mount new sections), `src/app/(app)/layout.tsx` (completion-style root attrs), `src/lib/strings.ts` (new keys, voice-aware), `prisma/schema.prisma`, `src/lib/constants.ts`.

## Testing (TDD)

- **Pure launcher** (`focus-launcher.test.ts`): hero selection, single/multi split, `minutesToClear`, ordering, hero-not-duplicated-in-lane, empty/all-cleared.
- **Launcher component** (RTL): lanes + inbox labels + see-all hrefs, Start (ensureFocusStep) + inline ✓ (completeItem/completeStep), both empty states, voice.
- **Timer** (RTL): style switching + resolved default by voice, −/+ clamp & signed note, segmented tracker + expand + auto-expand on pause/timeup/complete, title<step hierarchy, first-run hint gating, pause-for-now/gaveup removed, back → /focus. Audio/wake-lock/alarm behind mocks (enabled → called; disabled → not).
- **Settings** (RTL): both new sections auto-save each field.
- **Appearance app-wide:** completion render honours root attrs (strike on/off, tick green/black) — assert on a done row + a done step.
- **E2E** (`e2e/`): update `focus-timer.spec` + focus/library nav specs for the new launcher/timer selectors (per process: update specs when touching focus UI). Keep forged-session auth.

## Gates

`tsc` clean · `eslint` 0 new errors · `vitest` green (per-worktree Postgres schema + `prisma migrate deploy`) · `next build` compiles (both routes render) · `npm run test:e2e` (Chromium) green.

## Plan (TDD, dependency-ordered)

1. **Rebase** `feat/focus-page` on `main` (post #92/#94); reconcile `googleSynced` + dropped columns; re-seed worktree deps (`cp -Rc`).
2. Schema + `constants.ts` + migration (8 Settings cols + CHECK) + extend the #38 sync test → red/green.
3. Strings (all new keys, plain + playful).
4. Pure `focus-launcher.ts` richer selection + unit tests.
5. Launcher UI: hero + lanes + see-all + quick-complete + empty states + component tests.
6. Settings: Focus-timer + Appearance sections + auto-save tests; app-wide completion-style root wiring + tests.
7. Timer: hierarchy, `TimerVisual` (4 styles), step tracker (+auto-expand), ±5 clamp, ← Back, remove pause-for-now, first-run hint + tests.
8. Audio/device: alarm chime, focus-sound loop, wake-lock, minimal mode (+ bundled CC0 asset + LICENSE) + mocked tests.
9. a11y sweep pass (reduced-motion, contrast both themes, 44px, status-not-colour-only).
10. E2E updates; full gates; open/refresh !86 for Duo + owner review.

## Downstream

- P5 welcome card "Focus" link and the ☰ `/focus` link now land on the richer launcher.
- Sets up (does not build) the future streaming-sound search.
- **Sibling nav MR** (separate, not this one): ☰ menu order swaps **Library above Dashboard**, and **"Dashboard" is renamed "Activity"** (`nav.dashboard` label + page heading; route `/dashboard` unchanged). The launcher meta line links to it (route unaffected).
