# dlectroflow — Wireframe hand-off & implementation brief

**For:** Claude Code, to produce an implementation plan and ship it.
**Inputs:**
- Interactive wireframe: `docs/wireframe/dlectroflow-wireframe.html` (open in a browser; self-contained HTML/CSS/JS).
- Phased code-mapping plan (written earlier, still the base): `MERGE-PLAN.md`.

This brief records the **finalized UX decisions** from the design sessions so the implementation plan matches the wireframe exactly. Where this brief and the older merge-plan differ, **this brief wins** (it's newer).

---

## Goal

Turn the wireframe into shipped product, via **feature branches → one MR per phase → review/CI → release**. First produce a written implementation plan (issues + MR breakdown), then execute. Do **not** big-bang it.

Key finding from the earlier audit: **most behaviour already exists in the codebase** (Focus state machine, per-step estimates, breakdown confirm + scheduling branch, dashboard stats, snooze/keep-as-task buckets). The wireframe mostly adds a **presentation/voice layer**, an **information-architecture cleanup**, and a few new behaviours (below).

---

## Screens / IA (final)

Six screens, reached via the ☰ menu (menu shows: Inbox, Focus Timer, Dashboard, Everything, Settings — **Task Breakdown is NOT in the menu**; it's reached only by acting on an item):

1. **Inbox** — capture + review. Sections top→bottom:
   - **Needs review** (prominent) — freshly captured, unsorted items, freshest/newest first.
   - **To do** (prominent) with two sub-buckets: **Single-task to-dos** (committed, no breakdown) and **Multi-step to-dos** (broken-down tasks, showing step progress e.g. "2/5 done"). Multi-step rows open the breakdown.
   - **Saved for later** — deferred items (freshness paused).
   - Each section has a **see all →** deep-link into the matching Library tab.
2. **Task Breakdown** (`/tasks/[taskId]`) — chat + editable step list (emoji, text, editable time estimate); confirm; then a confirmed state that branches on scheduling success (scheduled vs saved-not-scheduled).
3. **Focus Timer** (`/focus/[stepId]`) — state machine: Setup → Running/Paused → Time's up → Done. Low-shame **Pause for now** exit keeps the step in its task and surfaces a resume banner in the Inbox.
4. **Dashboard** — 4 stats, daily spark, end-of-day round-up, best streaks, 9 badges (see the reconciled badge list below, which this line used to contradict).
5. **Settings** — voice, freshness thresholds, integrations (Reclaim/Google Tasks), notifications, + a **Demo: First-run preview** toggle.
6. **Everything** (Library hub) — tabs: **Single-task · Multi-step · Saved for later · Done**. Has a **← Back** button. Rows open the breakdown.

---

## Voice architecture (important)

Two voices, switchable live (top bar + Settings), **persisted**:
- **Plain** — the **default**. Must be 100% self-evident, **no decorative emoji anywhere** (keep only functional glyphs: status dots 🟢🟡🟠🔴, ✅, ▶/⏸/➕/➖, 🗑️, 🔒, ⚠️).
- **Playful** — opt-in delight skin: same labels + a flavour emoji, with a few signature nouns kept (see table).

Implementation: a **string/i18n layer** (`voice` on the `Settings` model; a `strings.ts` map of `{plain, playful}`), read at render. First-run defaults to Plain and offers the choice.

### Vocabulary map (Plain ↔ Playful)
| Plain (default) | Playful |
|---|---|
| Break into steps | 🍿 **Snack-size it** (signature term — kept as a noun) |
| Add to-do | 🍽️ Add to-do |
| Save for later | 🥫 Save for later |
| Confirm steps | ✅ Confirm steps |
| Start focusing | 🍽️ Start focusing |
| Pause for now | ⏸️ Pause for now |
| More steps / Fewer steps | 🍞 More steps / 🥖 Fewer steps |
| Back to inbox | 🍳 Back to inbox |
| Needs review (section) | Needs review |
| To do (section) | To do |
| Single-task to-dos | 😋 Quick bites |
| Multi-step to-dos | ✅ Sorted |
| Saved for later (bucket) | 🥫 Pantry |
| Everything (hub) | 🍱 Larder |
| Done (bucket) | 🍽️ Devoured |
| Recent / Aging / Overdue / Way overdue (freshness) | Fresh / Softening / Soggy / Stale |
| Points / Current streak / Focus mins / Steps | Crumbs / On a roll / Time at the table / Bites |
| "Step 2 of 4" | "bite 2 of 4" |

Voice toggle **modes are named "Plain" and "Playful"** in the UI.

---

## Finalized behaviours (new or changed vs current code)

- **Freshness scale (4 tiers)** on unsorted items, by age: Recent → Aging (4h) → Overdue (8h) → Way overdue (12h). Colour dot + short word in the pill; exact "captured Xh ago" on the line below. Configurable thresholds in Settings. A **no-guilt nudge, not a deadline**.
- **24h prompt**: an item untouched 24h shows an inline "still needed?" check with a **Dismiss** (no "mark reviewed" action).
- **Capture** shows an inline "captured ✓" and drops the item into Needs review (new items go to the **top** of lists).
- **Row actions** (Needs review): Break into steps (→ breakdown), Add to-do (→ Single-task bucket), Save for later (→ Saved for later bucket), Delete.
- **Saved for later** rows: tapping the row expands it in place into the review actions (stays in the bucket — never auto-navigates). "Add to-do" **visibly moves** the item to the top of the Single-task queue; "Save for later" returns it to the collapsed state.
- **Delete confirmation**: every task/item delete shows an inline "Delete · cancel" confirm before removing. (Banner dismisses do NOT need confirm.)
- **Multi-step / Sorted** shows step progress; a task with **all steps done graduates to the Done bucket** (closure pile).
- **Focus → Pause for now**: ends the session, keeps the step in its task, surfaces a resume banner in the Inbox ("Focus step … paused — resume →").
- **First-run / empty state**: welcome card offering Plain/Playful + a capture-first empty Inbox. Exposed as a **Demo toggle in Settings** (and a wireframe preview toggle in the harness).
- **Streak rule** (Decision 1 — SHIPPED in Phase 7, #8): the streak now advances on **any qualifying action per working day** — a capture, a breakdown-confirm, or a step/task completion — at most once per working day (`touchStreakOnEngagement` in `src/lib/rewards.ts`; `touchStreakOnCompletion` is a thin alias). **Badges — 9 shown on the dashboard** (`DASHBOARD_BADGE_KEYS` in `src/lib/constants.ts`): the **7 wireframe badges** — First breakdown (`first_breakdown`), First scheduled (`first_schedule`), First focus (`first_focus`, awarded when a focus session starts), Task complete (`task_complete`), Full work week = 5-working-day streak (`streak_5`), Inbox zero (`inbox_zero`), Comeback (`comeback`, no-shame restart after a gap) — plus **2 legacy badges** the owner chose to surface (owner decision on !82): Ten steps in a day (`ten_steps_day`) and Beat your best streak (`beat_best_streak`). All awards are idempotent via the P2002-safe `awardBadge`; the dashboard renders every badge earned or not-earned-yet.

### Baseline accessibility to bake in (from the ADHD/COGA review)
- Honour `prefers-reduced-motion` for the completion confetti.
- Fix low-contrast helper text (`#aaa` fails WCAG AA); ensure ≥44px touch targets on mobile.
- Don't convey status by colour alone (freshness pairs dot + word/timestamp — keep that).

---

## Open decisions to confirm before/while planning
1. ~~**Streak rule** — exactly what counts as a day's engagement.~~ **Decided and
   shipped** in Phase 7 — engagement, via `touchStreakOnEngagement` in
   `src/lib/rewards.ts`, with `touchStreakOnCompletion` retained as a thin alias. The
   badge section above already recorded this as SHIPPED while this list still asked for
   a decision on it.
2. **Voice scope** — per-workspace (matches current `Settings`) vs per-user.
3. **Freshness reset** — non-destructive `freshenedAt` field (recommended).

---

## Suggested phasing (see `MERGE-PLAN.md` for the file-level detail)
1. Voice/string foundation (`voice` field + `strings.ts` + toggle) — unblocks all relabeling.
2. Inbox IA: Needs review + To do (single/multi-step sub-buckets) + Saved for later; freshness tiers.
3. Library ("Everything") hub with Done tab; deep-links; back button.
4. Breakdown eject-to-inbox + confirm/scheduling copy.
5. Delete confirms, Pause-for-now + resume banner, first-run/empty states.
6. Streak rule + badges (after decisions).
7. Accessibility pass (reduced-motion, contrast, targets).

The wireframe is the source of truth for **copy, structure, and interaction**; it is intentionally low-fidelity on visuals (the app keeps its Tailwind/shadcn styling).
