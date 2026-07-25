# Guest-data retention + cascade FKs + scheduled purge — plan (#21 P5)

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use `- [ ]` checkboxes.

**Goal:** Close the last real #21 residual — bound unbounded guest-counter growth (30-day purge), make `purgeWorkspace` robust via cascade FKs, and run purge on a schedule (K8s CronJob) instead of opportunistically.

**Architecture:** Age-based purge of the `ipHash`-keyed counters; `onDelete: Cascade` FKs (10 workspace-scoped models → `Workspace`, orphan-safe migration) collapsing `purgeWorkspace` to one cascade delete; a daily Helm CronJob runs a `scripts/scheduled-purge.ts` entrypoint; the opportunistic request-side trigger is removed.

**Tech Stack:** Prisma/Postgres, TypeScript, Vitest, Helm/K8s. Modified Next.js fork.

## Global Constraints
- Modified Next.js fork — no DB in the worktree → hand-author migration SQL + `npx prisma generate` (never `migrate dev`). If `tsc` errors on shared-Prisma-client staleness, run `DATABASE_URL="postgresql://u:p@localhost:5432/db" npx prisma generate` from THIS branch first.
- Workspace isolation preserved; `purgeWorkspace` must still refuse the owner workspace (`OWNER_WORKSPACE_ID`).
- Migration additive to columns + **orphan-safe** (delete orphans BEFORE `ADD CONSTRAINT`).
- Gates per task: `npx tsc --noEmit` clean · `npm run lint` 0 errors · `npx vitest run --exclude '**/*.integration.test.ts'` green. TDD; one commit/task; `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`. Do NOT merge.
- Work from `/Users/gitlab_dlectronique/workdev/dlectroflow/.claude/worktrees/guest-retention` (branch `security/guest-retention`).

## File Structure
- Modify `src/lib/purge.ts` — add `purgeStaleGuestCounters`; simplify `purgeWorkspace`.
- Modify `src/lib/purge.test.ts` — cover new + changed behavior.
- Modify `prisma/schema.prisma` + new migration dir — cascade FKs (+ verify Step/BreakdownTurn cascade from Task).
- Create `scripts/scheduled-purge.ts` — CronJob entrypoint.
- Modify `src/lib/workspace.ts` — remove the opportunistic `purgeExpiredGuests` call (+ unused import).
- Create `charts/dlectroflow/templates/purge-cronjob.yaml` + `charts/dlectroflow/values.yaml` (`purge` block).
- Modify `docs/deploy-runbook.md` — retention + CronJob section.

---

## Task 1: `purgeStaleGuestCounters` (30-day retention)
**Files:** `src/lib/purge.ts`; `src/lib/purge.test.ts`.
**Produces:** `purgeStaleGuestCounters(now?: Date, days?: number): Promise<{ dailyActivity: number; aiUsage: number }>`.

- [ ] **Step 1: Failing test** — mock `@/lib/db` prisma with `guestDailyActivity.deleteMany` + `guestAiUsage.deleteMany` (mirror the existing `purge.test.ts` mock style). Assert:
  - `GuestDailyActivity` deleted where `day < <cutoffISODate>` (cutoff = `now − days`, formatted `YYYY-MM-DD`).
  - `GuestAiUsage` deleted where `updatedAt < <cutoffDate>`.
  - returns `{ dailyActivity, aiUsage }` counts from the deleteMany results.
  - default `days = 30` when omitted.

- [ ] **Step 2:** run → RED. **Step 3: Implement** (append to `purge.ts`):
```ts
/** Purge ipHash-keyed guest counters older than `days` (default 30). These are
 * not workspace-scoped (keyed by IP hash), so they need age-based retention. */
export async function purgeStaleGuestCounters(
  now: Date = new Date(),
  days = 30,
): Promise<{ dailyActivity: number; aiUsage: number }> {
  const cutoff = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
  const cutoffDay = cutoff.toISOString().slice(0, 10); // YYYY-MM-DD (day column is UTC date string)
  const [daily, ai] = await prisma.$transaction([
    prisma.guestDailyActivity.deleteMany({ where: { day: { lt: cutoffDay } } }),
    prisma.guestAiUsage.deleteMany({ where: { updatedAt: { lt: cutoff } } }),
  ]);
  return { dailyActivity: daily.count, aiUsage: ai.count };
}
```
- [ ] **Step 4:** run → GREEN; tsc/lint. **Step 5: Commit** `feat(#21): purgeStaleGuestCounters — 30-day guest-counter retention`.

---

## Task 2: Cascade FKs (orphan-safe) + simplify purgeWorkspace
**Files:** `prisma/schema.prisma`; `prisma/migrations/20260718180000_workspace_cascade_fks/migration.sql`; `src/lib/purge.ts`; `src/lib/purge.test.ts`.

- [ ] **Step 1: Schema** — add to each of these 10 models a Workspace relation with cascade, and the back-relation on `Workspace`:
  Models (all have `workspaceId String`): **Settings** (workspaceId `@unique` → one-to-one), **BrainDumpItem, Task, FocusSession, DayRollup, RewardEvent, StreakRecord, Badge, DailySpark** (one-to-many), **Streak** (workspaceId `@unique` → one-to-one).
  On each model add:
  `workspace Workspace @relation(fields: [workspaceId], references: [id], onDelete: Cascade)`
  On `Workspace` add the back-relations (names your choice, e.g. `settings Settings?`, `streak Streak?`, `brainDumpItems BrainDumpItem[]`, `tasks Task[]`, `focusSessions FocusSession[]`, `dayRollups DayRollup[]`, `rewardEvents RewardEvent[]`, `streakRecords StreakRecord[]`, `badges Badge[]`, `dailySparks DailySpark[]`).
  **Also verify** `Step` + `BreakdownTurn` relations to `Task` are `onDelete: Cascade` (so a cascaded Task delete removes them). If not, add `onDelete: Cascade` to those `task` relations too — the end-to-end cascade depends on it.

- [ ] **Step 2: Migration** — create `prisma/migrations/20260718180000_workspace_cascade_fks/migration.sql`. For EACH of the 10 tables (and any Step/BreakdownTurn FK you had to change), emit, in this order:
```sql
-- <Table>: drop orphans, then add cascade FK
DELETE FROM "<Table>" WHERE "workspaceId" NOT IN (SELECT "id" FROM "Workspace");
ALTER TABLE "<Table>" ADD CONSTRAINT "<Table>_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
```
(If a table already had a workspaceId FK without cascade — it doesn't today — you'd `DROP CONSTRAINT` first; confirm none exist via the schema before this migration.) For Step/BreakdownTurn cascade changes, emit the matching `DROP CONSTRAINT ..._taskId_fkey` + re-`ADD` with `ON DELETE CASCADE`. Then `npx prisma generate`.

- [ ] **Step 3: Simplify `purgeWorkspace`** in `purge.ts` — replace the hand-coded per-model `deleteMany` block with a cascade delete (keep the owner guard):
```ts
export async function purgeWorkspace(id: string): Promise<void> {
  if (id === OWNER_WORKSPACE_ID) throw new Error("refusing to purge the owner workspace");
  await prisma.workspace.delete({ where: { id } }); // cascade removes all workspace-scoped rows + Task children
}
```
- [ ] **Step 4: Update `purge.test.ts`** — assert `purgeWorkspace` refuses owner + calls `workspace.delete({ where: { id } })` (cascade is a DB concern; the unit test asserts the single delete + the guard). Keep `purgeExpiredGuests` tests.
- [ ] **Step 5:** tsc/lint/vitest green. **Step 6: Commit** `feat(#21): cascade FKs (workspace-scoped models) + orphan-safe migration; purgeWorkspace = cascade delete`.

> RISK: the orphan-delete MUST precede each `ADD CONSTRAINT`. Reviewer verifies ordering + that every model in the old hand-coded list is covered by a cascade path (direct FK, or via Task for Step/BreakdownTurn).

---

## Task 3: Scheduled-purge entrypoint + remove opportunistic trigger
**Files:** create `scripts/scheduled-purge.ts`; modify `src/lib/workspace.ts`.

- [ ] **Step 1:** Create `scripts/scheduled-purge.ts`:
```ts
/** CronJob entrypoint: purge expired guest workspaces + stale guest counters.
 * Exits non-zero on failure so the CronJob surfaces errors. */
import { purgeExpiredGuests, purgeStaleGuestCounters } from "../src/lib/purge";

async function main() {
  let guestsPurged = 0;
  // purgeExpiredGuests is bounded (25/call); loop until drained (cap iterations).
  for (let i = 0; i < 200; i++) {
    const n = await purgeExpiredGuests();
    guestsPurged += n;
    if (n === 0) break;
  }
  const counters = await purgeStaleGuestCounters();
  console.log(JSON.stringify({ tag: "scheduled_purge", guestsPurged, ...counters }));
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
```
Confirm the import path/alias works under `npx tsx` (use a relative import as shown if the `@/` alias isn't resolved in a bare script; verify by running it — it will connect to no DB locally, so expect a connection error, which still proves it loads/compiles).

- [ ] **Step 2:** In `src/lib/workspace.ts`, remove the opportunistic line `void purgeExpiredGuests().catch(() => {});` (line ~63) and drop `purgeExpiredGuests` from its import (keep `guestSandboxTtlHours`). The CronJob is now the sole trigger.

- [ ] **Step 3:** Add a `package.json` script: `"purge:scheduled": "tsx scripts/scheduled-purge.ts"` (confirm `tsx` is available as a dep/devDep; if not, use `node --import tsx` or the project's existing script runner — check how other scripts run).

- [ ] **Step 4:** tsc/lint/vitest green (the removed opportunistic call shouldn't break tests; if a workspace.ts test asserted it, update). **Step 5: Commit** `feat(#21): scheduled-purge entrypoint + drop opportunistic guest purge`.

---

## Task 4: Helm CronJob + values + runbook
**Files:** create `charts/dlectroflow/templates/purge-cronjob.yaml`; modify `charts/dlectroflow/values.yaml`; modify `docs/deploy-runbook.md`.

- [ ] **Step 1:** Read `charts/dlectroflow/templates/backup.yaml` for the exact prod-gating + securityContext + DB-secret env pattern. Create `purge-cronjob.yaml` — a SINGLE-container CronJob (no gcloud/Workload-Identity needed; it only needs `DATABASE_URL`):
  - Gate: `{{- if and .Values.purge.enabled (eq .Values.env "production") }}`.
  - `kind: CronJob`, name `dlectroflow-guest-purge`, `schedule: {{ .Values.purge.schedule | quote }}`, `timeZone: Etc/UTC`, `concurrencyPolicy: Forbid`, history limits, `activeDeadlineSeconds`, `backoffLimit`.
  - Pod: same hardened `securityContext` as backup; `restartPolicy: Never`; one container using the app image (`{{ .Values.image.repository }}:{{ .Values.image.tag }}` — match how the app deployment references the image), `command: ["npx","tsx","scripts/scheduled-purge.ts"]` (or `["npm","run","purge:scheduled"]`), and `env` for `DATABASE_URL` sourced from the SAME secret/key the app Deployment uses (grep the deployment for the DATABASE_URL env source) incl. `sslmode=require` parity.
- [ ] **Step 2:** `values.yaml` — add:
```yaml
purge:
  enabled: true
  schedule: "30 3 * * *"   # daily 03:30 UTC, after the 03:00 backup
```
- [ ] **Step 3:** `docs/deploy-runbook.md` — a short section: what the guest-purge CronJob does, the 30-day retention policy, the `scheduled_purge` log tag, and how to run it manually (`kubectl create job --from=cronjob/dlectroflow-guest-purge …`).
- [ ] **Step 4:** Validate: `helm template charts/dlectroflow --set env=production` renders the CronJob (and omits it when `purge.enabled=false` / non-prod). `helm lint` clean. **Step 5: Commit** `feat(#21): daily guest-purge CronJob + retention runbook`.

---

## Task 5: Gates + push + MR
- [ ] **Step 1:** Full gates from the worktree: `npx tsc --noEmit` · `npm run lint` · `npx vitest run --exclude '**/*.integration.test.ts'` · `npm run build` · `helm template`/`helm lint`. Record vitest count.
- [ ] **Step 2:** Push `security/guest-retention`; open the MR (CONFIDENTIAL context #21; @GitLabDuo reviewer; note the FK-migration orphan-safety as the key review focus). Do NOT merge.
- [ ] **Step 3:** After merge (owner) + prod-deploy: verify the CronJob runs + the `scheduled_purge` log appears; then close #21 (migrate residuals: migrate-hook → #15, Sentry → declined note, DB enums → hardening backlog).

## Self-Review (author)
- **Spec coverage:** 30d retention (T1); cascade FKs orphan-safe + purgeWorkspace simplify (T2); scheduled entrypoint + de-opportunistic (T3); CronJob + runbook (T4); gates/MR (T5). ✓
- **Types:** `purgeStaleGuestCounters` signature consistent T1↔T3; `purgeWorkspace`/`purgeExpiredGuests` names stable.
- **Risks:** FK migration orphan-ordering (T2) is the top risk — reviewer + owner eyeball the SQL. Step/BreakdownTurn cascade-from-Task must be verified (T2 Step 1) or the workspace cascade won't fully clean tasks' children.
