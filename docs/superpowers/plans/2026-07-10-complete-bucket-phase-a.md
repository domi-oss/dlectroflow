# Complete + Completed bucket (Phase A) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the user mark work as done from the inbox and the task page; finished things collect in a unified **Completed** bucket, driven by one `BrainDumpItem.completedAt` timestamp, and feed points/badge/streak.

**Architecture:** A single nullable `completedAt` column is the sole "is completed" signal. Three workspace-scoped server actions (`completeItem`, `reopenItem`, `completeStep`) set/clear it and keep `Task.status`/steps consistent; a shared `rewardStepDone` helper keeps the focus-timer and direct-complete reward paths identical. `bucketItems` gains a `completed` bucket + `completedTodayCount` and excludes completed items from the active buckets. The inbox renders Complete buttons + a Completed section with an Undo picker; the task page's `TaskSteps` (from !28) gains a per-step ✓ Complete.

**Tech Stack:** Next.js 16 (modified — read `node_modules/next/dist/docs/` before App Router APIs; `params`/`searchParams` are Promises), React server + client components, Prisma (Postgres prod / SQLite dev; statuses are plain strings), Vitest + RTL (jsdom), Tailwind.

## Global Constraints

- **Plain voice 100% emoji-free** (functional glyphs only: 🟢🟡🟠🔴 ✅ ▶ ⏸ ➕ ➖ 🗑️ 🔒 ⚠️ ✓ →). Every new user-facing string via `t(key, voice)` with a `{plain, playful}` entry in `src/lib/strings.ts`.
- **Workspace scoping mandatory** on every read/write: resolve `currentWorkspaceId()`; gate reads with `findFirst({ where: { id, workspaceId } })` (or `task: { workspaceId }` for steps) before writing.
- **Migrations additive, Postgres + SQLite safe**, raw-SQL style matching `prisma/migrations/`. Run `npx prisma generate` after schema edits.
- **`completedAt` is the single done-signal.** `Task.status="done"` is still set for multi-step tasks, but the inbox reads `completedAt`.
- **Idempotent completion:** actions no-op / don't double-award when `completedAt` is already set.
- **Rewards are append-only** — reopen never claws back points.
- **TDD:** failing test → run (fail) → minimal impl → run (pass) → commit. `npx vitest run`, `npx tsc --noEmit`, `npm run build` green before the MR.
- **Component tests** need `// @vitest-environment jsdom` (first line) + `afterEach(cleanup)` (no `globals:true`).
- **Reward values:** `StepDone=10`, `SessionFinished=5`, `TaskComplete=25` (new). Direct step-complete awards StepDone (+streak +ten_steps_day) but **not** SessionFinished.
- **Completed bucket:** 10 most recent (by `completedAt` desc) + `completedTodayCount`; `see all →` deep-links `/library?tab=done` (Phase-3 stub, already 404-safe).

## File Structure

| File | Responsibility | Action |
|---|---|---|
| `prisma/schema.prisma` | `BrainDumpItem.completedAt` | Modify |
| `prisma/migrations/<ts>_completed_at/migration.sql` | additive column | Create |
| `src/lib/constants.ts` | `RewardType.TaskComplete`, `RewardPoints.task_complete=25`, `BadgeKey.TaskComplete` | Modify |
| `src/lib/rewards.ts` | `rewardStepDone(workspaceId)` shared helper | Modify |
| `src/app/actions/focus.ts` | `completeFocus` uses helper; new `completeStep` | Modify |
| `src/app/actions/braindump.ts` | `completeItem`, `reopenItem` | Modify |
| `src/app/actions/complete.test.ts` | action tests | Create |
| `src/components/inbox/bucket.ts` (+ `bucket.test.ts`) | `completed` bucket, `completedTodayCount`, exclusions, `completedAt` on `Item` | Modify |
| `src/lib/strings.ts` (+ `strings.test.ts`) | `action.complete`, `action.reopen`, `section.completed`, `section.completedToday` | Modify |
| `src/app/(app)/inbox/page.tsx` | map `completedAt` + per-item `steps` | Modify |
| `src/components/inbox/inbox-view.tsx` (+ `inbox-view.test.tsx`) | Complete buttons, Completed section, Undo picker | Modify |
| `src/components/breakdown/task-steps.tsx` (+ `task-steps.test.tsx`) | per-step ✓ Complete → `completeStep` | Modify |

---

### Task 1: Schema — `completedAt` column

**Files:**
- Modify: `prisma/schema.prisma` (model `BrainDumpItem`)
- Create: `prisma/migrations/<timestamp>_completed_at/migration.sql`

**Interfaces:**
- Produces: `BrainDumpItem.completedAt: DateTime?`

- [ ] **Step 1: Add the column to `schema.prisma`.** In `model BrainDumpItem`, below `promptDismissedAt DateTime?`, add:
```prisma
  completedAt      DateTime?
```

- [ ] **Step 2: Create the migration.** New file `prisma/migrations/<timestamp>_completed_at/migration.sql` (use a timestamp after the latest existing migration; match the existing `TIMESTAMP` token used by prior migrations):
```sql
-- BrainDumpItem: unified completion signal
ALTER TABLE "BrainDumpItem" ADD COLUMN "completedAt" TIMESTAMP;
```

- [ ] **Step 3: Regenerate the client.** Run: `npx prisma generate` — Expected: succeeds; `PrismaClient` types include `completedAt`.

- [ ] **Step 4: Apply locally.** Run: `export PATH="$HOME/.rd/bin:$PATH"; export DOCKER_HOST="unix://$HOME/.rd/docker.sock"; docker compose up -d db && npx prisma migrate deploy` — Expected: migration applies cleanly.

- [ ] **Step 5: Commit.**
```bash
git add prisma/schema.prisma prisma/migrations
git commit -m "feat(schema): add BrainDumpItem.completedAt (unified completion signal)"
```

---

### Task 2: Constants + rewards — `TaskComplete` + `rewardStepDone` helper

**Files:**
- Modify: `src/lib/constants.ts`
- Modify: `src/lib/rewards.ts`
- Modify: `src/app/actions/focus.ts` (route `completeFocus` through the helper — behavior-preserving)

**Interfaces:**
- Produces:
  - `RewardType.TaskComplete = "task_complete"`; `RewardPoints.task_complete = 25`
  - `BadgeKey.TaskComplete = "task_complete"`
  - `rewardStepDone(workspaceId: string): Promise<StreakUpdate | null>` (in `rewards.ts`) — logs `StepDone`, touches the streak, awards `TenStepsDay` when ≥10 steps today; returns the streak update.

- [ ] **Step 1: Add the reward type + points.** In `src/lib/constants.ts`, add to `RewardType`:
```ts
  TaskComplete: "task_complete",
```
and to `RewardPoints`:
```ts
  task_complete: 25,
```

- [ ] **Step 2: Add the badge key.** In `src/lib/constants.ts`, add to `BadgeKey`:
```ts
  TaskComplete: "task_complete",
```
(The `badge.task_complete` string already exists in `strings.ts`, satisfying the `strings.test.ts` BadgeKey-coverage loop.)

- [ ] **Step 3: Verify types.** Run: `npx tsc --noEmit` — Expected: PASS (RewardPoints is `Record<RewardType, number>`; the new key is required and now present).

- [ ] **Step 4: Extract `rewardStepDone` in `rewards.ts`.** Add (near `touchStreakOnCompletion`), importing `startOfToday` is already local:
```ts
/**
 * Shared "a step got done" reward path — used by finishing a focus session AND
 * by completing a step directly. Logs StepDone, extends the streak, and awards
 * the ten-steps-in-a-day badge. Does NOT log SessionFinished (that is the focus
 * timer's own bonus).
 */
export async function rewardStepDone(workspaceId: string): Promise<StreakUpdate | null> {
  await logReward(workspaceId, RewardType.StepDone);
  const streak = await touchStreakOnCompletion(workspaceId);
  const stepsToday = await prisma.rewardEvent.count({
    where: { workspaceId, type: RewardType.StepDone, createdAt: { gte: startOfToday() } },
  });
  if (stepsToday >= 10) await awardBadge(workspaceId, BadgeKey.TenStepsDay);
  return streak;
}
```

- [ ] **Step 5: Route `completeFocus` through the helper (behavior-preserving).** In `src/app/actions/focus.ts`, replace the reward block (currently `logReward(StepDone)` + `logReward(SessionFinished)` + `touchStreakOnCompletion` + the `stepsToday`/`TenStepsDay` check) with:
```ts
  // Points + streak + badges (dashboard reads these).
  const streak = await rewardStepDone(workspaceId);
  await logReward(workspaceId, RewardType.SessionFinished);
```
Add `rewardStepDone` to the existing `@/lib/rewards` import; remove the now-unused local `dayStart`/`stepsToday`/`TenStepsDay` lines and the standalone `const streak = await touchStreakOnCompletion(...)`. Keep everything else (the `next` step lookup, `revalidatePath`, return shape) unchanged.

- [ ] **Step 6: Run the existing focus tests + types.** Run: `npx vitest run src/app/actions && npx tsc --noEmit` — Expected: PASS (completeFocus behavior unchanged; existing tests green).

- [ ] **Step 7: Commit.**
```bash
git add src/lib/constants.ts src/lib/rewards.ts src/app/actions/focus.ts
git commit -m "feat(rewards): TaskComplete reward/badge + shared rewardStepDone helper"
```

---

### Task 3: `completeItem` action

**Files:**
- Modify: `src/app/actions/braindump.ts`
- Create: `src/app/actions/complete.test.ts`

**Interfaces:**
- Consumes: `rewardStepDone` (Task 2), `RewardType.TaskComplete`, `BadgeKey.TaskComplete`, `TaskStatus`.
- Produces: `completeItem(id: string): Promise<void>` — stamps `completedAt`; for a task-linked item, marks all steps + the task done and credits `StepDone` per not-done step; awards `TaskComplete` (25) + badge + streak; idempotent; workspace-scoped.

- [ ] **Step 1: Write the failing test.** Create `src/app/actions/complete.test.ts` (mirror the mock shape in `breakdown-extract.test.ts`):
```ts
import { describe, it, expect, vi, beforeEach } from "vitest";

const { prismaMock, revalidatePathMock, currentWorkspaceIdMock } = vi.hoisted(() => {
  const prismaMock = {
    brainDumpItem: {
      findFirst: vi.fn(),
      update: vi.fn().mockResolvedValue({}),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    step: { updateMany: vi.fn().mockResolvedValue({ count: 0 }), update: vi.fn(), findFirst: vi.fn() },
    task: { update: vi.fn().mockResolvedValue({}) },
    rewardEvent: { create: vi.fn().mockResolvedValue({}), count: vi.fn().mockResolvedValue(0) },
    badge: { findUnique: vi.fn().mockResolvedValue(null), create: vi.fn().mockResolvedValue({}) },
    streak: {}, settings: {}, streakRecord: {},
  };
  return { prismaMock, revalidatePathMock: vi.fn(), currentWorkspaceIdMock: vi.fn().mockResolvedValue("owner") };
});
vi.mock("next/cache", () => ({ revalidatePath: revalidatePathMock }));
vi.mock("@/lib/db", () => ({ prisma: prismaMock }));
vi.mock("@/lib/workspace", () => ({
  currentWorkspaceId: currentWorkspaceIdMock,
  isOwnerRequest: vi.fn().mockResolvedValue(true),
  MissingWorkspaceError: class extends Error {},
}));
// keep reward side-effects simple + observable
vi.mock("@/lib/rewards", () => ({
  logReward: vi.fn().mockResolvedValue(undefined),
  awardBadge: vi.fn().mockResolvedValue(true),
  rewardStepDone: vi.fn().mockResolvedValue(null),
  touchStreakOnCompletion: vi.fn().mockResolvedValue(null),
  maybeAwardInboxZero: vi.fn().mockResolvedValue(undefined),
}));
import { logReward, awardBadge } from "@/lib/rewards";

beforeEach(() => {
  vi.clearAllMocks();
  currentWorkspaceIdMock.mockResolvedValue("owner");
});

describe("completeItem", () => {
  it("no-ops when the item is missing or already completed", async () => {
    prismaMock.brainDumpItem.findFirst.mockResolvedValueOnce(null);
    const { completeItem } = await import("./braindump");
    await completeItem("x");
    expect(prismaMock.brainDumpItem.update).not.toHaveBeenCalled();

    prismaMock.brainDumpItem.findFirst.mockResolvedValueOnce({ id: "i1", completedAt: new Date(), task: null });
    await completeItem("i1");
    expect(prismaMock.brainDumpItem.update).not.toHaveBeenCalled();
  });

  it("stamps completedAt + awards TaskComplete for a single-task item (no task)", async () => {
    prismaMock.brainDumpItem.findFirst.mockResolvedValueOnce({ id: "i1", completedAt: null, task: null });
    const { completeItem } = await import("./braindump");
    await completeItem("i1");
    const upd = prismaMock.brainDumpItem.update.mock.calls[0][0];
    expect(upd.where).toEqual({ id: "i1" });
    expect(upd.data.completedAt).toBeInstanceOf(Date);
    expect(logReward).toHaveBeenCalledWith("owner", "task_complete");
    expect(awardBadge).toHaveBeenCalledWith("owner", "task_complete");
  });

  it("completes a multi-step task: all steps + task done, credits StepDone per not-done step", async () => {
    prismaMock.brainDumpItem.findFirst.mockResolvedValueOnce({
      id: "i2", completedAt: null,
      task: { id: "t1", steps: [{ id: "s1", done: true }, { id: "s2", done: false }, { id: "s3", done: false }] },
    });
    const { completeItem } = await import("./braindump");
    await completeItem("i2");
    expect(prismaMock.step.updateMany).toHaveBeenCalledWith({ where: { taskId: "t1" }, data: { done: true } });
    expect(prismaMock.task.update).toHaveBeenCalledWith({ where: { id: "t1" }, data: { status: "done" } });
    // 2 not-done steps → 2 StepDone + 1 TaskComplete
    const stepDoneCalls = (logReward as unknown as ReturnType<typeof vi.fn>).mock.calls.filter((c) => c[1] === "step_done");
    expect(stepDoneCalls).toHaveLength(2);
    expect(logReward).toHaveBeenCalledWith("owner", "task_complete");
  });

  it("is workspace-scoped (findFirst gated on workspaceId)", async () => {
    prismaMock.brainDumpItem.findFirst.mockResolvedValueOnce({ id: "i1", completedAt: null, task: null });
    const { completeItem } = await import("./braindump");
    await completeItem("i1");
    expect(prismaMock.brainDumpItem.findFirst.mock.calls[0][0].where).toEqual({ id: "i1", workspaceId: "owner" });
  });
});
```

- [ ] **Step 2: Run to verify fail.** Run: `npx vitest run src/app/actions/complete.test.ts` — Expected: FAIL (`completeItem` not exported).

- [ ] **Step 3: Implement in `src/app/actions/braindump.ts`.** Add imports at top (extend existing): `RewardType`, `BadgeKey` from `@/lib/constants`; `logReward`, `awardBadge`, `touchStreakOnCompletion` from `@/lib/rewards`. Add:
```ts
export async function completeItem(id: string) {
  const workspaceId = await currentWorkspaceId();
  const item = await prisma.brainDumpItem.findFirst({
    where: { id, workspaceId },
    include: { task: { include: { steps: true } } },
  });
  if (!item || item.completedAt) return;

  if (item.task) {
    const notDone = item.task.steps.filter((s) => !s.done);
    await prisma.step.updateMany({ where: { taskId: item.task.id }, data: { done: true } });
    await prisma.task.update({ where: { id: item.task.id }, data: { status: TaskStatus.Done } });
    for (let n = 0; n < notDone.length; n++) await logReward(workspaceId, RewardType.StepDone);
  }

  await prisma.brainDumpItem.update({ where: { id }, data: { completedAt: new Date() } });
  await logReward(workspaceId, RewardType.TaskComplete);
  await touchStreakOnCompletion(workspaceId);
  await awardBadge(workspaceId, BadgeKey.TaskComplete);

  revalidatePath(INBOX_PATH);
  revalidatePath("/dashboard");
  if (item.task) revalidatePath(`/tasks/${item.task.id}`);
}
```

- [ ] **Step 4: Run to verify pass.** Run: `npx vitest run src/app/actions/complete.test.ts` — Expected: PASS.

- [ ] **Step 5: Commit.**
```bash
git add src/app/actions/braindump.ts src/app/actions/complete.test.ts
git commit -m "feat(actions): completeItem — stamp completedAt, finish task+steps, award TaskComplete"
```

---

### Task 4: `reopenItem` action

**Files:**
- Modify: `src/app/actions/braindump.ts`
- Modify: `src/app/actions/complete.test.ts`

**Interfaces:**
- Produces: `reopenItem(id: string, stepIds?: string[]): Promise<void>` — clears `completedAt`; for a task-linked item, reactivates the task and resets the chosen steps (empty/omitted ⇒ all), guaranteeing ≥1 not-done step; workspace-scoped.

- [ ] **Step 1: Write the failing test.** Append to `src/app/actions/complete.test.ts`:
```ts
describe("reopenItem", () => {
  it("clears completedAt for a single-task item", async () => {
    prismaMock.brainDumpItem.findFirst.mockResolvedValueOnce({ id: "i1", task: null });
    const { reopenItem } = await import("./braindump");
    await reopenItem("i1");
    expect(prismaMock.brainDumpItem.update).toHaveBeenCalledWith({ where: { id: "i1" }, data: { completedAt: null } });
  });

  it("reopens a multi-step task: reactivates + resets selected steps", async () => {
    prismaMock.brainDumpItem.findFirst.mockResolvedValueOnce({
      id: "i2", task: { id: "t1", steps: [{ id: "s1", done: true }, { id: "s2", done: true }] },
    });
    const { reopenItem } = await import("./braindump");
    await reopenItem("i2", ["s2"]);
    expect(prismaMock.task.update).toHaveBeenCalledWith({ where: { id: "t1" }, data: { status: "active" } });
    expect(prismaMock.step.updateMany).toHaveBeenCalledWith({ where: { id: { in: ["s2"] } }, data: { done: false } });
  });

  it("empty stepIds resets ALL steps (whole-task reopen)", async () => {
    prismaMock.brainDumpItem.findFirst.mockResolvedValueOnce({
      id: "i3", task: { id: "t2", steps: [{ id: "a", done: true }, { id: "b", done: true }] },
    });
    const { reopenItem } = await import("./braindump");
    await reopenItem("i3", []);
    expect(prismaMock.step.updateMany).toHaveBeenCalledWith({ where: { id: { in: ["a", "b"] } }, data: { done: false } });
  });

  it("guards ≥1 not-done: a subset covering nothing also resets the last step", async () => {
    prismaMock.brainDumpItem.findFirst.mockResolvedValueOnce({
      id: "i4", task: { id: "t3", steps: [{ id: "a", done: true }, { id: "b", done: true }] },
    });
    const { reopenItem } = await import("./braindump");
    await reopenItem("i4", ["missing"]); // covers no real steps → all still done → add last
    const call = prismaMock.step.updateMany.mock.calls[0][0];
    expect(call.data).toEqual({ done: false });
    expect(call.where.id.in).toContain("b"); // last step forced not-done
  });
});
```

- [ ] **Step 2: Run to verify fail.** Run: `npx vitest run src/app/actions/complete.test.ts` — Expected: FAIL (`reopenItem` not exported).

- [ ] **Step 3: Implement in `src/app/actions/braindump.ts`.**
```ts
export async function reopenItem(id: string, stepIds?: string[]) {
  const workspaceId = await currentWorkspaceId();
  const item = await prisma.brainDumpItem.findFirst({
    where: { id, workspaceId },
    include: { task: { include: { steps: true } } },
  });
  if (!item) return;

  await prisma.brainDumpItem.update({ where: { id }, data: { completedAt: null } });

  if (item.task) {
    const steps = item.task.steps;
    await prisma.task.update({ where: { id: item.task.id }, data: { status: TaskStatus.Active } });
    const resetIds = new Set(
      stepIds && stepIds.length
        ? steps.filter((s) => stepIds.includes(s.id)).map((s) => s.id)
        : steps.map((s) => s.id),
    );
    // Guarantee ≥1 not-done step so the task re-enters To-do.
    const anyNotDone = steps.some((s) => resetIds.has(s.id) || !s.done);
    if (!anyNotDone && steps.length) resetIds.add(steps[steps.length - 1].id);
    if (resetIds.size) {
      await prisma.step.updateMany({ where: { id: { in: [...resetIds] } }, data: { done: false } });
    }
  }

  revalidatePath(INBOX_PATH);
  revalidatePath("/dashboard");
  if (item.task) revalidatePath(`/tasks/${item.task.id}`);
}
```

- [ ] **Step 4: Run to verify pass.** Run: `npx vitest run src/app/actions/complete.test.ts` — Expected: PASS.

- [ ] **Step 5: Commit.**
```bash
git add src/app/actions/braindump.ts src/app/actions/complete.test.ts
git commit -m "feat(actions): reopenItem — clear completedAt, reactivate task, reset chosen steps"
```

---

### Task 5: `completeStep` action (direct step complete, no timer)

**Files:**
- Modify: `src/app/actions/focus.ts`
- Modify: `src/app/actions/complete.test.ts`

**Interfaces:**
- Consumes: `rewardStepDone` (Task 2), `completeGoogleTaskForStep` (existing in `focus.ts`), `RewardType.TaskComplete`, `BadgeKey.TaskComplete`.
- Produces: `completeStep(stepId: string): Promise<void>` — marks the step done, syncs Google, awards StepDone via `rewardStepDone`; if it was the last step, marks the task done + stamps linked item(s) `completedAt` + awards `TaskComplete`. Workspace-scoped, idempotent.

- [ ] **Step 1: Write the failing test.** Append to `src/app/actions/complete.test.ts` (extend the `prismaMock` `step` object at the top of the file to include `findFirst: vi.fn()` and add `focusSession`/`googleTask` no-ops are not needed because we mock the google helper). Add a mock for the google-sync module used by focus.ts and the test:
```ts
vi.mock("@/lib/google", () => ({ getGoogleStatus: vi.fn() }));
// completeGoogleTaskForStep lives in focus.ts itself; if it calls out, it is guarded by google connection — mock prisma.googleTask if referenced.

describe("completeStep", () => {
  it("marks the step done + awards StepDone (not SessionFinished), scoped", async () => {
    const rewards = await import("@/lib/rewards");
    prismaMock.step.findFirst.mockResolvedValueOnce({
      id: "s1", taskId: "t1", done: false,
      task: { id: "t1", steps: [{ id: "s1", done: false }, { id: "s2", done: false }] },
    });
    const { completeStep } = await import("./focus");
    await completeStep("s1");
    expect(prismaMock.step.findFirst.mock.calls[0][0].where).toEqual({ id: "s1", task: { workspaceId: "owner" } });
    expect(prismaMock.step.update).toHaveBeenCalledWith({ where: { id: "s1" }, data: { done: true } });
    expect(rewards.rewardStepDone).toHaveBeenCalledWith("owner");
    expect(rewards.logReward).not.toHaveBeenCalledWith("owner", "session_finished");
  });

  it("last step → task done + item stamped + TaskComplete", async () => {
    const rewards = await import("@/lib/rewards");
    prismaMock.step.findFirst.mockResolvedValueOnce({
      id: "s2", taskId: "t1", done: false,
      task: { id: "t1", steps: [{ id: "s1", done: true }, { id: "s2", done: false }] },
    });
    const { completeStep } = await import("./focus");
    await completeStep("s2");
    expect(prismaMock.task.update).toHaveBeenCalledWith({ where: { id: "t1" }, data: { status: "done" } });
    expect(prismaMock.brainDumpItem.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { taskId: "t1", workspaceId: "owner" } }),
    );
    expect(rewards.logReward).toHaveBeenCalledWith("owner", "task_complete");
  });

  it("no-ops when already done", async () => {
    prismaMock.step.findFirst.mockResolvedValueOnce({ id: "s1", done: true, task: { steps: [] } });
    const { completeStep } = await import("./focus");
    await completeStep("s1");
    expect(prismaMock.step.update).not.toHaveBeenCalled();
  });
});
```
> Note: the focus-action mock file already mocks `@/lib/rewards`; ensure `rewardStepDone` and `logReward` are present in that mock (Task 3 added `rewardStepDone`). If `completeGoogleTaskForStep` touches prisma, add the referenced model to `prismaMock` as a `vi.fn()` returning `null`/`false`.

- [ ] **Step 2: Run to verify fail.** Run: `npx vitest run src/app/actions/complete.test.ts` — Expected: FAIL (`completeStep` not exported).

- [ ] **Step 3: Implement in `src/app/actions/focus.ts`.** Add `RewardType`, `BadgeKey` (constants) and `rewardStepDone`, `logReward`, `awardBadge` (rewards) to imports if missing. Add:
```ts
/** Complete a step directly (no focus session). Awards StepDone; finishes the task on the last step. */
export async function completeStep(stepId: string) {
  const workspaceId = await currentWorkspaceId();
  const step = await prisma.step.findFirst({
    where: { id: stepId, task: { workspaceId } },
    include: { task: { include: { steps: true } } },
  });
  if (!step || step.done) return;

  await completeGoogleTaskForStep(step);
  await prisma.step.update({ where: { id: stepId }, data: { done: true } });
  await rewardStepDone(workspaceId);

  const stillOpen = step.task.steps.filter((s) => s.id !== stepId && !s.done);
  if (stillOpen.length === 0) {
    await prisma.task.update({ where: { id: step.taskId }, data: { status: TaskStatus.Done } });
    await prisma.brainDumpItem.updateMany({
      where: { taskId: step.taskId, workspaceId },
      data: { completedAt: new Date() },
    });
    await logReward(workspaceId, RewardType.TaskComplete);
    await awardBadge(workspaceId, BadgeKey.TaskComplete);
  }

  revalidatePath(`/tasks/${step.taskId}`);
  revalidatePath("/inbox");
  revalidatePath("/dashboard");
}
```
> `completeGoogleTaskForStep` and `TaskStatus` are already imported/available in `focus.ts`.

- [ ] **Step 4: Run to verify pass + full actions.** Run: `npx vitest run src/app/actions` — Expected: PASS (including the unchanged `completeFocus` tests).

- [ ] **Step 5: Commit.**
```bash
git add src/app/actions/focus.ts src/app/actions/complete.test.ts
git commit -m "feat(actions): completeStep — direct step complete + last-step task completion"
```

---

### Task 6: Bucketing — `completed` bucket, `completedTodayCount`, exclusions

**Files:**
- Modify: `src/components/inbox/bucket.ts`
- Modify: `src/components/inbox/bucket.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `Item` gains `completedAt: Date | null`; `Buckets` gains `completed: Item[]` (≤10, `completedAt` desc) and `completedTodayCount: number`. Completed items are excluded from `needsReview`/`singleTask`/`multiStep`/`savedLater`.

- [ ] **Step 1: Write the failing test.** Add to `src/components/inbox/bucket.test.ts` (the `item()` factory must include `completedAt: null` in its defaults — add that field):
```ts
describe("completed bucket", () => {
  it("collects completed items, newest first, capped at 10, excluded elsewhere", () => {
    const items = [
      item({ id: "a", status: BrainDumpStatus.Triaged, completedAt: new Date(NOW - 5_000) }),
      item({ id: "b", status: BrainDumpStatus.Triaged, completedAt: new Date(NOW - 1_000) }),
      item({ id: "todo", status: BrainDumpStatus.Triaged }),
    ];
    const { completed, singleTask } = bucketItems(items, NOW);
    expect(completed.map((i) => i.id)).toEqual(["b", "a"]);
    expect(singleTask.map((i) => i.id)).toEqual(["todo"]); // completed excluded
  });

  it("caps completed at 10 most recent", () => {
    const items = Array.from({ length: 14 }, (_, n) =>
      item({ id: `c${n}`, status: BrainDumpStatus.Triaged, completedAt: new Date(NOW - n * 1000) }),
    );
    const { completed } = bucketItems(items, NOW);
    expect(completed).toHaveLength(10);
    expect(completed[0].id).toBe("c0"); // newest
  });

  it("completedTodayCount counts only items completed since local midnight", () => {
    const midnight = new Date(NOW); midnight.setHours(0, 0, 0, 0);
    const items = [
      item({ id: "today", status: BrainDumpStatus.Triaged, completedAt: new Date(midnight.getTime() + 1000) }),
      item({ id: "yesterday", status: BrainDumpStatus.Triaged, completedAt: new Date(midnight.getTime() - 1000) }),
    ];
    const { completedTodayCount } = bucketItems(items, NOW);
    expect(completedTodayCount).toBe(1);
  });
});
```

- [ ] **Step 2: Run to verify fail.** Run: `npx vitest run src/components/inbox/bucket.test.ts` — Expected: FAIL.

- [ ] **Step 3: Implement in `src/components/inbox/bucket.ts`.**
  - Add to the `Item` type: `completedAt: Date | null;`
  - Add to the `Buckets` type: `completed: Item[];` and `completedTodayCount: number;`
  - Add a `startOfDay` helper and update `bucketItems`:
```ts
const isCompleted = (i: Item) => i.completedAt != null;

function startOfDayMs(now: number): number {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}
```
  - In `bucketItems`, add `&& !isCompleted(i)` to the `needsReview`, `savedLater`, and `triaged` filters. Then:
```ts
  const completedAll = items
    .filter(isCompleted)
    .sort((a, b) => toMs(b.completedAt!) - toMs(a.completedAt!));
  const completed = completedAll.slice(0, 10);
  const dayStart = startOfDayMs(now);
  const completedTodayCount = completedAll.filter((i) => toMs(i.completedAt!) >= dayStart).length;

  return { needsReview, singleTask, multiStep, savedLater, completed, completedTodayCount };
```

- [ ] **Step 4: Run to verify pass.** Run: `npx vitest run src/components/inbox/bucket.test.ts` — Expected: PASS.

- [ ] **Step 5: Commit.**
```bash
git add src/components/inbox/bucket.ts src/components/inbox/bucket.test.ts
git commit -m "feat(inbox): completed bucket + completedTodayCount + exclude from active buckets"
```

---

### Task 7: Strings — complete/reopen/completed keys

**Files:**
- Modify: `src/lib/strings.ts`
- Modify: `src/lib/strings.test.ts`

**Interfaces:**
- Produces: `action.complete`, `action.reopen`, `section.completed`, `section.completedToday` (Plain emoji-free).

- [ ] **Step 1: Write the failing test.** In `src/lib/strings.test.ts`, add render cases in the appropriate `describe` and add the four keys to the `plainOnlyKeys` list:
```ts
["action.complete", "plain", "Complete"],
["action.reopen", "plain", "Reopen"],
["section.completed", "plain", "Completed"],
["section.completedToday", "plain", "Completed today"],
```
and add `"action.complete", "action.reopen", "section.completed", "section.completedToday"` to `plainOnlyKeys`.

- [ ] **Step 2: Run to verify fail.** Run: `npx vitest run src/lib/strings.test.ts` — Expected: FAIL (keys missing).

- [ ] **Step 3: Add entries to `STRINGS` in `src/lib/strings.ts`.**
```ts
  "action.complete":     { plain: "Complete",          playful: "✅ Complete" },
  "action.reopen":       { plain: "Reopen",            playful: "Reopen" },
```
(near the other `action.*` keys) and:
```ts
  "section.completed":      { plain: "Completed",       playful: "🍽️ Cleared plate" },
  "section.completedToday": { plain: "Completed today", playful: "Cleared today" },
```
(near the `section.*` keys).

- [ ] **Step 4: Run to verify pass.** Run: `npx vitest run src/lib/strings.test.ts` — Expected: PASS.

- [ ] **Step 5: Commit.**
```bash
git add src/lib/strings.ts src/lib/strings.test.ts
git commit -m "feat(strings): complete/reopen/completed keys"
```

---

### Task 8: Inbox page query — `completedAt` + steps

**Files:**
- Modify: `src/app/(app)/inbox/page.tsx`

**Interfaces:**
- Produces: each `Item` passed to `InboxView` includes `completedAt` and, for task-linked items, `steps: { id, order, text, done }[]` (used by the Completed multi-step Undo picker).

- [ ] **Step 1: Read the Next 16 data-fetch guide.** Confirm server-component async conventions in `node_modules/next/dist/docs/`.

- [ ] **Step 2: Extend the query + mapping.** In `src/app/(app)/inbox/page.tsx`, ensure the `include` pulls the task's steps (`task: { include: { steps: { orderBy: { order: "asc" } } } }`, workspace-scoped as today), and add to the per-item mapping passed to `InboxView`:
```ts
      completedAt: item.completedAt,
      steps: item.task?.steps.map((s) => ({ id: s.id, order: s.order, text: s.text, done: s.done })) ?? [],
```
Add `steps` to the `Item` type in `bucket.ts` (`steps: { id: string; order: number; text: string; done: boolean }[]`) with a default of `[]`, and include it in `bucket.test.ts`'s `item()` factory defaults (`steps: []`).

- [ ] **Step 3: Verify types + build.** Run: `npx tsc --noEmit` — Expected: PASS (InboxView consumes the new fields in Task 9; if red before Task 9, that is expected — land 8→9 together).

- [ ] **Step 4: Commit.**
```bash
git add "src/app/(app)/inbox/page.tsx" src/components/inbox/bucket.ts src/components/inbox/bucket.test.ts
git commit -m "feat(inbox): load completedAt + steps into InboxView items"
```

---

### Task 9: Inbox UI — Complete buttons + Completed section + Undo picker

**Files:**
- Modify: `src/components/inbox/inbox-view.tsx`
- Modify: `src/components/inbox/inbox-view.test.tsx`

**Interfaces:**
- Consumes: `completeItem`, `reopenItem` (Tasks 3–4), `bucketItems.completed`/`completedTodayCount` (Task 6), strings (Task 7).

- [ ] **Step 1: Write the failing tests.** Add to `src/components/inbox/inbox-view.test.tsx` (extend the `braindump` mock with `completeItem`, `reopenItem`; `makeItem` gains `completedAt: null, steps: []`):
```ts
describe("InboxView — complete + completed bucket", () => {
  it("a needs-review row has a Complete button that calls completeItem", async () => {
    const { completeItem } = await import("@/app/actions/braindump");
    const user = userEvent.setup();
    render(<InboxView initialItems={[makeItem({ id: "n1", text: "do it" })]} settings={settings} />);
    const row = screen.getByText("do it").closest("li")!;
    await user.click(within(row).getByRole("button", { name: "Complete" }));
    expect(completeItem).toHaveBeenCalledWith("n1");
  });

  it("renders the Completed section with a today count and Undo", async () => {
    const { reopenItem } = await import("@/app/actions/braindump");
    const user = userEvent.setup();
    const done = makeItem({ id: "d1", text: "finished", status: "triaged", completedAt: new Date() });
    render(<InboxView initialItems={[done]} settings={settings} />);
    expect(screen.getByText(/Completed today/i)).toBeInTheDocument();
    const row = screen.getByText("finished").closest("li")!;
    await user.click(within(row).getByRole("button", { name: /Reopen|Undo/ }));
    expect(reopenItem).toHaveBeenCalledWith("d1", undefined);
  });
});
```

- [ ] **Step 2: Run to verify fail.** Run: `npx vitest run src/components/inbox/inbox-view.test.tsx` — Expected: FAIL.

- [ ] **Step 3: Implement.** In `inbox-view.tsx`:
  - Import `completeItem, reopenItem` from `@/app/actions/braindump`; destructure `completed, completedTodayCount` from `bucketItems(...)`.
  - Add a **Complete** button (`t("action.complete", voice)`) to the needs-review `ItemRow` action row and to the single-task and multi-step rows, wired `onClick={() => run(() => completeItem(item.id))}`.
  - After the "Saved for later" section, add a **Completed** `<section>`:
```tsx
{completed.length > 0 && (
  <section>
    <h2 className="mb-2 flex items-center gap-2 text-sm font-semibold">
      {t("section.completed", voice)}
      <span className="bg-secondary text-secondary-foreground rounded-full px-2 py-0.5 text-xs">
        {t("section.completedToday", voice)}: {completedTodayCount}
      </span>
      <a href="/library?tab=done" className="text-muted-foreground hover:text-foreground ml-auto text-xs font-normal">
        {t("link.seeAll", voice)}
      </a>
    </h2>
    <ul className="space-y-2 opacity-80">
      {completed.map((item) => (
        <li key={item.id} className="flex items-center justify-between rounded-lg border px-4 py-2 text-sm">
          <span className="break-words line-through">{item.text}</span>
          <button
            className="text-muted-foreground hover:text-foreground shrink-0 text-xs underline"
            onClick={() => run(() => reopenItem(item.id))}
          >
            {t("action.reopen", voice)}
          </button>
        </li>
      ))}
    </ul>
  </section>
)}
```
> The per-step Undo picker for a completed multi-step (checkbox list) is a refinement; for Phase A, a plain Undo (whole-item `reopenItem(id)` → resets all steps) satisfies the spec's Undo. The picker UI can be a fast-follow. The test above passes `undefined` for `stepIds`.

- [ ] **Step 4: Run to verify pass + types.** Run: `npx vitest run src/components/inbox && npx tsc --noEmit` — Expected: PASS.

- [ ] **Step 5: Commit.**
```bash
git add src/components/inbox/inbox-view.tsx src/components/inbox/inbox-view.test.tsx
git commit -m "feat(inbox): Complete buttons + Completed section (today count, Undo, see-all)"
```

---

### Task 10: Task page — per-step ✓ Complete

**Files:**
- Modify: `src/components/breakdown/task-steps.tsx`
- Modify: `src/components/breakdown/task-steps.test.tsx`

**Interfaces:**
- Consumes: `completeStep` (Task 5).
- Produces: each incomplete step row in `TaskSteps` shows **✓ Complete** beside **▶ Focus** and **↗ Send to review**.

- [ ] **Step 1: Write the failing test.** Add to `src/components/breakdown/task-steps.test.tsx` (mock adds `completeStep`):
```ts
it("a step's ✓ Complete calls completeStep", async () => {
  const { completeStep } = await import("@/app/actions/breakdown");
  (completeStep as ReturnType<typeof vi.fn>)?.mockResolvedValue?.({});
  const user = userEvent.setup();
  render(<TaskSteps taskId="t1" steps={steps()} />);
  await user.click(screen.getAllByRole("button", { name: /Complete/i })[0]);
  expect(completeStep).toHaveBeenCalledWith("s1");
});
```
> `completeStep` lives in `focus.ts`; import it there. Update the test's `vi.mock("@/app/actions/breakdown", ...)` to also `vi.mock("@/app/actions/focus", () => ({ completeStep: vi.fn().mockResolvedValue(undefined) }))` and import `completeStep` from `@/app/actions/focus`.

- [ ] **Step 2: Run to verify fail.** Run: `npx vitest run src/components/breakdown/task-steps.test.tsx` — Expected: FAIL.

- [ ] **Step 3: Implement in `src/components/breakdown/task-steps.tsx`.** Import `completeStep` from `@/app/actions/focus`; in the per-step row, for an incomplete step add beside the Focus link:
```tsx
<button
  title="Complete"
  aria-label="Complete"
  disabled={pending}
  onClick={() => start(async () => { await completeStep(s.id); router.refresh(); })}
  className="text-muted-foreground hover:text-green-600 rounded px-1 text-sm disabled:opacity-40"
>
  ✓ Complete
</button>
```
(Place it before the `▶ Focus` link inside the same row; keep the existing `↗ Send to review` and Focus controls.)

- [ ] **Step 4: Run to verify pass.** Run: `npx vitest run src/components/breakdown/task-steps.test.tsx` — Expected: PASS.

- [ ] **Step 5: Commit.**
```bash
git add src/components/breakdown/task-steps.tsx src/components/breakdown/task-steps.test.tsx
git commit -m "feat(tasks): direct ✓ Complete per step (no focus timer)"
```

---

### Task 11: Full verification + MR

- [ ] **Step 1: Full suite.** Run: `npx vitest run` — Expected: all green.
- [ ] **Step 2: Types + build.** Run: `npx tsc --noEmit && npm run build` — Expected: clean.
- [ ] **Step 3: Manual/`/verify` smoke** (local dev DB): capture → triage → Complete a single-task → it moves to Completed with "Completed today: 1"; break a task down → complete a step directly (no timer) → points logged; complete the last step → task completes + lands in Completed; Undo a completed item → returns to To-do; Complete a whole multi-step row → all steps done + TaskComplete. Confirm Plain voice shows no decorative emoji.
- [ ] **Step 4: Push + MR** → `main`, reviewer @GitLabDuo, milestone v0.0.2, description linking #8 (Phase A of the complete-bucket spec) + noting Phase B (bucket board + drag) follows. **Do not merge — owner approval; Duo review if the service has recovered, else self-review + document (per this session's precedent).**

---

## Self-Review

- **Spec coverage (Phase A):** `completedAt` single-source (T1) ✓ · TaskComplete reward+badge, shared step-reward (T2) ✓ · `completeItem` credits steps + task bonus (T3) ✓ · `reopenItem` w/ ≥1-not-done guard (T4) ✓ · `completeStep` direct, no SessionFinished, last-step completion (T5) ✓ · completed bucket + today count + exclusions (T6) ✓ · strings (T7) ✓ · page query completedAt+steps (T8) ✓ · Complete buttons + Completed section + Undo + see-all→done stub (T9) ✓ · task-page ✓ Complete on !28's TaskSteps (T10) ✓ · workspace scoping throughout ✓ · Plain emoji-free (T7) ✓.
- **Deferred to Phase B (not this plan):** always-visible empty-bucket states, drag-to-move + `@dnd-kit/core`, "Move to…" menu, multi-step drop prompt, multi-step inline expand, `moveToReview`.
- **Deferred as fast-follow (noted in T9):** the per-step checkbox Undo *picker* for completed multi-step items — Phase A ships whole-item Undo (resets all steps via `reopenItem(id)`); the `stepIds` picker UI can follow. `reopenItem` already supports `stepIds`.
- **Type consistency:** `rewardStepDone(workspaceId): Promise<StreakUpdate|null>` defined T2, used T5; `completeItem`/`reopenItem` (braindump.ts) T3/T4 consumed by T9; `completeStep` (focus.ts) T5 consumed by T10; `Item.completedAt`/`steps` + `Buckets.completed`/`completedTodayCount` defined T6/T8, consumed T9.
- **Sequencing:** T8 widens the item type and T9 consumes it — land back-to-back if `tsc` is red between them (flagged in T8 Step 3).
