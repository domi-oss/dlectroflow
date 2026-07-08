# dlectroflow — Wireframe → Codebase Merge Plan

**Purpose:** Fold the finalized wireframe (Task Snacking voice, freshness scale, Focus states, Business/Snack toggle, Settings hub) into the live `dlectroflow` codebase.
**Delivery:** feature branches off `main`, one MR per phase, CI + review on each.
**Author:** design/wireframe session hand-off. **Status:** proposed — needs sign-off on the Open Decisions before Phase 1 code lands.

---

## 0. Context & guiding principles

The key finding from the code audit: **most of the wireframe already exists in the code.** The Focus state machine, per-step estimates, breakdown confirm + scheduled/not-scheduled branching, dashboard stats, spark, round-up, best streaks, and the snooze/keep-as-task buckets are all implemented. The wireframe mostly adds a **presentation/voice layer** plus a few new behaviours.

Principles:

- **Foundation first.** The string/voice layer unblocks ~70% of the relabeling, so it ships before the cosmetic changes depend on it.
- **Small, reviewable MRs.** Each phase is independently shippable and testable; no big-bang merge into `main`.
- **Additive schema migrations**, one per phase, sequenced to avoid migration-ordering conflicts.
- **Respect existing conventions** (per `AGENTS.md`): Next.js 16 has breaking changes — check `node_modules/next/dist/docs/` before writing App Router code. Tailwind CSS 4 + `cn()` util; shadcn/ui available but sparingly used.
- **No behaviour regressions** to auth/workspace-scoping (recent, security-sensitive work). All new `Settings` reads/writes must stay workspace-scoped.

### Tech baseline (from `package.json`)
Next.js 16.2.10 · React 19.2.4 · TypeScript · Tailwind CSS 4 · Prisma 6.19.3 · Anthropic SDK · Framer Motion · shadcn/ui.

### Branch / MR naming
`feat/snack-voice-foundation` → `feat/freshness-tiers` → `feat/breakdown-eject` → `feat/settings-hub` → `feat/streak-and-badges`.

---

## Open Decisions (resolve before / during Phase 1)

These change the implementation and should be settled first. Assumptions I'll otherwise make are noted.

1. **Voice scope: per-workspace or per-user?** `Settings` is currently **per-workspace** (recent scoping refactor). The wireframe implies a personal preference. *Assumption:* store `voice` on `Settings` (per-workspace) for now, since that's the existing model; revisit if multi-user-per-workspace becomes real.
2. **Default voice.** Wireframe default was **Business**. *Assumption:* `voice` defaults to `"business"`.
3. **Freshness reset mechanism.** Add a `freshenedAt` timestamp and measure age from `max(createdAt, freshenedAt)` — *recommended*, non-destructive — vs. mutating `createdAt` (lossy). *Assumption:* `freshenedAt`.
4. **Streak rule.** Wireframe said "any app engagement/day"; code currently advances the streak **only on step-completion** (`rewards.ts touchStreakOnCompletion`, called from `completeFocus`). Need an explicit list of what counts (capture? breakdown-confirm? focus-finish?). **Blocks Phase 5.**
5. **Badge milestone set + names.** Still TBD from the design walkthrough (rethink milestones + snack/business names). **Blocks Phase 5.**
6. **Header voice switch in real app chrome?** Wireframe had both a top-bar quick-switch and a Settings toggle. *Assumption:* ship the Settings toggle in Phase 1; add the always-visible chrome switch only if wanted (it competes for space with the owner/guest nav).

---

## Phase 1 — Voice / string foundation  ·  `feat/snack-voice-foundation`

**Goal:** introduce a voice preference + a centralized string layer, wire a working Business↔Snack toggle end-to-end, and migrate the high-traffic labels. After this MR, flipping the toggle rewords the app.

### Schema
- `prisma/schema.prisma` → `Settings`: add `voice String @default("business")`.
- `prisma migrate dev --name add_settings_voice`.

### New string layer
- `src/lib/strings.ts` — a map of logical keys → `{ business, snack }`, e.g.
  ```ts
  export const STRINGS = {
    "action.breakdown":   { business: "Break down →",    snack: "🍿 Snack-size it →" },
    "action.saveAsTask":  { business: "Save as task",    snack: "🍽️ Plate it up" },
    "action.snooze":      { business: "Snooze",          snack: "🥫 To Pantry" },
    "action.freshen":     { business: "Mark reviewed",   snack: "🔄 Freshen up" },
    "stat.points":        { business: "Points today",    snack: "Crumbs today" },
    "stat.streak":        { business: "Current streak",  snack: "On a roll" },
    // …full map, see wireframe vocab table below
  } as const;
  export type Voice = "business" | "snack";
  export const t = (key: keyof typeof STRINGS, voice: Voice) => STRINGS[key][voice];
  ```
- **Architectural decision (call out in MR):** strings must be available at render in a Server-Component tree. Plan:
  - Server layout `src/app/(app)/layout.tsx` reads `settings.voice` (workspace-scoped) once and passes it down.
  - Provide a `VoiceProvider` (client context) for client components (inbox, focus, breakdown are interactive/client). Toggle updates context immediately for snappy UX **and** persists via the settings action.
  - Keep `t()` pure so it works in both server and client code.

### Actions
- `src/app/actions/settings.ts`: add `updateVoice(voice)` (or fold into existing settings update), workspace-scoped like the others.

### UI wiring
- `src/components/inbox/settings-panel.tsx`: add a Business/Snack segmented toggle.
- (Optional, per Decision 6) header quick-switch in `(app)/layout.tsx`.

### Label migration (this MR — the high-traffic set)
- `inbox-view.tsx`: row actions (`Break down →` / `Keep as task` / `Snooze` / `Delete`), section headers.
- `dashboard/page.tsx`: the 4 stat labels (`Today's points`, `Current streak`, `Focus mins today`, `Steps done today`) + "Total points earned".
- `focus-timer.tsx`: key buttons (start, done headline, next-step, save-for-later).
- `breakdown-chat.tsx`: confirm button + resize quick-replies + confirmed banners.

### Acceptance criteria
- Toggling voice in Settings rewords all migrated strings without reload; choice persists per workspace; default is Business.
- No hardcoded label remains in the migrated components (grep check in review).

### Tests
- Unit: every `STRINGS` key has both `business` and `snack` (map-completeness test).
- Unit/render: a component renders the correct label for each voice.

### Risks
- Server/client voice availability (mitigated by the provider plan above).
- Merge conflicts: this MR touches inbox/breakdown/focus/dashboard — land it first, before other cosmetic work.

---

## Phase 2 — Multi-tier freshness  ·  `feat/freshness-tiers`

**Goal:** replace binary aging with the 4-tier scale, add "Freshen up", configurable thresholds, and the 24h prompt.

### Schema
- `Settings`: add `freshnessSofteningMin Int @default(240)`, `freshnessSoggyMin Int @default(480)`, `freshnessStaleMin Int @default(720)` (4h/8h/12h). Consider deprecating/aliasing existing `agingThresholdMinutes`.
- `BrainDumpItem`: add `freshenedAt DateTime?` (Decision 3).
- Migration: `add_freshness_tiers`.

### Lib
- `src/lib/aging.ts`: add `freshnessTier(item, settings, now): "fresh" | "softening" | "soggy" | "stale"` measuring age from `max(createdAt, freshenedAt)`. Keep/adapt `isAging` for any existing callers.

### Actions
- `src/app/actions/braindump.ts`: add `freshenItem(id)` → set `freshenedAt = now` (workspace-scoped).

### UI
- `inbox-view.tsx`: `StatusPill` → 4 voice-aware tiers with colours (🟢/🟡/🟠/🔴 → Fresh/Softening/Soggy/Stale ↔ New/Aging/Overdue/Critical). Freshest-first sort already exists. Add **Freshen up** on Soggy/Stale rows; add the inline **24h "still want it? / Not now"** prompt (wired to `freshenItem` / `deleteBrainDumpItem`).
- `settings-panel.tsx` / settings: expose the three thresholds.

### Acceptance / tests
- Unit: tier boundaries (0/4/8/12h) and that `freshenItem` returns an item to `fresh`.
- The daily review nudge is **stubbed** here (UI prompt only); scheduling lives in Phase 4.

### Risks
- `aging.ts` + `BrainDumpItem` schema are shared — coordinate with any in-flight aging work; keep migration isolated.

---

## Phase 3 — Breakdown eject + resize chips  ·  `feat/breakdown-eject`

**Goal:** per-step "Back to inbox / Back to the kitchen" eject + explicit More/Fewer steps chips.

### Actions
- `src/app/actions/breakdown.ts`: add `ejectStepToInbox(taskId, stepId)` → create a `BrainDumpItem` (step text, untriaged, fresh) and remove the step from the proposal/task. Workspace-scoped.

### UI
- `breakdown-chat.tsx`: add the eject control per step row (alongside the existing estimate input + trash). Map the existing "⬇️ Too big / ⬆️ Too small" quick-replies to voice-aware **More steps / Fewer steps** (🍞 More bites / 🥖 Fewer bites) labels.

### Tests
- Unit: `ejectStepToInbox` creates the inbox item and removes the step.

### Notes
- Per-step estimate, confirm, and confirmed-state branching already exist — no change needed there beyond labels (done in Phase 1).

---

## Phase 4 — Settings hub  ·  `feat/settings-hub`

**Goal:** promote settings from the inbox collapsible panel to a dedicated `/settings` page consolidating everything.

### Schema
- `Settings`: add `notificationsEnabled Boolean @default(true)`, `dailyReviewNudgeTime String?` (e.g. "09:00"). Migration: `add_settings_notifications`.

### Route / components
- New `src/app/(app)/settings/page.tsx` (server) + `src/components/settings/*`. Migrate/extend the current `settings-panel.tsx` content.
- Sections: **Voice** (from Phase 1), **Freshness thresholds** (Phase 2), **Integrations** (Reclaim/Google Tasks connect + status via existing `getReclaimStatus` / `getGoogleStatus`), **Notifications** (desktop reminders, round-up email — already partly modeled), **Daily review nudge** time.
- Add **Settings** to the app nav in `(app)/layout.tsx` (respect owner/guest gating).

### Tests
- Settings save round-trip per section; workspace-scoping preserved.

### Notes
- Wiring the daily-review-nudge to an actual scheduler is out of scope here (surface the setting; implement the trigger as a follow-up, candidate for a server cron / scheduled job).

---

## Phase 5 — Streak rule + badges  ·  `feat/streak-and-badges`  *(blocked on Decisions 4 & 5)*

**Goal:** implement the agreed streak rule and finalized badge milestones.

### Streak
- `src/lib/rewards.ts`: if the rule broadens to "any engagement", extract a `touchStreakOnEngagement()` and call it from the relevant actions (`braindump` capture, `breakdown.confirmBreakdown`, `focus.completeFocus`). Guard against double-counting per day.

### Badges
- Finalize the milestone set + snack/business names (design decision). Implement award logic + seeding; render voice-aware names on the dashboard.

### Tests
- Streak advances once/day on a qualifying engagement; badges award at their milestones.

---

## Sequencing & dependencies

```
Phase 1 (voice foundation)  ──►  Phase 2 (freshness)  ──►  Phase 4 (settings hub)
        │                              │
        └──►  Phase 3 (eject)          └── thresholds surfaced in Phase 4
Phase 5 (streak/badges)  ── independent, but blocked on product Decisions 4 & 5
```

- **Phase 1 must merge first** (string layer is a dependency for every relabel).
- Phases 2 and 3 can run in parallel after 1; both feed labels/settings into Phase 4.
- Phase 5 can start any time once Decisions 4 & 5 are made.

## Per-MR checklist (apply to each)
- [ ] Branch off latest `main`; small, focused diff.
- [ ] Prisma migration additive + named; `prisma generate` run.
- [ ] Follows `AGENTS.md` (checked Next 16 docs for any App Router API used).
- [ ] Unit tests added; existing suite green (`vitest`).
- [ ] Workspace-scoping preserved on all new reads/writes.
- [ ] No secrets; passes CI Secret Detection.
- [ ] MR description links the design decision(s) it implements.

## Wireframe vocabulary reference (business ↔ snack)
| Business | Snack |
|---|---|
| Break down | 🍿 Snack-size it |
| Save as task / Tasks | 🍽️ Plate it up / Plated |
| Snooze / Snoozed | 🥫 To Pantry / Pantry |
| Mark reviewed | 🔄 Freshen up |
| Triaged | ✅ Sorted |
| Back to inbox | 🍳 Back to the kitchen |
| More steps / Fewer steps | 🍞 More bites / 🥖 Fewer bites |
| Confirm steps | ✅ Lock it in |
| Start focusing | 🍽️ Dig in |
| Save for later | 📦 Leftovers: save for later |
| Step complete — nice work | 🍽️ You bit off exactly what you could chew |
| New / Aging / Overdue / Critical | 🟢 Fresh / 🟡 Softening / 🟠 Soggy / 🔴 Stale |
| Points / Streak / Focus mins / Steps | Crumbs / On a roll / Time at the table / Bites |
