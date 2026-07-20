# S1 — Scheduling-provider seam (`{ics, googleTasks}` behind one interface)

- **Date:** 2026-07-19
- **Status:** Draft (design) — awaiting approval before implementation plan
- **Issue:** #34 · **Epic:** #29 (Generalize scheduling for open-source, #12 §4)
- **Depends on:** S0 (!78, merged) — the shared `scheduledAt`/`scheduledVia` marker + guest ICS path
- **Size:** Small — a seam/refactor, no new user-facing feature

## Goal

S0 shipped two real scheduling methods and a **provider-agnostic marker** (`Task.scheduledAt` / `scheduledVia`), but the code that *drives* those methods is still ad-hoc: three server actions each re-implement "stamp the marker + award once," and every UI call site re-derives "which method does this workspace get?" from a raw `google` status object (`owner ? googleStatus : null`, `!effectiveGoogle`, `isGuest`).

S1 formalizes a **small provider seam** so rows, rewards, and UX treat the two shipped methods — `ics` and `googleTasks` — uniformly behind one interface. It is a **pure refactor: no behavior change.** The payoff is that when the accounts foundation (**F = #35**) later makes Google available per-user, only the provider's `isAvailable()` changes — not a dozen call sites.

Concretely, S1 delivers:

1. A single **`SchedulingProvider`** shape (`id` / `label` / `isAvailable(ctx)` / `schedule(taskId, ctx, opts)`) with exactly two implementations (`ics`, `googleTasks`).
2. **One place** that answers "which providers can this workspace use?" (guest → `ics` only; owner → both), replacing the scattered `google`/`isGuest` branching.
3. **One** idempotent marker+reward code path shared by both providers (today it is copy-pasted three times with two different error-handling styles).

## Non-goals (deferred / out of scope)

- **F — accounts / per-user foundation (#35, v0.3.0).** S1 does **not** touch `OWNER_WORKSPACE_ID`, the singleton `GoogleAuth`, or `currentWorkspaceId()`. `googleTasks` staying **owner-only** is a *consequence* of F not being done — encoded in one `isAvailable()`, precisely so F becomes a one-line change there. The seam is the thing that makes F cheap; it is not F.
- **New providers** — per-user ICS subscription feed (S2), per-user Google Tasks (S3), free/busy slot-finding (S4), dropping Reclaim (S5). The seam is sized for **exactly the two methods that exist today**. No plugin framework, no dynamic registration/discovery, no speculative `register(provider)` API.
- **Reward semantics, the marker schema, the `.ics` builder, and the UI's visual design** — all unchanged. `ScheduleControl`'s look and its state names stay as-is; S1 only changes *who decides* which state/provider a row gets.
- **LLM abstraction** (#12 §3) — separate epic.

## Current state — the ad-hoc branching S1 unifies

Three axes are currently duplicated/scattered:

**1. Server actions (3 of them), each re-stamping the marker + awarding:**

| Action | File | Gate | Result shape |
|---|---|---|---|
| `scheduleViaIcs(taskId, opts?)` | `src/app/actions/ics-schedule.ts` | none (guest-allowed) | `{ ok, ics, icsFilename }` |
| `pushStepsToGoogleTasks(taskId)` | `src/app/actions/google-schedule.ts` | `workspaceId !== OWNER_WORKSPACE_ID` throws | `{ ok, scheduled, listTitle }` |
| `scheduleSingleTask(itemId, min)` | `src/app/actions/google-schedule.ts` | owner-gate | `{ ok }` (lazy-creates the task) |

Each independently repeats the S0 pattern — *if `task.scheduledAt == null`: set `scheduledAt`/`scheduledVia`, then `logReward(Scheduled)` + `awardBadge(FirstSchedule)` once, best-effort.* And the "best-effort" is inconsistent: `scheduleViaIcs` uses `try/catch`, the two Google paths use `Promise.allSettled` + `console.error`. Same intent, three copies, two styles.

**2. Availability decision, re-derived at every call site:**

- `src/app/(app)/inbox/page.tsx` → `const google = owner ? googleStatus : null;`
- `src/app/(app)/tasks/[taskId]/page.tsx` → `google={owner ? google : null}` + `isGuest={!owner}`
- `src/components/inbox/inbox-view.tsx` → `scheduleState(google, ready)` + `effectiveGoogle ? <google path> : icsProps(item)`, with ICS added as a ▾-overflow alternative for owners.
- `src/components/breakdown/task-schedule.tsx` → `google ? <google path> : <ics path>`.
- `src/components/breakdown/breakdown-chat.tsx` → `isGuest` + `google.{configured,connected,needsReconnect}` branching.

The rule is always the same — **`ics` is universal; `googleTasks` needs owner + a configured/connected Google** — but it is expressed five different ways.

**3. UI control state enum mixes the two methods:** `ScheduleControl` (`row-actions.tsx`) has `ready_steps | needs_duration | connect | reconnect | ics_ready_steps | ics_needs_duration`. This is a **presentational** concern and S1 leaves it alone; S1 only centralizes the *choice* of which provider (hence which states) a row is offered.

**Already provider-agnostic (S0 groundwork, keep as-is):** `Task.scheduledAt: DateTime?` + `scheduledVia: String?` (`"ics" | "google"`); the "Scheduled ✓" indicator in `RowActions` / `TaskSchedule` reads only `scheduledAt != null`; `RewardType.Scheduled` (+10) and `BadgeKey.FirstSchedule`.

## Design

### 1. The seam — `src/lib/scheduling/`

A new small module, `src/lib/scheduling/` (server-only), with no new dependencies.

**Method id (the one source of truth for the marker string):**

```ts
export const SchedulingMethod = { Ics: "ics", GoogleTasks: "google" } as const;
export type SchedulingMethod = (typeof SchedulingMethod)[keyof typeof SchedulingMethod];
```

> Note: the marker value stays `"google"` (not `"googleTasks"`) to match rows already written by S0 — no migration/backfill. The *provider id* surfaced to the UI is `"googleTasks"` (epic wording); the *stored `scheduledVia`* is `"google"`. One `SchedulingMethod` constant owns both facts so they can't drift.

**Context passed to the seam (resolved once, at the server boundary):**

```ts
export type SchedulingContext = {
  workspaceId: string;
  isOwner: boolean;
  /** Owner Google connection status; null for guests (mirrors today's
   *  `owner ? googleStatus : null`). */
  google: { configured: boolean; connected: boolean; needsReconnect: boolean } | null;
};
```

**Provider interface:**

```ts
export type ScheduleOpts = { durationMin?: number };

export type ScheduleResult =
  | { ok: true; via: "ics"; ics: string; icsFilename: string }
  | { ok: true; via: "google"; scheduled: number; listTitle: string }
  | { ok: false; reason: ScheduleFailReason; message?: string };

export interface SchedulingProvider {
  /** Stable id for wiring/telemetry: "ics" | "googleTasks". */
  readonly id: "ics" | "googleTasks";
  /** i18n key resolved to a label at the UI edge via `t(...)`. */
  readonly labelKey: string;
  /** Pure predicate over context — the single availability rule. */
  isAvailable(ctx: SchedulingContext): boolean;
  /** Do the schedule: stamp the marker + award once (via the shared helper),
   *  then perform the provider-specific side effect. */
  schedule(taskId: string, ctx: SchedulingContext, opts?: ScheduleOpts): Promise<ScheduleResult>;
}
```

`ScheduleResult` is a **discriminated union on `via`** — it keeps ICS's `{ics, icsFilename}` and Google's `{scheduled, listTitle}` intact rather than forcing a lossy common shape. Callers already switch on the result; now they switch on a typed discriminant. `ScheduleFailReason` is the union of today's reasons (`not_found | not_configured | not_connected | reconnect_required | no_reclaim_list | no_steps | error`).

**Registry (static, two entries — not a plugin system):**

```ts
export const schedulingProviders: Record<"ics" | "googleTasks", SchedulingProvider> = {
  ics: icsProvider,
  googleTasks: googleTasksProvider,
};

/** The single "which methods can this workspace use?" answer. */
export function availableProviders(ctx: SchedulingContext): SchedulingProvider[] {
  return Object.values(schedulingProviders).filter((p) => p.isAvailable(ctx));
}
```

### 2. Availability rules (one predicate per provider)

- **`icsProvider.isAvailable`** → `() => true`. Universal, zero-OAuth baseline (#12 §4). Guests, owner, self-hosters — everyone.
- **`googleTasksProvider.isAvailable`** → `(ctx) => ctx.isOwner && (ctx.google?.configured ?? false)`. Owner-only **today** because Google is the singleton owner connection guests must never touch. When F (#35) lands, this predicate becomes per-user (`ctx.google` resolved for any user with their own connection) — **the only change**, no call-site churn. The `connect`/`reconnect`/`needsReconnect` nuances stay where they already live (`scheduleState`) — `isAvailable` answers "is this method offered at all," not "what's the exact button state."

This exactly reproduces today's behavior: guest → `[ics]`; owner-with-Google-configured → `[ics, googleTasks]`; owner-without-Google → `[ics]` (plus the existing Connect affordance).

### 3. How each provider implements `schedule`

Both wrap **today's action bodies unchanged** and route their first-schedule award through the shared helper (§4). The existing exported server actions become thin adapters over the providers (see §5), so the client import surface is untouched initially.

- **`icsProvider.schedule`** — the current `scheduleViaIcs` body: load task (workspace-scoped, IDOR-safe), `buildTaskIcs` (stepless → synthesize one event from `opts.durationMin`, clamp 1..480), `awardFirstSchedule(...)`, return `{ ok, via: "ics", ics, icsFilename }`.
- **`googleTasksProvider.schedule`** — the current `pushStepsToGoogleTasks` body: owner/config/token guards, `findReclaimList`, push steps, `awardFirstSchedule(...)`, return `{ ok, via: "google", scheduled, listTitle }`.
  - `scheduleSingleTask(itemId, min)` stays a **separate exported action** (it operates on a `BrainDumpItem`, lazy-creates a `Task`, and is inbox-single-row-specific). It is **not** forced under `SchedulingProvider.schedule(taskId, …)` — that would distort the interface for one caller. It still calls the shared `awardFirstSchedule` helper (§4), so reward behavior is unified even though its entry signature differs. Documented explicitly as the one intentional non-uniform entry point.

### 4. Reward integration through the seam (idempotent)

The duplicated marker+reward block collapses to **one** helper:

```ts
// src/lib/scheduling/award.ts
/**
 * First-schedule marker + reward, idempotent on Task.scheduledAt.
 * Returns whether this call was the first schedule (so callers can fold the
 * marker into an existing `task.update`, as scheduleSingleTask does).
 * Rewards are BEST-EFFORT: a logReward/awardBadge failure is logged, never thrown —
 * scheduling already committed and must not be retried (would duplicate side effects).
 */
export async function awardFirstSchedule(
  workspaceId: string,
  wasAlreadyScheduled: boolean,
): Promise<void> {
  if (wasAlreadyScheduled) return;
  const results = await Promise.allSettled([
    logReward(workspaceId, RewardType.Scheduled),
    awardBadge(workspaceId, BadgeKey.FirstSchedule),
  ]);
  for (const r of results) {
    if (r.status === "rejected") console.error("[scheduling] best-effort reward failed:", r.reason);
  }
}
```

- **Idempotency** stays keyed on the shared `scheduledAt` marker (`wasAlreadyScheduled = task.scheduledAt != null`, captured before the write) — a task scheduled by *either* method never re-awards. `awardBadge` is itself P2002-safe.
- **One error-handling style** (`allSettled` + log) replaces the current try/catch-vs-allSettled split — the ICS path adopts the more robust Google-path behavior.
- **The marker *stamp*** (`scheduledAt`/`scheduledVia`) stays at each write site because one path (`scheduleSingleTask`) folds it into the same `task.update` that sets `googleTaskId`. The seam standardizes the *reward* + the *gate contract*; it does not force a second UPDATE. This is the right-sized boundary for a "Small" item.

### 5. Refactor / migration path (incremental, no behavior change)

Ordered so every step is independently green and the diff stays reviewable. Each phase is behavior-preserving; the existing action + RTL tests are the regression net.

- **Phase A — extract the reward helper (internal only).** Add `src/lib/scheduling/award.ts` (`awardFirstSchedule`) + `SchedulingMethod`. Replace the three inline reward blocks in `ics-schedule.ts` + `google-schedule.ts` with calls to it. Zero API/UI change; all existing action tests pass unchanged. *This is the highest-value, lowest-risk commit and can ship even if later phases slip.*
- **Phase B — provider descriptors + availability.** Add `providers.ts` (`icsProvider`, `googleTasksProvider`, `schedulingProviders`, `availableProviders`, `isProviderAvailable`). Providers wrap the existing action bodies (or the actions delegate to them — either direction, pick one for a clean diff). Add unit tests for `isAvailable`.
- **Phase C — route call sites through the registry.** Replace the ad-hoc availability derivation with the seam, one file at a time:
  - `inbox/page.tsx` + `tasks/[taskId]/page.tsx` — build `SchedulingContext` once, pass `availableProviders(ctx)` (or a resolved primary/alternatives) instead of a bare `google`/`isGuest`.
  - `inbox-view.tsx`, `task-schedule.tsx`, `breakdown-chat.tsx` — choose primary vs ▾-overflow provider from the passed provider list instead of `effectiveGoogle ? … : icsProps`. `scheduleState` + `ScheduleControl` state names stay; only their *selection* moves behind the seam.
  - Each file's existing RTL test must pass **unchanged** — that is the proof of no behavior change.
- **Phase D (optional, only if cheap).** Collapse `runSchedule` + `runScheduleIcs` in `inbox-view.tsx` into one runner that switches on `result.via`. Deferrable — S1 is complete without it; skip if it grows the diff/risk.

Client action imports (`scheduleViaIcs`, `pushStepsToGoogleTasks`, `scheduleSingleTask`) remain valid throughout (they stay exported, as adapters), so no client churn is forced by the seam itself.

## Testing

- **`award.test.ts`** (new): awards `Scheduled` + `FirstSchedule` once when `wasAlreadyScheduled=false`; no-ops when `true` (idempotent); a `logReward` rejection does **not** skip `awardBadge` and does **not** throw (best-effort); returns/leaves scheduling committed.
- **`providers.test.ts`** (new): `icsProvider.isAvailable` is always true; `googleTasksProvider.isAvailable` truth table — guest → false, owner+not-configured → false, owner+configured → true; `availableProviders` returns `[ics]` for guest and `[ics, googleTasks]` for configured owner.
- **Existing action tests stay green unchanged** — `ics-schedule.test.ts`, `google-schedule.{push,single,disconnect}.test.ts`. Unchanged passing tests are the "no behavior change" evidence.
- **Existing RTL stays green unchanged** — `inbox-view.test.tsx`, `task-schedule.test.tsx`, `breakdown-chat*.test.tsx`: guest still gets ICS primary; owner still gets Google primary + ICS in ▾; "Scheduled ✓" still keys on `scheduledAt`.
- **Gates:** `tsc --noEmit`, `eslint`, full `vitest run` green.

## Rollout / risk

- No schema change, no migration, no new dependency, no user-visible change — a pure internal seam. The stored `scheduledVia="google"` value and all existing rows are untouched.
- Main risk is a subtle behavior drift during Phase C; mitigated by requiring the existing RTL/action suites to pass **without edits**. Land Phase A alone first for immediate dedup value if review time is tight.

## TDD-friendly task breakdown

1. **Marker+reward helper (Phase A).** Write `award.test.ts` (once/idempotent/best-effort) → implement `src/lib/scheduling/award.ts` + `SchedulingMethod` → refactor the three inline blocks in `ics-schedule.ts` / `google-schedule.ts` to call it. Green: `award.test.ts` + all existing action tests.
2. **Provider descriptors + availability (Phase B).** Write `providers.test.ts` (isAvailable truth table + `availableProviders`) → implement `src/lib/scheduling/providers.ts` (`icsProvider`, `googleTasksProvider`, registry, `availableProviders`/`isProviderAvailable`) wrapping the existing action bodies.
3. **Route server pages through the seam (Phase C.1).** Build `SchedulingContext` in `inbox/page.tsx` + `tasks/[taskId]/page.tsx`; pass provider availability instead of raw `google`/`isGuest`. Green: existing page/RTL tests unchanged.
4. **Route UI call sites through the seam (Phase C.2).** `inbox-view.tsx`, `task-schedule.tsx`, `breakdown-chat.tsx` select primary vs overflow provider from the passed list. Green: existing RTL tests unchanged.
5. **(Optional, Phase D)** Unify the two inbox-view runners on `result.via`. Green: existing RTL unchanged.
6. **Final verification.** `tsc --noEmit` + `eslint` + full `vitest run`; confirm no behavior change (guest = ICS only; owner = both; rewards fire once via either method).
