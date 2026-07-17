# S0 — ICS "Add to calendar" as a universal scheduling method + rewards + "Scheduled ✓"

- **Date:** 2026-07-17
- **Status:** Approved (design) — ready for implementation plan
- **Epic:** #29 (Generalize scheduling for open-source, #12 §4)
- **Trigger:** #25 fast-follow — "let guests earn scheduling rewards"
- **Size:** Small · **Depends on:** nothing (no accounts refactor)

## Goal

Make **ICS "Add to calendar"** a first-class, per-task scheduling method available to **everyone** (guests, owner, future self-hosters without Google) — the universal, zero-OAuth baseline from #12 §4. Doing so:

1. Unblocks **guest scheduling rewards** safely — guests never touch the owner's singleton Google connection.
2. Lets any task be scheduled via a downloadable `.ics` and earns `Scheduled` (+10) + `FirstSchedule` in the acting workspace.
3. Introduces a **provider-agnostic "scheduled" marker**, which drives the **"Scheduled ✓"** per-row indicator (the other open #25 fast-follow) and de-risks the future S1 provider seam.

## Non-goals (deferred to later epic sub-projects)

- Per-user ICS **subscription feed** with capability tokens (S2 — needs accounts foundation F).
- Per-user Google Tasks (S3), free/busy slot-finding (S4), dropping Reclaim (S5).
- Formalizing the full scheduling-provider interface (S1) — S0 only lays the marker groundwork.
- LLM abstraction (#12 §3, separate epic).

## Current state (what already exists)

- `src/lib/ics.ts` → `buildTaskIcs({title, parentEmoji, steps, start})` builds a `VCALENDAR` with one back-to-back `VEVENT` per step (floating local time, default start = next top of hour). Unit-tested.
- `GET /api/ics/[taskId]` → **workspace-scoped** (`currentWorkspaceId()`, so it already works for guests), returns the `.ics` as a download. **No reward, no "scheduled" marker.**
- UI: `src/components/breakdown/breakdown-chat.tsx` surfaces "⬇️ Download calendar (.ics)" (link to `/api/ics/[taskId]`) in the breakdown view only — **not** on inbox/board rows.
- Row 📅 (`src/components/inbox/row-actions.tsx`): the Google scheduling control. Guests see it **disabled/locked** (`state: "guest"`, "Scheduling isn't available in guest mode — sign in to schedule").
- Rewards (`src/lib/rewards.ts`): `logReward(workspaceId, RewardType.Scheduled)` (+10 via `RewardPoints`), `awardBadge(workspaceId, BadgeKey.FirstSchedule)` (P2002-safe). All workspace-scoped.
- Google single-task path (`scheduleSingleTask`) uses a duration popover (15/30/60/custom).

## Design

### 1. Data model (small migration)

Add to `model Task`:

```prisma
scheduledAt   DateTime?   // when the task was first scheduled (any method)
scheduledVia  String?     // "ics" | "google"  (method-agnostic marker)
```

- Method-agnostic on purpose: the Google path **also** sets these on success, so the "Scheduled ✓" indicator and reward-idempotency are provider-agnostic. This is the seam groundwork for S1 (no interface yet, just the shared signal).
- Forward-only migration (per repo policy). Existing already-Google-scheduled tasks won't be back-filled (`scheduledAt` stays null until next schedule) — acceptable; the indicator is best-effort going forward.

### 2. Server action — `scheduleViaIcs`

New action (e.g. `src/app/actions/ics-schedule.ts`), **workspace-scoped, guests allowed** (no `OWNER_WORKSPACE_ID` gate):

```
scheduleViaIcs(taskId: string, opts?: { durationMin?: number }): Promise<{ icsFilename: string; ics: string }>
```

Behaviour:
1. Resolve `workspaceId = await currentWorkspaceId()`; load the task `where { id: taskId, workspaceId }` incl. steps (IDOR-safe — a wrong workspace → not found).
2. Build the `.ics`:
   - **Task with steps** → `buildTaskIcs` as today.
   - **No-steps task** → synthesize a single step from `opts.durationMin` (15/30/60/custom; default 25) so one `VEVENT` is emitted with the task title.
3. **Marker + reward (idempotent):** if `task.scheduledAt == null`, set `scheduledAt = now`, `scheduledVia = "ics"`, then `logReward(Scheduled)` + `awardBadge(FirstSchedule)` **once**. If already scheduled (any method), skip the award (no point-farming) but still return the `.ics` (re-download is fine).
4. Return `{ ics, icsFilename }`. **Canonical download path:** the client turns the returned content into a Blob and triggers the download — so a single action call both marks+rewards *and* delivers the file (no separate GET round-trip, no way to get the file without the marker/reward). `GET /api/ics/[taskId]` stays as-is for direct-link/fallback use but is no longer the primary UI entry point.

Reward semantics mirror the Google action: the reward fires on the **schedule action** (the "Add to calendar" click), not on proof the file was imported into a calendar — the same limitation the Google path already accepts.

### 3. UI (`src/components/inbox/row-actions.tsx`)

- **Guest rows:** replace the locked 📅 with an actionable **"Add to calendar (.ics)"** (primary action). For a no-steps task, reuse the existing duration popover before building.
- **Owner rows:** Google Tasks stays the primary 📅 action; **"Add to calendar (.ics)"** is added to the ▾ overflow menu as an alternative.
- **"Scheduled ✓" indicator:** when `task.scheduledAt != null`, render a compact "Scheduled ✓" affordance on the row (both methods) — closes the second #25 fast-follow.
- Download UX: clicking "Add to calendar" calls `scheduleViaIcs` (marks + rewards) and triggers the `.ics` download from the returned content (Blob). One tap.
- **Consistency:** the existing breakdown-chat "⬇️ Download calendar (.ics)" entry point (`breakdown-chat.tsx`) is re-routed through the same `scheduleViaIcs` action, so *every* ICS entry point marks + rewards uniformly (no "download here = no reward, download there = reward" split).

### 4. Error handling

- Task not found / wrong workspace → the action throws / the row shows a non-blocking error (mirror existing row error handling; no cookie/state change).
- `.ics` build is pure + cheap (no AI, no external calls) → no guest quota needed (unlike breakdowns).
- Re-scheduling an already-scheduled task → returns the `.ics`, no re-award (idempotent).

## Testing

- **Action tests** (`ics-schedule.test.ts`): awards `Scheduled` + `FirstSchedule` once on first schedule; **guest workspace earns the reward**; idempotent — no re-award when `scheduledAt` already set; no-steps task uses `durationMin`; wrong-workspace taskId → not found (IDOR); sets `scheduledAt`/`scheduledVia="ics"`.
- **Builder**: `ics.ts` already covered; add a no-steps single-event case if not present.
- **RTL** (`row-actions` / inbox view): guest row shows an **enabled** "Add to calendar" (not the locked 📅); owner ▾ has the ICS entry; the "Scheduled ✓" indicator appears once `scheduledAt` is set.
- Gates: `tsc --noEmit`, `eslint`, full `vitest run` green.

## Open item to verify during implementation

- **Guest reward visibility:** confirm guests actually *see* a rewards/points surface for their workspace (dashboard). If not, the earned points are invisible — but S0 still gives visible feedback via the **"Scheduled ✓"** indicator, so the feature isn't purely silent. If a guest dashboard is missing, note it as a follow-up (not a blocker for S0).

## Rollout / risk

- Additive migration + new action + UI affordance; no change to the owner Google path except also setting the shared marker.
- Guests gain a genuinely useful, safe capability (calendar export) — no access to owner data or the singleton Google connection.
