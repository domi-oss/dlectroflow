# Guest-data retention + cascade FKs + scheduled purge — design (#21 P5)

**Date:** 2026-07-18
**Branch / MR:** `security/guest-retention` → new MR (closes the last real #21 residual), CONFIDENTIAL context (#21)
**Status:** approved (owner decisions below), pending spec review
**Milestone:** none required (security remediation; not a release feature)

## Context
Final open "real" item on #21 (blind-spot audit remediation). Today: `GuestAiUsage` + `GuestDailyActivity` (both `ipHash`-keyed anti-abuse counters) have **no deletion path → grow forever**; `purgeWorkspace` is a **hand-coded 12-model** transaction with **no FKs** (fragile — a new workspace-scoped model silently leaks on purge); and guest purge runs **opportunistically** (request side-effect) rather than scheduled. Prod holds real data.

## Owner decisions (2026-07-18)
1. **Retention window: 30 days** for the ipHash-keyed guest counters.
2. **Scheduling: a K8s CronJob** (mirrors the pg_dump backup CronJob pattern), daily.
3. **Cascade FKs: include now, orphan-safe** — add `onDelete: Cascade` FKs (workspace-scoped models → `Workspace`) with a migration that removes orphans before adding the constraint.

## Design

### 1. Retention purge for ipHash counters (`src/lib/purge.ts`)
Add `purgeStaleGuestCounters(now = new Date(), days = 30): Promise<{ dailyActivity: number; aiUsage: number }>`:
- `GuestDailyActivity`: delete where `day < <YYYY-MM-DD of (now − 30d)>` (string compare on the `day` column, which is `YYYY-MM-DD` UTC — lexicographic = chronological).
- `GuestAiUsage`: delete where `updatedAt < now − 30d`.
Pure, workspace-agnostic (these are IP-keyed), returns counts for logging.

### 2. Cascade FKs (schema + orphan-safe migration)
Add a `Workspace` relation with `onDelete: Cascade` to every model with a `workspaceId` column. From `purgeWorkspace` + a schema grep, the set is: **BrainDumpItem, Task, FocusSession, DayRollup, RewardEvent, Streak, StreakRecord, Badge, DailySpark, Settings** (confirm the exact list by grepping `workspaceId ` in `prisma/schema.prisma` at plan time). `Step`/`BreakdownTurn` already cascade from `Task`.
- Schema: add `workspace Workspace @relation(fields: [workspaceId], references: [id], onDelete: Cascade)` to each; add the reverse relation arrays on `Workspace`.
- **Migration (orphan-safe, hand-authored — no DB in worktree):** for each table, first `DELETE FROM "<T>" WHERE "workspaceId" NOT IN (SELECT id FROM "Workspace");` then `ALTER TABLE "<T>" ADD CONSTRAINT "<T>_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"(id) ON DELETE CASCADE;`. (Prisma's generated migration will produce the constraint DDL; prepend the orphan-delete statements.) Additive to columns (no column type change).
- **Simplify `purgeWorkspace`** to rely on the cascade: keep the owner-guard, then `await prisma.workspace.delete({ where: { id } })` (cascade removes all children). Keep it in a `$transaction` if desired; drop the hand-coded per-model `deleteMany` list. This is the robustness win.

### 3. Scheduled CronJob (Helm) + purge entrypoint
- **Entrypoint:** a Node script `scripts/scheduled-purge.ts` (run in the app image) that calls `purgeExpiredGuests()` + `purgeStaleGuestCounters()` and logs structured counts (tag `scheduled_purge`). Runnable via `npx tsx scripts/scheduled-purge.ts` (or a `package.json` script `purge:scheduled`). Must exit non-zero on failure so the CronJob surfaces errors.
- **CronJob:** `charts/dlectroflow/templates/purge-cronjob.yaml` mirroring the existing backup CronJob (`charts/dlectroflow/templates/*backup*` — read it for the exact pattern: serviceAccount/Workload Identity, image, env incl. `DATABASE_URL` from the same secret, `restartPolicy`, `concurrencyPolicy: Forbid`, resource limits). Schedule daily (e.g. `30 3 * * *` UTC, after the 03:00 backup). Values-gated (`.Values.purge.enabled`, default true) + documented in the deploy runbook.
- **Move opportunistic → scheduled:** find the request-side caller of `purgeExpiredGuests` (grep) and remove that opportunistic trigger (the CronJob is now primary). Keep the function itself (the CronJob calls it).

## Components & boundaries
- `src/lib/purge.ts` — add `purgeStaleGuestCounters`; simplify `purgeWorkspace` to cascade; keep `purgeExpiredGuests`.
- `scripts/scheduled-purge.ts` — CLI entrypoint (expired guests + stale counters + structured logging).
- `prisma/schema.prisma` + migration — cascade FKs (orphan-safe).
- `charts/dlectroflow/templates/purge-cronjob.yaml` + `values.yaml` (`purge.enabled`, schedule) — daily CronJob.
- Remove the opportunistic `purgeExpiredGuests` request-side call.
- `docs/deploy-runbook.md` — document the purge CronJob + retention policy.

## Testing
Unit (vitest, mock prisma like `snooze.test.ts`):
- `purgeStaleGuestCounters`: deletes GuestDailyActivity with `day` older than the 30-day cutoff (and keeps newer); deletes GuestAiUsage with `updatedAt` older than cutoff; returns counts; boundary (exactly 30d) behavior explicit.
- `purgeWorkspace`: still refuses the owner workspace; issues the `workspace.delete` (cascade) — assert it deletes the workspace (and, with FKs, children go via cascade — assert the delete call, not each model).
- `purgeExpiredGuests`: unchanged behavior (finds expired guests, purges, bounded, best-effort).
- The migration's orphan-delete + FK DDL reviewed for correctness (SQL inspected in review).
Gates: `tsc` clean · `lint` 0 errors · `vitest` (exclude integration) green · `next build` compiles · `helm template`/lint the chart if available. No DB in worktree → hand-author migration + `prisma generate`.

## Risks / call-outs
- **FK migration on real prod data** is the highest-risk step: orphan rows must be deleted BEFORE the constraint (migration ordering), or the `ALTER TABLE ADD CONSTRAINT` fails. Orphans should be rare (purgeWorkspace already deletes children first), but the guard is mandatory. Flag for careful review + a note in the runbook.
- **`purgeWorkspace` simplification** changes deletion semantics from explicit deletes to DB cascade — verify every current model in the hand-coded list has (a) a `workspaceId` FK with cascade, or (b) cascades transitively (Step/BreakdownTurn via Task). Any model WITHOUT a cascade path must stay in an explicit delete or get an FK. Enumerate at plan time.
- **CronJob DB access:** reuse the backup CronJob's DB connectivity (same secret/`sslmode`); the purge runs Prisma against the in-cluster Postgres over TLS.
- Guest counters are IP-keyed (no workspace link) → deliberately purged by AGE, not cascade.

## #21 close (after this MR)
This closes the last "real" residual. Remaining #21 items to migrate/decline at close: migrate-hook → #15; Sentry → decline (optional at scale, note); DB pseudo-enums → hardening backlog issue.
