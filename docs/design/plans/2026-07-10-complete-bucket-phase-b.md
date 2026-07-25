# Inbox bucket board (drag-to-move) — Phase B Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the inbox into a bucket board — four always-visible To-Do buckets with "nothing here yet" empty states, drag-to-move between buckets (including back to Needs review) where the drop performs the destination bucket's action, a keyboard/screen-reader "Move to…" menu that shares the same dispatch, a prompt when dropping onto Multi-step, and multi-step rows that show a step count and expand inline to Focus/Complete each step.

**Architecture:** One pure dispatcher decides what a move means: `dropPlan(source, target)` (in `move-dispatch.ts`) maps a source→target bucket pair to a plan (`noop` / `apply` with `reopenFirst` + `prompt` flags), and `bucketOfItem(item, now)` (in `bucket.ts`) computes an item's current bucket. Both drag (`@dnd-kit/core`) and the "Move to…" menu funnel through a single component-level `moveItemToBucket(itemId, target)` that reads the plan and calls the existing workspace-scoped server actions (`moveToReview` — new, `triageBrainDumpItem`, `snoozeBrainDumpItem`, `completeItem`, `reopenItem`, `startBreakdown`). Rendering changes: the To-Do board always shows all four buckets; multi-step rows reuse the `TaskSteps` client component (from !28) for the inline step list.

**Tech Stack:** Next.js 16 (modified — read `node_modules/next/dist/docs/` before App Router APIs; `params`/`searchParams` are Promises), React 19 server + client components, `@dnd-kit/core` (new, MIT — pointer/touch/keyboard drag sensors), Prisma (Postgres prod / SQLite dev; statuses are plain strings), Vitest 4 + RTL (jsdom), Tailwind.

## Global Constraints

- **Plain voice 100% emoji-free** (functional glyphs only: 🟢🟡🟠🔴 ✅ ▶ ⏸ ➕ ➖ 🗑️ 🔒 ⚠️ ✓ →). Every new user-facing string via `t(key, voice)` with a `{plain, playful}` entry in `src/lib/strings.ts`, and added to the `plainOnlyKeys` list in `strings.test.ts`.
- **Workspace scoping mandatory** on every read/write: resolve `currentWorkspaceId()`; gate reads with `findFirst({ where: { id, workspaceId } })` (or `updateMany({ where: { id, workspaceId } })`) before writing.
- **`completedAt` is the single done-signal** (Phase A). `moveToReview` clears it; the board reads it via `bucketItems`.
- **`moveToReview` keeps the task** — LOCKED decision (spec line 134): set `status = "inbox"`, clear `triagedAt`/`snoozedUntil`/`completedAt`, **leave `taskId` and steps intact**. (The spec's Phase-B *test* bullet line 189 says "detaches + archives a linked task" — that is stale and contradicts the locked decision; follow the locked decision.)
- **Drag and the menu share ONE dispatcher** (`moveItemToBucket`) so they can't diverge. Dropping where the item already lives is a no-op (no within-bucket reorder in Phase B). Dropping a Completed item elsewhere reopens it first, then applies the target action (whole-task reopen mid-drag — no per-step picker).
- **Idempotent / forgiving:** actions no-op when the transition doesn't apply; reopening never claws back points.
- **TDD:** failing test → run (fail) → minimal impl → run (pass) → commit. `npx vitest run`, `npx tsc --noEmit`, `npm run build` green before the MR.
- **Component tests** need `// @vitest-environment jsdom` (literal first line) + `afterEach(cleanup)` (repo has no `globals:true`). Mock `next/navigation`'s `useRouter` (`push`/`refresh`) and the `@/app/actions/*` modules.
- **Default snooze on a "Saved for later" drop = 60 minutes** (matches the existing `onSnooze` in `inbox-view.tsx`).
- **Env for local migrate/dev:** `export PATH="$HOME/.rd/bin:$PATH"; export DOCKER_HOST="unix://$HOME/.rd/docker.sock"; docker compose up -d db`. (No schema/migration changes in Phase B — Phase A already added `completedAt`.)

## File Structure

| File | Responsibility | Action |
|---|---|---|
| `package.json` + `package-lock.json` | add `@dnd-kit/core` | Modify |
| `src/app/actions/braindump.ts` (+ `moveToReview.test.ts`) | new `moveToReview(id)` action | Modify / Create test |
| `src/lib/strings.ts` (+ `strings.test.ts`) | `bucket.empty`, `action.moveTo`, `prompt.breakNow`, `prompt.saveInstead` | Modify |
| `src/components/inbox/bucket.ts` (+ `bucket.test.ts`) | widen `Item.steps` (add `estMinutes`, `subtaskEmoji`); add `bucketOfItem(item, now)` + `BucketId` type | Modify |
| `src/app/(app)/inbox/page.tsx` | map `estMinutes` + `subtaskEmoji` into each item's `steps` | Modify |
| `src/components/inbox/move-dispatch.ts` (+ `move-dispatch.test.ts`) | pure `ACTION_FOR_BUCKET` map + `dropPlan(source, target)` | Create |
| `src/components/inbox/multi-step-drop-prompt.tsx` (+ test) | inline prompt: Break now / Save for later / Cancel | Create |
| `src/components/inbox/move-to-menu.tsx` (+ test) | a11y "Move to…" menu (keyboard/SR fallback) | Create |
| `src/components/inbox/inbox-view.tsx` (+ `inbox-view.test.tsx`) | always-visible buckets + empty states; multi-step step-count + tap-to-expand; `moveItemToBucket` dispatcher; wire menu + prompt; dnd-kit drag sources/drop zones | Modify |

---

### Task 1: Add the `@dnd-kit/core` dependency

**Files:**
- Modify: `package.json`, `package-lock.json`

**Interfaces:**
- Produces: `@dnd-kit/core` importable (`DndContext`, `useDraggable`, `useDroppable`, `PointerSensor`, `KeyboardSensor`, `useSensor`, `useSensors`, `type DragEndEvent`).

- [ ] **Step 1: Install.** Run: `npm install @dnd-kit/core` — Expected: adds `@dnd-kit/core` to `dependencies` and updates `package-lock.json`.

- [ ] **Step 2: Verify it resolves + the build still compiles.** Run: `node -e "require.resolve('@dnd-kit/core'); console.log('ok')"` — Expected: prints `ok`.

- [ ] **Step 3: Commit.**
```bash
git add package.json package-lock.json
git commit -m "build: add @dnd-kit/core for inbox drag-to-move"
```

---

### Task 2: `moveToReview` action (un-triage, keep the task)

**Files:**
- Modify: `src/app/actions/braindump.ts`
- Create: `src/app/actions/moveToReview.test.ts`

**Interfaces:**
- Produces: `moveToReview(id: string): Promise<void>` — workspace-scoped; sets `status = BrainDumpStatus.Inbox`, clears `triagedAt`/`snoozedUntil`/`completedAt`; **leaves `taskId` and steps intact**; revalidates `/inbox`.

- [ ] **Step 1: Write the failing test.** Create `src/app/actions/moveToReview.test.ts`:
```ts
import { describe, it, expect, vi, beforeEach } from "vitest";

const { prismaMock, revalidatePathMock, currentWorkspaceIdMock } = vi.hoisted(() => {
  const prismaMock = {
    brainDumpItem: {
      findFirst: vi.fn(),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      update: vi.fn().mockResolvedValue({}),
    },
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
vi.mock("@/lib/rewards", () => ({
  maybeAwardInboxZero: vi.fn().mockResolvedValue(undefined),
  maybeAwardTenStepsDay: vi.fn().mockResolvedValue(undefined),
  logReward: vi.fn().mockResolvedValue(undefined),
  awardBadge: vi.fn().mockResolvedValue(undefined),
  touchStreakOnCompletion: vi.fn().mockResolvedValue(null),
}));

beforeEach(() => {
  vi.clearAllMocks();
  currentWorkspaceIdMock.mockResolvedValue("owner");
});

describe("moveToReview", () => {
  it("no-ops when the item is missing", async () => {
    prismaMock.brainDumpItem.findFirst.mockResolvedValueOnce(null);
    const { moveToReview } = await import("./braindump");
    await moveToReview("nope");
    expect(prismaMock.brainDumpItem.updateMany).not.toHaveBeenCalled();
  });

  it("un-triages: status=inbox, clears triagedAt/snoozedUntil/completedAt, keeps taskId", async () => {
    prismaMock.brainDumpItem.findFirst.mockResolvedValueOnce({ id: "i1", taskId: "t1" });
    const { moveToReview } = await import("./braindump");
    await moveToReview("i1");
    expect(prismaMock.brainDumpItem.updateMany).toHaveBeenCalledWith({
      where: { id: "i1", workspaceId: "owner" },
      data: { status: "inbox", triagedAt: null, snoozedUntil: null, completedAt: null },
    });
    // taskId is NOT in the data payload → left intact
    const data = prismaMock.brainDumpItem.updateMany.mock.calls[0][0].data;
    expect("taskId" in data).toBe(false);
    expect(revalidatePathMock).toHaveBeenCalledWith("/inbox");
  });

  it("is workspace-scoped (findFirst gated on workspaceId)", async () => {
    prismaMock.brainDumpItem.findFirst.mockResolvedValueOnce({ id: "i1", taskId: null });
    const { moveToReview } = await import("./braindump");
    await moveToReview("i1");
    expect(prismaMock.brainDumpItem.findFirst.mock.calls[0][0].where).toEqual({ id: "i1", workspaceId: "owner" });
  });
});
```

- [ ] **Step 2: Run to verify fail.** Run: `npx vitest run src/app/actions/moveToReview.test.ts` — Expected: FAIL (`moveToReview` not exported).

- [ ] **Step 3: Implement in `src/app/actions/braindump.ts`.** Add after `reopenItem` (all imports already present):
```ts
/**
 * Un-triage an item back to the "needs review" queue (Phase B drag/menu target).
 * Keeps the linked task + its steps intact so re-triaging reuses the same
 * breakdown (startBreakdown returns the existing taskId). Only the item's
 * placement changes: status → inbox, and triaged/snoozed/completed cleared.
 */
export async function moveToReview(id: string) {
  const workspaceId = await currentWorkspaceId();
  const existing = await prisma.brainDumpItem.findFirst({ where: { id, workspaceId } });
  if (!existing) return;
  await prisma.brainDumpItem.updateMany({
    where: { id, workspaceId },
    data: {
      status: BrainDumpStatus.Inbox,
      triagedAt: null,
      snoozedUntil: null,
      completedAt: null,
    },
  });
  revalidatePath(INBOX_PATH);
}
```

- [ ] **Step 4: Run to verify pass.** Run: `npx vitest run src/app/actions/moveToReview.test.ts` — Expected: PASS.

- [ ] **Step 5: Commit.**
```bash
git add src/app/actions/braindump.ts src/app/actions/moveToReview.test.ts
git commit -m "feat(actions): moveToReview — un-triage an item, keep its task"
```

---

### Task 3: Strings — bucket empty state + move/prompt labels

**Files:**
- Modify: `src/lib/strings.ts`
- Modify: `src/lib/strings.test.ts`

**Interfaces:**
- Produces: `bucket.empty`, `action.moveTo`, `prompt.breakNow`, `prompt.saveInstead` (Plain emoji-free).

> Note: the multi-step step-count indicator ("N steps · M done") is built from numbers using the existing `progress.done` key — it is **not** a fixed string, so no `progress.stepCount` key is added (matches the spec's "templated, built from numbers, not a fixed string").

- [ ] **Step 1: Write the failing test.** In `src/lib/strings.test.ts`, add these rows to the `cases` array in the `t() function` describe block:
```ts
    ["bucket.empty",      "plain",   "Nothing here yet"],
    ["action.moveTo",     "plain",   "Move to…"],
    ["prompt.breakNow",   "plain",   "Break into steps now"],
    ["prompt.saveInstead","plain",   "Save for later"],
```
and add these four keys to the `plainOnlyKeys` array in the "Plain voice is emoji-free" describe block:
```ts
    "bucket.empty",
    "action.moveTo",
    "prompt.breakNow",
    "prompt.saveInstead",
```

- [ ] **Step 2: Run to verify fail.** Run: `npx vitest run src/lib/strings.test.ts` — Expected: FAIL (keys missing).

- [ ] **Step 3: Add entries to `STRINGS` in `src/lib/strings.ts`.** Add near the other `action.*` keys (after `action.reopen`):
```ts
  "action.moveTo":       { plain: "Move to…",          playful: "Move to…" },
```
Add a new `bucket.*` group (after the `section.*` block):
```ts
  // ── Bucket board (Phase B) ─────────────────────────────────────────────────
  "bucket.empty":        { plain: "Nothing here yet",  playful: "Nothing here yet" },
```
Add near the `prompt.*` keys (after `prompt.stillNeeded`):
```ts
  "prompt.breakNow":     { plain: "Break into steps now", playful: "🍿 Snack-size it now" },
  "prompt.saveInstead":  { plain: "Save for later",       playful: "🥫 Save for later" },
```

- [ ] **Step 4: Run to verify pass.** Run: `npx vitest run src/lib/strings.test.ts` — Expected: PASS (all `t()` cases + emoji-free assertions green).

- [ ] **Step 5: Commit.**
```bash
git add src/lib/strings.ts src/lib/strings.test.ts
git commit -m "feat(strings): bucket.empty + action.moveTo + break-now/save prompt keys"
```

---

### Task 4: Bucket helpers — widen `Item.steps`, add `bucketOfItem` + `BucketId`

**Files:**
- Modify: `src/components/inbox/bucket.ts`
- Modify: `src/components/inbox/bucket.test.ts`
- Modify: `src/app/(app)/inbox/page.tsx`

**Interfaces:**
- Consumes: existing `Item`, `bucketItems`.
- Produces:
  - `Item.steps` gains `estMinutes: number` and `subtaskEmoji: string | null` per step.
  - `type BucketId = "needsReview" | "singleTask" | "multiStep" | "savedLater" | "completed"`.
  - `bucketOfItem(item: Item, now?: number): BucketId` — which bucket an item currently lives in (mirrors `bucketItems`' membership rules).

- [ ] **Step 1: Write the failing test.** Add to `src/components/inbox/bucket.test.ts` (the `item()` factory already defaults `steps: []`; no change needed there — the new step fields are only asserted where a step is supplied):
```ts
import { bucketOfItem } from "./bucket"; // add to existing import if not present

describe("bucketOfItem", () => {
  it("classifies completed, saved, review, single-task and multi-step", () => {
    const now = NOW;
    expect(bucketOfItem(item({ status: "triaged", completedAt: new Date(now) }), now)).toBe("completed");
    expect(bucketOfItem(item({ status: "inbox", snoozedUntil: new Date(now + 60_000) }), now)).toBe("savedLater");
    expect(bucketOfItem(item({ status: "inbox" }), now)).toBe("needsReview");
    expect(bucketOfItem(item({ status: "triaged", stepsTotal: 0 }), now)).toBe("singleTask");
    expect(bucketOfItem(item({ status: "triaged", stepsTotal: 3, stepsDone: 1 }), now)).toBe("multiStep");
  });
});
```

- [ ] **Step 2: Run to verify fail.** Run: `npx vitest run src/components/inbox/bucket.test.ts` — Expected: FAIL (`bucketOfItem` not exported).

- [ ] **Step 3: Implement in `src/components/inbox/bucket.ts`.**
  - Widen the `steps` field on the `Item` type:
```ts
  steps: { id: string; order: number; text: string; done: boolean; estMinutes: number; subtaskEmoji: string | null }[];
```
  - Add the `BucketId` type (near the `Buckets` type):
```ts
export type BucketId = "needsReview" | "singleTask" | "multiStep" | "savedLater" | "completed";
```
  - Add `bucketOfItem` at the end of the file (reuses the module-local `isCompleted`, `isFullyDone`, `toMs`, and the status constants already imported):
```ts
/**
 * Which bucket a single item currently lives in — mirrors bucketItems'
 * membership rules. Used by the drag/menu dispatcher to detect same-bucket
 * no-ops and completed-source reopen-first.
 */
export function bucketOfItem(i: Item, now: number = Date.now()): BucketId {
  if (isCompleted(i)) return "completed";
  if (i.status === BrainDumpStatus.Inbox) {
    return i.snoozedUntil != null && toMs(i.snoozedUntil) > now ? "savedLater" : "needsReview";
  }
  if (i.status === BrainDumpStatus.Triaged && !isFullyDone(i)) {
    return i.stepsTotal > 0 ? "multiStep" : "singleTask";
  }
  // Fully-done-but-not-stamped or any other state: treat as review (safe default).
  return "needsReview";
}
```

- [ ] **Step 4: Run to verify pass.** Run: `npx vitest run src/components/inbox/bucket.test.ts` — Expected: PASS.

- [ ] **Step 5: Pipe the new step fields through the inbox query.** In `src/app/(app)/inbox/page.tsx`, update the per-item `steps` mapping to include the two new fields:
```ts
      steps: task?.steps.map((s) => ({
        id: s.id,
        order: s.order,
        text: s.text,
        done: s.done,
        estMinutes: s.estMinutes,
        subtaskEmoji: s.subtaskEmoji,
      })) ?? [],
```
(The query already `include`s `task.steps` ordered by `order`, so no query change is needed — only the mapping.)

- [ ] **Step 6: Verify types.** Run: `npx tsc --noEmit` — Expected: PASS.

- [ ] **Step 7: Commit.**
```bash
git add src/components/inbox/bucket.ts src/components/inbox/bucket.test.ts "src/app/(app)/inbox/page.tsx"
git commit -m "feat(inbox): bucketOfItem helper + pipe estMinutes/subtaskEmoji into item steps"
```

---

### Task 5: Pure drop dispatch — `ACTION_FOR_BUCKET` + `dropPlan`

**Files:**
- Create: `src/components/inbox/move-dispatch.ts`
- Create: `src/components/inbox/move-dispatch.test.ts`

**Interfaces:**
- Consumes: `BucketId` (Task 4).
- Produces:
  - `ACTION_FOR_BUCKET: Record<BucketId, "moveToReview" | "triage" | "breakdown" | "snooze" | "complete">` — the destination bucket's action (the "can't silently invert" mapping).
  - `type DropPlan = { kind: "noop" } | { kind: "apply"; target: BucketId; action: BucketAction; reopenFirst: boolean; prompt: boolean }` where `type BucketAction = (typeof ACTION_FOR_BUCKET)[BucketId]`.
  - `dropPlan(source: BucketId, target: BucketId): DropPlan` — `noop` when `source === target`; otherwise `apply` with `reopenFirst = source === "completed"` and `prompt = target === "multiStep"`.

- [ ] **Step 1: Write the failing test.** Create `src/components/inbox/move-dispatch.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { ACTION_FOR_BUCKET, dropPlan } from "./move-dispatch";

describe("ACTION_FOR_BUCKET (anti-inversion map)", () => {
  it("maps each bucket to its destination action", () => {
    expect(ACTION_FOR_BUCKET.needsReview).toBe("moveToReview");
    expect(ACTION_FOR_BUCKET.singleTask).toBe("triage");
    expect(ACTION_FOR_BUCKET.multiStep).toBe("breakdown");
    expect(ACTION_FOR_BUCKET.savedLater).toBe("snooze");
    expect(ACTION_FOR_BUCKET.completed).toBe("complete");
  });
});

describe("dropPlan", () => {
  it("is a no-op when dropped on its own bucket", () => {
    expect(dropPlan("singleTask", "singleTask")).toEqual({ kind: "noop" });
  });

  it("applies the target action for a cross-bucket move", () => {
    expect(dropPlan("needsReview", "singleTask")).toEqual({
      kind: "apply", target: "singleTask", action: "triage", reopenFirst: false, prompt: false,
    });
    expect(dropPlan("singleTask", "completed")).toEqual({
      kind: "apply", target: "completed", action: "complete", reopenFirst: false, prompt: false,
    });
  });

  it("reopens first when the source is completed", () => {
    expect(dropPlan("completed", "singleTask")).toMatchObject({ kind: "apply", reopenFirst: true, action: "triage" });
  });

  it("flags a prompt when the target is multi-step", () => {
    expect(dropPlan("needsReview", "multiStep")).toMatchObject({ kind: "apply", prompt: true, action: "breakdown" });
    expect(dropPlan("completed", "multiStep")).toMatchObject({ reopenFirst: true, prompt: true });
  });
});
```

- [ ] **Step 2: Run to verify fail.** Run: `npx vitest run src/components/inbox/move-dispatch.test.ts` — Expected: FAIL (module not found).

- [ ] **Step 3: Implement `src/components/inbox/move-dispatch.ts`.**
```ts
// Pure drop/move dispatch — no React, no server actions — so drag and the
// "Move to…" menu can share one non-invertible mapping (mirrors the !28
// More/Fewer regression lesson). The destination bucket defines the outcome.

import type { BucketId } from "./bucket";

export type BucketAction = "moveToReview" | "triage" | "breakdown" | "snooze" | "complete";

/** Destination bucket → the action its drop performs. */
export const ACTION_FOR_BUCKET: Record<BucketId, BucketAction> = {
  needsReview: "moveToReview",
  singleTask: "triage",
  multiStep: "breakdown",
  savedLater: "snooze",
  completed: "complete",
};

export type DropPlan =
  | { kind: "noop" }
  | { kind: "apply"; target: BucketId; action: BucketAction; reopenFirst: boolean; prompt: boolean };

/**
 * Resolve a source→target move into a plan.
 * - same bucket → noop (Phase B does not reorder within a bucket)
 * - completed source → reopen the item first, then apply the target action
 * - multiStep target → needs the break-now/save prompt (can't silently create steps)
 */
export function dropPlan(source: BucketId, target: BucketId): DropPlan {
  if (source === target) return { kind: "noop" };
  return {
    kind: "apply",
    target,
    action: ACTION_FOR_BUCKET[target],
    reopenFirst: source === "completed",
    prompt: target === "multiStep",
  };
}
```

- [ ] **Step 4: Run to verify pass.** Run: `npx vitest run src/components/inbox/move-dispatch.test.ts` — Expected: PASS.

- [ ] **Step 5: Commit.**
```bash
git add src/components/inbox/move-dispatch.ts src/components/inbox/move-dispatch.test.ts
git commit -m "feat(inbox): pure drop-action dispatch (ACTION_FOR_BUCKET + dropPlan)"
```

---

### Task 6: Multi-step drop prompt component

**Files:**
- Create: `src/components/inbox/multi-step-drop-prompt.tsx`
- Create: `src/components/inbox/multi-step-drop-prompt.test.tsx`

**Interfaces:**
- Consumes: strings (Task 3), `Voice`.
- Produces: `MultiStepDropPrompt` — a small inline popover with **Break into steps now** / **Save for later** / **Cancel**; Escape triggers `onCancel`.
```ts
function MultiStepDropPrompt(props: {
  itemText: string;
  voice: Voice;
  onBreakNow: () => void;
  onSaveLater: () => void;
  onCancel: () => void;
}): JSX.Element
```

- [ ] **Step 1: Write the failing test.** Create `src/components/inbox/multi-step-drop-prompt.test.tsx`:
```tsx
// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MultiStepDropPrompt } from "./multi-step-drop-prompt";

afterEach(cleanup);

function setup() {
  const onBreakNow = vi.fn();
  const onSaveLater = vi.fn();
  const onCancel = vi.fn();
  render(
    <MultiStepDropPrompt
      itemText="plan the trip"
      voice="plain"
      onBreakNow={onBreakNow}
      onSaveLater={onSaveLater}
      onCancel={onCancel}
    />,
  );
  return { onBreakNow, onSaveLater, onCancel };
}

describe("MultiStepDropPrompt", () => {
  it("calls onBreakNow when 'Break into steps now' is chosen", async () => {
    const { onBreakNow } = setup();
    await userEvent.click(screen.getByRole("button", { name: "Break into steps now" }));
    expect(onBreakNow).toHaveBeenCalledTimes(1);
  });

  it("calls onSaveLater when 'Save for later' is chosen", async () => {
    const { onSaveLater } = setup();
    await userEvent.click(screen.getByRole("button", { name: "Save for later" }));
    expect(onSaveLater).toHaveBeenCalledTimes(1);
  });

  it("calls onCancel on Escape", async () => {
    const { onCancel } = setup();
    await userEvent.keyboard("{Escape}");
    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Run to verify fail.** Run: `npx vitest run src/components/inbox/multi-step-drop-prompt.test.tsx` — Expected: FAIL (module not found).

- [ ] **Step 3: Implement `src/components/inbox/multi-step-drop-prompt.tsx`.**
```tsx
"use client";

import { useEffect } from "react";
import { t, type Voice } from "@/lib/strings";

/**
 * Inline prompt shown when an item is dropped onto (or "Move to…"-ed into) the
 * Multi-step bucket: dropping can't silently create steps, so we ask whether to
 * break it down now (→ editor) or just save it for later. Escape cancels.
 */
export function MultiStepDropPrompt({
  itemText,
  voice,
  onBreakNow,
  onSaveLater,
  onCancel,
}: {
  itemText: string;
  voice: Voice;
  onBreakNow: () => void;
  onSaveLater: () => void;
  onCancel: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel]);

  return (
    <div
      role="dialog"
      aria-label={t("action.moveTo", voice)}
      className="mt-2 space-y-2 rounded-md border bg-background px-3 py-2 text-xs shadow-sm"
    >
      <p className="text-muted-foreground break-words">{itemText}</p>
      <div className="flex flex-wrap gap-2">
        <button
          onClick={onBreakNow}
          className="bg-primary text-primary-foreground rounded-md px-2.5 py-1 font-medium"
        >
          {t("prompt.breakNow", voice)}
        </button>
        <button onClick={onSaveLater} className="hover:bg-accent rounded-md border px-2.5 py-1">
          {t("prompt.saveInstead", voice)}
        </button>
        <button onClick={onCancel} className="text-muted-foreground hover:text-foreground rounded-md px-2.5 py-1">
          {t("action.cancel", voice)}
        </button>
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Run to verify pass.** Run: `npx vitest run src/components/inbox/multi-step-drop-prompt.test.tsx` — Expected: PASS.

- [ ] **Step 5: Commit.**
```bash
git add src/components/inbox/multi-step-drop-prompt.tsx src/components/inbox/multi-step-drop-prompt.test.tsx
git commit -m "feat(inbox): multi-step drop prompt (break now / save for later)"
```

---

### Task 7: "Move to…" a11y menu component

**Files:**
- Create: `src/components/inbox/move-to-menu.tsx`
- Create: `src/components/inbox/move-to-menu.test.tsx`

**Interfaces:**
- Consumes: `BucketId` (Task 4), strings (Task 3), `Voice`.
- Produces: `MoveToMenu` — a keyboard/screen-reader-accessible menu button that lists the four other buckets and calls `onMove(target)` when one is chosen. It excludes the item's current bucket.
```ts
function MoveToMenu(props: {
  currentBucket: BucketId;
  voice: Voice;
  onMove: (target: BucketId) => void;
}): JSX.Element
```

- [ ] **Step 1: Write the failing test.** Create `src/components/inbox/move-to-menu.test.tsx`:
```tsx
// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MoveToMenu } from "./move-to-menu";

afterEach(cleanup);

describe("MoveToMenu", () => {
  it("opens and lists the other buckets, excluding the current one", async () => {
    render(<MoveToMenu currentBucket="singleTask" voice="plain" onMove={vi.fn()} />);
    await userEvent.click(screen.getByRole("button", { name: "Move to…" }));
    expect(screen.getByRole("menuitem", { name: /Needs review/ })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: /Multi-step/ })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: /Saved for later/ })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: /Completed/ })).toBeInTheDocument();
    // current bucket is excluded
    expect(screen.queryByRole("menuitem", { name: /Single-task/ })).not.toBeInTheDocument();
  });

  it("calls onMove with the chosen bucket id", async () => {
    const onMove = vi.fn();
    render(<MoveToMenu currentBucket="singleTask" voice="plain" onMove={onMove} />);
    await userEvent.click(screen.getByRole("button", { name: "Move to…" }));
    await userEvent.click(screen.getByRole("menuitem", { name: /Completed/ }));
    expect(onMove).toHaveBeenCalledWith("completed");
  });
});
```

- [ ] **Step 2: Run to verify fail.** Run: `npx vitest run src/components/inbox/move-to-menu.test.tsx` — Expected: FAIL (module not found).

- [ ] **Step 3: Implement `src/components/inbox/move-to-menu.tsx`.**
```tsx
"use client";

import { useState } from "react";
import type { BucketId } from "./bucket";
import { t, type Voice, type StringKey } from "@/lib/strings";

// Menu order + the section string each bucket shows as its label.
const BUCKET_ORDER: BucketId[] = ["needsReview", "multiStep", "singleTask", "savedLater", "completed"];
const BUCKET_LABEL: Record<BucketId, StringKey> = {
  needsReview: "section.needsReview",
  multiStep: "section.multiStep",
  singleTask: "section.singleTask",
  savedLater: "section.savedLater",
  completed: "section.completed",
};

/**
 * Keyboard/screen-reader accessible "Move to…" menu — the non-pointer fallback
 * for drag. Shares the same move dispatch as drag (the parent's onMove →
 * moveItemToBucket), so the two paths can't diverge.
 */
export function MoveToMenu({
  currentBucket,
  voice,
  onMove,
}: {
  currentBucket: BucketId;
  voice: Voice;
  onMove: (target: BucketId) => void;
}) {
  const [open, setOpen] = useState(false);
  const targets = BUCKET_ORDER.filter((b) => b !== currentBucket);

  return (
    <span className="relative">
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="text-muted-foreground hover:text-foreground rounded-md border px-2 py-1 text-xs"
      >
        {t("action.moveTo", voice)}
      </button>
      {open && (
        <span
          role="menu"
          className="bg-background absolute right-0 z-10 mt-1 flex min-w-40 flex-col rounded-md border p-1 text-xs shadow-md"
        >
          {targets.map((b) => (
            <button
              key={b}
              type="button"
              role="menuitem"
              onClick={() => {
                setOpen(false);
                onMove(b);
              }}
              className="hover:bg-accent rounded px-2 py-1 text-left"
            >
              {t(BUCKET_LABEL[b], voice)}
            </button>
          ))}
        </span>
      )}
    </span>
  );
}
```
> `t(BUCKET_LABEL[b], voice)` uses the existing `section.*` labels; `section.singleTask` plain = "Single-task to-dos" and `section.multiStep` plain = "Multi-step to-dos", which the test matches via regex.

- [ ] **Step 4: Run to verify pass.** Run: `npx vitest run src/components/inbox/move-to-menu.test.tsx` — Expected: PASS.

- [ ] **Step 5: Commit.**
```bash
git add src/components/inbox/move-to-menu.tsx src/components/inbox/move-to-menu.test.tsx
git commit -m "feat(inbox): accessible Move to… menu (a11y drag fallback)"
```

---

### Task 8: Always-visible To-Do buckets + empty states

**Files:**
- Modify: `src/components/inbox/inbox-view.tsx`
- Modify: `src/components/inbox/inbox-view.test.tsx`

**Interfaces:**
- Consumes: `bucketItems` (existing), strings (`bucket.empty`, Task 3).
- Produces: the To-Do board renders all four buckets — **Multi-step to-dos**, **Single-task to-dos**, **Saved for later**, **Completed** (in that order) — always, each showing `bucket.empty` when its list is empty. Needs review is unchanged. Completed still caps at 10 + today chip + see-all + Undo.

- [ ] **Step 1: Write the failing tests.** Add to `src/components/inbox/inbox-view.test.tsx`:
```ts
describe("InboxView — always-visible bucket board", () => {
  it("shows all four To-Do buckets with empty states when there are no to-dos", () => {
    render(<InboxView initialItems={[]} settings={settings} />);
    // Section headers present even when empty
    expect(screen.getByText("Multi-step to-dos")).toBeInTheDocument();
    expect(screen.getByText("Single-task to-dos")).toBeInTheDocument();
    expect(screen.getByText("Saved for later")).toBeInTheDocument();
    expect(screen.getByText("Completed")).toBeInTheDocument();
    // "Nothing here yet" appears for the empty buckets (at least the 3 non-completed)
    expect(screen.getAllByText("Nothing here yet").length).toBeGreaterThanOrEqual(3);
  });

  it("does not show the empty helper for a bucket that has items", () => {
    const todo = makeItem({ id: "t1", text: "a todo", status: "triaged" });
    render(<InboxView initialItems={[todo]} settings={settings} />);
    const single = screen.getByText("a todo").closest("section, div")!;
    expect(within(single).queryByText("Nothing here yet")).not.toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run to verify fail.** Run: `npx vitest run src/components/inbox/inbox-view.test.tsx` — Expected: FAIL (buckets currently hide when empty).

- [ ] **Step 3: Implement in `src/components/inbox/inbox-view.tsx`.** Import the empty-state string is via existing `t`. Replace the three separate gated sections (the `{(singleTask.length>0 || multiStep.length>0) && ...}` To-Do section, the `{savedLater.length>0 && ...}` section, and the `{completed.length>0 && ...}` section) with a single always-rendered board. Add a small `EmptyBucket` helper and render buckets in spec order (Multi-step, Single-task, Saved for later, Completed):
```tsx
      {/* To-Do board — four always-visible buckets (Phase B) */}
      <section className="space-y-4">
        <h2 className="text-sm font-semibold">{t("section.toDo", voice)}</h2>

        {/* Multi-step */}
        <div>
          <SubHeader label={t("section.multiStep", voice)} count={multiStep.length} seeAllHref={SEE_ALL.multiStep} voice={voice} />
          {multiStep.length === 0 ? (
            <EmptyBucket voice={voice} />
          ) : (
            <ul className={cn("space-y-2", pending && "opacity-70")}>
              {multiStep.map((item) => (
                /* multi-step row — extended in Task 9 (step count + expand) and Task 10 (drag/menu) */
                <li key={item.id} className="flex items-center justify-between gap-3 rounded-lg border px-4 py-2 text-sm">
                  {item.taskId ? (
                    <a href={`/tasks/${item.taskId}`} className="min-w-0 break-words hover:underline">{item.text}</a>
                  ) : (
                    <span className="min-w-0 break-words">{item.text}</span>
                  )}
                  <span className="flex shrink-0 items-center gap-2 text-xs">
                    <span className="text-muted-foreground">
                      {item.stepsDone > 0 ? `${item.stepsDone}/${item.stepsTotal} ${t("progress.done", voice)}` : t("progress.notScheduled", voice)}
                    </span>
                    <button className="hover:bg-accent rounded-md border px-2.5 py-1" onClick={() => run(() => completeItem(item.id))}>
                      {t("action.complete", voice)}
                    </button>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>

        {/* Single-task */}
        <div>
          <SubHeader label={t("section.singleTask", voice)} count={singleTask.length} seeAllHref={SEE_ALL.singleTask} voice={voice} />
          {singleTask.length === 0 ? (
            <EmptyBucket voice={voice} />
          ) : (
            <ul className={cn("space-y-2", pending && "opacity-70")}>
              {singleTask.map((item) => (
                <li key={item.id} className="flex items-center justify-between rounded-lg border px-4 py-2 text-sm">
                  <span className="flex min-w-0 items-center gap-2">
                    <span className="text-primary shrink-0 text-xs font-medium">{t("pill.toDo", voice)}</span>
                    <span className="break-words">{item.text}</span>
                  </span>
                  <span className="flex shrink-0 items-center gap-2 text-xs">
                    <button className="hover:bg-accent rounded-md border px-2.5 py-1" onClick={() => run(() => completeItem(item.id))}>
                      {t("action.complete", voice)}
                    </button>
                    {confirmDeleteId === item.id ? (
                      <span className="flex items-center gap-2">
                        <button className="text-destructive font-medium" onClick={() => confirmDelete(item.id)}>{t("action.delete", voice)}</button>
                        <span className="text-muted-foreground">·</span>
                        <button className="text-muted-foreground hover:text-foreground" onClick={cancelDelete}>{t("action.cancel", voice)}</button>
                      </span>
                    ) : (
                      <button className="text-muted-foreground hover:text-destructive" onClick={() => requestDelete(item.id)}>{t("action.delete", voice)}</button>
                    )}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>

        {/* Saved for later */}
        <div>
          <SubHeader label={t("section.savedLater", voice)} count={savedLater.length} seeAllHref={SEE_ALL.savedLater} voice={voice} />
          {savedLater.length === 0 ? (
            <EmptyBucket voice={voice} />
          ) : (
            <ul className="space-y-2 opacity-70">
              {savedLater.map((item) => (
                <li key={item.id} className="flex items-center justify-between rounded-lg border px-4 py-2 text-sm">
                  <span className="break-words">{item.text}</span>
                  <button className="text-muted-foreground hover:text-foreground shrink-0 text-xs underline" onClick={() => run(() => triageBrainDumpItem(item.id))}>
                    wake now
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        {/* Completed */}
        <div>
          <h2 className="mb-2 flex items-center gap-2 text-sm font-semibold">
            {t("section.completed", voice)}
            <span className="bg-secondary text-secondary-foreground rounded-full px-2 py-0.5 text-xs">
              {t("section.completedToday", voice)}: {completedTodayCount}
            </span>
            <a href="/library?tab=done" className="text-muted-foreground hover:text-foreground ml-auto text-xs font-normal">
              {t("link.seeAll", voice)}
            </a>
          </h2>
          {completed.length === 0 ? (
            <EmptyBucket voice={voice} />
          ) : (
            <ul className="space-y-2 opacity-80">
              {completed.map((item) => (
                <li key={item.id} className="flex items-center justify-between rounded-lg border px-4 py-2 text-sm">
                  <span className="break-words line-through">{item.text}</span>
                  <button className="text-muted-foreground hover:text-foreground shrink-0 text-xs underline" onClick={() => run(() => reopenItem(item.id, undefined))}>
                    {t("action.reopen", voice)}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>
```
Add the `EmptyBucket` helper near `SubHeader`:
```tsx
function EmptyBucket({ voice }: { voice: Voice }) {
  return (
    <p className="text-muted-foreground rounded-lg border border-dashed px-4 py-4 text-center text-xs">
      {t("bucket.empty", voice)}
    </p>
  );
}
```
> Keep the existing "Needs review" section and capture bar above this board exactly as they are.

- [ ] **Step 4: Run to verify pass + existing tests + types.** Run: `npx vitest run src/components/inbox/inbox-view.test.tsx && npx tsc --noEmit` — Expected: PASS (the Phase-A Complete/Completed/Undo tests still pass against the restructured board).

- [ ] **Step 5: Commit.**
```bash
git add src/components/inbox/inbox-view.tsx src/components/inbox/inbox-view.test.tsx
git commit -m "feat(inbox): always-visible To-Do buckets with empty states"
```

---

### Task 9: Multi-step rows — step count + tap-to-expand inline step list

**Files:**
- Modify: `src/components/inbox/inbox-view.tsx`
- Modify: `src/components/inbox/inbox-view.test.tsx`

**Interfaces:**
- Consumes: `TaskSteps` from `@/components/breakdown/task-steps` (each row: `{ id, order, total, text, subtaskEmoji, estMinutes, done }`), `Item.steps` (Task 4).
- Produces: each multi-step row shows a `N steps · M done` indicator and a grip/expander; tapping the row body toggles an inline `TaskSteps` list (Focus / ✓ Complete / Send-to-review per step). A dedicated **grip** control initiates drag in Task 10, so tapping the body only expands.

- [ ] **Step 1: Write the failing tests.** Add to `src/components/inbox/inbox-view.test.tsx` (note: `TaskSteps` renders links/actions; mock `@/components/breakdown/task-steps` to a lightweight stub so this test stays focused on expand behavior):
```ts
vi.mock("@/components/breakdown/task-steps", () => ({
  TaskSteps: ({ steps }: { steps: { id: string; text: string }[] }) => (
    <ol data-testid="inline-steps">{steps.map((s) => <li key={s.id}>{s.text}</li>)}</ol>
  ),
}));

function makeMultiStep() {
  return makeItem({
    id: "m1",
    text: "plan trip",
    status: "triaged",
    taskId: "t1",
    stepsTotal: 3,
    stepsDone: 1,
    steps: [
      { id: "s1", order: 1, text: "book", done: true, estMinutes: 10, subtaskEmoji: null },
      { id: "s2", order: 2, text: "pack", done: false, estMinutes: 20, subtaskEmoji: null },
      { id: "s3", order: 3, text: "go", done: false, estMinutes: 5, subtaskEmoji: null },
    ],
  });
}

describe("InboxView — multi-step step count + expand", () => {
  it("shows a step-count indicator", () => {
    render(<InboxView initialItems={[makeMultiStep()]} settings={settings} />);
    expect(screen.getByText(/3 steps · 1 done/)).toBeInTheDocument();
  });

  it("expands the inline step list when the row body is tapped", async () => {
    const user = userEvent.setup();
    render(<InboxView initialItems={[makeMultiStep()]} settings={settings} />);
    expect(screen.queryByTestId("inline-steps")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /plan trip/ }));
    expect(screen.getByTestId("inline-steps")).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run to verify fail.** Run: `npx vitest run src/components/inbox/inbox-view.test.tsx` — Expected: FAIL (no step-count text / no expand).

- [ ] **Step 3: Implement in `src/components/inbox/inbox-view.tsx`.**
  - Add the import: `import { TaskSteps } from "@/components/breakdown/task-steps";`
  - Add expansion state near the other `useState` hooks: `const [expandedId, setExpandedId] = useState<string | null>(null);`
  - Replace the multi-step `<li>` (from Task 8) with a row that has a tap-to-expand body button, a step-count indicator built from numbers, and the inline `TaskSteps` when expanded:
```tsx
{multiStep.map((item) => {
  const expanded = expandedId === item.id;
  return (
    <li key={item.id} className="rounded-lg border px-4 py-2 text-sm">
      <div className="flex items-center justify-between gap-3">
        <button
          type="button"
          aria-expanded={expanded}
          onClick={() => setExpandedId(expanded ? null : item.id)}
          className="min-w-0 flex-1 break-words text-left hover:underline"
        >
          {item.text}
        </button>
        <span className="flex shrink-0 items-center gap-2 text-xs">
          <span className="text-muted-foreground">
            {item.stepsTotal} steps · {item.stepsDone} {t("progress.done", voice)}
          </span>
          <button className="hover:bg-accent rounded-md border px-2.5 py-1" onClick={() => run(() => completeItem(item.id))}>
            {t("action.complete", voice)}
          </button>
        </span>
      </div>
      {expanded && item.taskId && (
        <div className="mt-2">
          <TaskSteps
            taskId={item.taskId}
            steps={item.steps.map((s) => ({
              id: s.id,
              order: s.order,
              total: item.stepsTotal,
              text: s.text,
              subtaskEmoji: s.subtaskEmoji,
              estMinutes: s.estMinutes,
              done: s.done,
            }))}
          />
        </div>
      )}
    </li>
  );
})}
```
> The step-count reads `"{stepsTotal} steps · {stepsDone} done"` (built from numbers + the existing `progress.done` string — no fixed string key). Tapping the title button toggles the inline `TaskSteps`, which already offers ▶ Focus / ✓ Complete / ↗ Send to review per step (from Phase A + !28).

- [ ] **Step 4: Run to verify pass + types.** Run: `npx vitest run src/components/inbox/inbox-view.test.tsx && npx tsc --noEmit` — Expected: PASS.

- [ ] **Step 5: Commit.**
```bash
git add src/components/inbox/inbox-view.tsx src/components/inbox/inbox-view.test.tsx
git commit -m "feat(inbox): multi-step step-count + tap-to-expand inline step list"
```

---

### Task 10: Wire the shared dispatcher — drag (dnd-kit) + "Move to…" menu + drop prompt

**Files:**
- Modify: `src/components/inbox/inbox-view.tsx`
- Modify: `src/components/inbox/inbox-view.test.tsx`

**Interfaces:**
- Consumes: `dropPlan`, `ACTION_FOR_BUCKET` (Task 5), `bucketOfItem`, `BucketId` (Task 4), `MoveToMenu` (Task 7), `MultiStepDropPrompt` (Task 6), `moveToReview` (Task 2), `@dnd-kit/core` (Task 1).
- Produces: one `moveItemToBucket(itemId, target)` dispatcher used by **both** the menu and drag; buckets are `useDroppable` zones and cards are `useDraggable`; a `dragEndToMove(activeId, overId)` pure helper maps a `DragEndEvent` to `{ itemId, target }`; the multi-step drop prompt opens for `breakdown` targets.

- [ ] **Step 1: Write the failing tests.** Add to `src/components/inbox/inbox-view.test.tsx` (extend the `@/app/actions/braindump` mock with `moveToReview`; the `@/app/actions/breakdown` mock already has `startBreakdown`; `@dnd-kit/core` works in jsdom for rendering — no mock needed):
```ts
// add to the existing vi.mock("@/app/actions/braindump", ...) object:
//   moveToReview: vi.fn().mockResolvedValue(undefined),

import { dragEndToMove } from "@/components/inbox/inbox-view";

describe("dragEndToMove (pure)", () => {
  it("maps an over-a-bucket drop to { itemId, target }", () => {
    expect(dragEndToMove("item-1", "completed")).toEqual({ itemId: "item-1", target: "completed" });
  });
  it("returns null when dropped outside any bucket", () => {
    expect(dragEndToMove("item-1", null)).toBeNull();
  });
});

describe("InboxView — Move to… menu dispatch", () => {
  it("a single-task 'Move to Completed' completes the item", async () => {
    const { completeItem } = await import("@/app/actions/braindump");
    const user = userEvent.setup();
    render(<InboxView initialItems={[makeItem({ id: "s1", text: "todo", status: "triaged" })]} settings={settings} />);
    const row = screen.getByText("todo").closest("li")!;
    await user.click(within(row).getByRole("button", { name: "Move to…" }));
    await user.click(within(row).getByRole("menuitem", { name: /Completed/ }));
    expect(completeItem).toHaveBeenCalledWith("s1");
  });

  it("a single-task 'Move to Needs review' un-triages via moveToReview", async () => {
    const { moveToReview } = await import("@/app/actions/braindump");
    const user = userEvent.setup();
    render(<InboxView initialItems={[makeItem({ id: "s1", text: "todo", status: "triaged" })]} settings={settings} />);
    const row = screen.getByText("todo").closest("li")!;
    await user.click(within(row).getByRole("button", { name: "Move to…" }));
    await user.click(within(row).getByRole("menuitem", { name: /Needs review/ }));
    expect(moveToReview).toHaveBeenCalledWith("s1");
  });

  it("moving a Completed item to Single-task reopens it first", async () => {
    const { reopenItem, triageBrainDumpItem } = await import("@/app/actions/braindump");
    const user = userEvent.setup();
    const done = makeItem({ id: "d1", text: "done item", status: "triaged", completedAt: new Date() });
    render(<InboxView initialItems={[done]} settings={settings} />);
    const row = screen.getByText("done item").closest("li")!;
    await user.click(within(row).getByRole("button", { name: "Move to…" }));
    await user.click(within(row).getByRole("menuitem", { name: /Single-task/ }));
    expect(reopenItem).toHaveBeenCalledWith("d1", undefined);
    expect(triageBrainDumpItem).toHaveBeenCalledWith("d1");
  });

  it("moving an item to Multi-step opens the prompt (no action yet)", async () => {
    const { startBreakdown } = await import("@/app/actions/breakdown");
    const user = userEvent.setup();
    render(<InboxView initialItems={[makeItem({ id: "n1", text: "big thing" })]} settings={settings} />);
    const row = screen.getByText("big thing").closest("li")!;
    await user.click(within(row).getByRole("button", { name: "Move to…" }));
    await user.click(within(row).getByRole("menuitem", { name: /Multi-step/ }));
    expect(screen.getByRole("button", { name: "Break into steps now" })).toBeInTheDocument();
    expect(startBreakdown).not.toHaveBeenCalled();
  });

  it("choosing 'Break into steps now' in the prompt calls startBreakdown", async () => {
    const { startBreakdown } = await import("@/app/actions/breakdown");
    (startBreakdown as ReturnType<typeof vi.fn>).mockResolvedValue("t9");
    const user = userEvent.setup();
    render(<InboxView initialItems={[makeItem({ id: "n1", text: "big thing" })]} settings={settings} />);
    const row = screen.getByText("big thing").closest("li")!;
    await user.click(within(row).getByRole("button", { name: "Move to…" }));
    await user.click(within(row).getByRole("menuitem", { name: /Multi-step/ }));
    await user.click(screen.getByRole("button", { name: "Break into steps now" }));
    expect(startBreakdown).toHaveBeenCalledWith("n1");
  });

  it("choosing 'Save for later' in the prompt snoozes the item", async () => {
    const { snoozeBrainDumpItem } = await import("@/app/actions/braindump");
    const user = userEvent.setup();
    render(<InboxView initialItems={[makeItem({ id: "n1", text: "big thing" })]} settings={settings} />);
    const row = screen.getByText("big thing").closest("li")!;
    await user.click(within(row).getByRole("button", { name: "Move to…" }));
    await user.click(within(row).getByRole("menuitem", { name: /Multi-step/ }));
    await user.click(screen.getByRole("button", { name: "Save for later" }));
    expect(snoozeBrainDumpItem).toHaveBeenCalledWith("n1", 60);
  });
});
```

- [ ] **Step 2: Run to verify fail.** Run: `npx vitest run src/components/inbox/inbox-view.test.tsx` — Expected: FAIL (`dragEndToMove`/`moveToReview`/menu wiring absent).

- [ ] **Step 3: Implement in `src/components/inbox/inbox-view.tsx`.**
  - Extend imports:
```tsx
import {
  DndContext,
  PointerSensor,
  KeyboardSensor,
  useSensor,
  useSensors,
  useDraggable,
  useDroppable,
  type DragEndEvent,
} from "@dnd-kit/core";
import { bucketItems, bucketOfItem, type Item, type BucketId } from "@/components/inbox/bucket";
import { dropPlan } from "@/components/inbox/move-dispatch";
import { MoveToMenu } from "@/components/inbox/move-to-menu";
import { MultiStepDropPrompt } from "@/components/inbox/multi-step-drop-prompt";
```
    and add `moveToReview` to the existing `@/app/actions/braindump` import.
  - Export the pure drag-end mapper (module scope, above `InboxView`):
```tsx
/** Map a dnd-kit drop onto a bucket to a move intent (null when dropped nowhere). */
export function dragEndToMove(
  activeId: string,
  overId: string | null,
): { itemId: string; target: BucketId } | null {
  if (!overId) return null;
  return { itemId: activeId, target: overId as BucketId };
}
```
  - Inside `InboxView`, add prompt state + sensors + the dispatcher (place after the `run`/`breakdown` helpers). Build an `itemsById` map from `initialItems` so the dispatcher can find the source bucket:
```tsx
  const [pendingBreakdown, setPendingBreakdown] = useState<Item | null>(null);
  const sensors = useSensors(useSensor(PointerSensor), useSensor(KeyboardSensor));
  const itemsById = new Map(initialItems.map((i) => [i.id, i]));

  // Single dispatcher shared by drag + the "Move to…" menu (spec: they must not diverge).
  const moveItemToBucket = (itemId: string, target: BucketId) => {
    const item = itemsById.get(itemId);
    if (!item) return;
    const plan = dropPlan(bucketOfItem(item, now), target);
    if (plan.kind === "noop") return;

    if (plan.prompt) {
      // Multi-step target: reopen a completed item first (so it leaves Completed),
      // then ask break-now vs save.
      if (plan.reopenFirst) run(() => reopenItem(itemId, undefined));
      setPendingBreakdown(item);
      return;
    }

    run(async () => {
      if (plan.reopenFirst) await reopenItem(itemId, undefined);
      switch (plan.action) {
        case "moveToReview": await moveToReview(itemId); break;
        case "triage":       await triageBrainDumpItem(itemId); break;
        case "snooze":       await snoozeBrainDumpItem(itemId, 60); break;
        case "complete":     await completeItem(itemId); break;
        // "breakdown" is handled by the prompt branch above.
      }
    });
  };

  const handleDragEnd = (e: DragEndEvent) => {
    const move = dragEndToMove(String(e.active.id), e.over ? String(e.over.id) : null);
    if (move) moveItemToBucket(move.itemId, move.target);
  };
```
  - Wrap the To-Do board (the `<section>` from Task 8) in `<DndContext sensors={sensors} onDragEnd={handleDragEnd}>…</DndContext>`.
  - Make each bucket a drop zone. Add a `DroppableBucket` wrapper near `EmptyBucket`:
```tsx
function DroppableBucket({ id, children }: { id: BucketId; children: React.ReactNode }) {
  const { setNodeRef, isOver } = useDroppable({ id });
  return (
    <div ref={setNodeRef} data-bucket={id} className={cn("rounded-lg", isOver && "ring-primary ring-2")}>
      {children}
    </div>
  );
}
```
    Wrap each bucket's `<div>` body (Multi-step, Single-task, Saved for later, Completed) with `<DroppableBucket id="multiStep">…`, `id="singleTask"`, `id="savedLater"`, `id="completed"`, and wrap the Needs review `<ul>`/empty region in `<DroppableBucket id="needsReview">`.
  - Make each item card draggable via a grip. Add a `DragGrip` wrapper near `EmptyBucket`:
```tsx
function DragGrip({ id, label }: { id: string; label: string }) {
  const { attributes, listeners, setNodeRef } = useDraggable({ id });
  return (
    <button
      ref={setNodeRef}
      {...attributes}
      {...listeners}
      aria-label={`Drag ${label}`}
      className="text-muted-foreground hover:text-foreground shrink-0 cursor-grab px-1 text-xs"
    >
      ⠿
    </button>
  );
}
```
    Add a `<DragGrip id={item.id} label={item.text} />` and a `<MoveToMenu currentBucket={bucketOfItem(item, now)} voice={voice} onMove={(target) => moveItemToBucket(item.id, target)} />` to each row (needs-review `ItemRow`, single-task, multi-step, saved-later, completed). For `ItemRow`, thread `onMove` + a `moveMenu` element through props (pass `<MoveToMenu .../>` as a `renderMoveMenu` prop or render it in the action row). Keep the grip on the multi-step row **outside** the tap-to-expand title button so a body tap expands and only the grip drags.
  - Render the prompt once, after the board, driven by `pendingBreakdown`:
```tsx
{pendingBreakdown && (
  <MultiStepDropPrompt
    itemText={pendingBreakdown.text}
    voice={voice}
    onBreakNow={() => {
      const id = pendingBreakdown.id;
      setPendingBreakdown(null);
      startTransition(async () => {
        const taskId = await startBreakdown(id);
        if (taskId) router.push(`/tasks/${taskId}`);
      });
    }}
    onSaveLater={() => {
      const id = pendingBreakdown.id;
      setPendingBreakdown(null);
      run(() => snoozeBrainDumpItem(id, 60));
    }}
    onCancel={() => setPendingBreakdown(null)}
  />
)}
```

> **jsdom limitation:** pointer/keyboard drag from `@dnd-kit/core` is not reliably simulatable in jsdom, so the tests exercise the dispatch via the `dragEndToMove` pure mapper + the "Move to…" menu (which shares `moveItemToBucket`). Real drag is covered by the manual verify step in Task 11.

- [ ] **Step 4: Run to verify pass + types + full inbox suite.** Run: `npx vitest run src/components/inbox && npx tsc --noEmit` — Expected: PASS.

- [ ] **Step 5: Commit.**
```bash
git add src/components/inbox/inbox-view.tsx src/components/inbox/inbox-view.test.tsx
git commit -m "feat(inbox): drag-to-move + Move to… menu + multi-step drop prompt (shared dispatch)"
```

---

### Task 11: Full verification + MR

- [ ] **Step 1: Full test suite.** Run: `npx vitest run` — Expected: all green (Phase A suites + new Phase B suites).
- [ ] **Step 2: Types + build.** Run: `npx tsc --noEmit && npm run build` — Expected: clean.
- [ ] **Step 3: Manual `/verify` smoke** (local dev DB; `docker compose up -d db && npm run dev`):
  - The To-Do board shows all four buckets with "Nothing here yet" when empty.
  - Drag a Needs-review item onto **Single-task** → it triages (appears under Single-task). Drag onto **Saved for later** → snoozes. Drag onto **Completed** → completes (line-through, "Completed today" increments).
  - Drag a to-do onto **Needs review** → returns to the review queue (task/steps preserved: re-break-down reuses the same task).
  - Drag onto **Multi-step** → the break-now / save prompt appears; "Break into steps now" opens the editor, "Save for later" snoozes; Escape cancels.
  - Drag a **Completed** item elsewhere → it reopens then applies the target action.
  - Keyboard-only: use the **Move to…** menu on a row → same outcomes as drag.
  - A multi-step row shows `N steps · M done`; tapping the title expands the inline step list (Focus / ✓ Complete / Send to review); tapping again collapses.
  - Confirm Plain voice shows no decorative emoji anywhere new.
- [ ] **Step 4: Push + open MR.** Push `feat/complete-bucket-phase-b` (branch from current `main`); open MR → `main`, reviewer @GitLabDuo, milestone v0.0.2, description linking #10 (Phase B of the complete-bucket spec) and noting it completes the Phase B checklist. **Do not merge** — owner approval required; wait for Duo's review and apply sensible suggestions (if Duo errors, self-review + document + merge only with the owner's standing pre-authorization).
- [ ] **Step 5: Tick the Phase B checkboxes** in work item #10's description (JSON `PUT` with `Content-Type: application/json`) once merged + prod-verified.

---

## Self-Review

**1. Spec coverage (Phase B section of the spec):**
- Always-visible buckets + empty states → Task 8 ✓
- Drag-to-move with action-on-drop table (review/single/multi/saved/completed) → Task 5 (mapping) + Task 10 (wiring) ✓
- `moveToReview` (keep task, un-triage) → Task 2 ✓ (locked decision followed; stale "detach/archive" test bullet noted + overridden)
- Same-bucket no-op; completed-source reopen-first → Task 5 `dropPlan` + Task 10 dispatcher ✓
- Multi-step drop prompt (break-now → editor / save) → Task 6 (component) + Task 10 (wiring) ✓
- Multi-step step count + inline expand + focus → Task 9 (reuses `TaskSteps`) ✓
- `@dnd-kit/core` drag (droppable buckets + draggable grip) → Task 1 + Task 10 ✓
- "Move to…" a11y menu sharing one dispatcher → Task 7 + Task 10 ✓
- Inbox query includes step details for the inline list → Task 4 Step 5 ✓
- Voice strings (`bucket.empty`, `action.moveTo`, `prompt.breakNow`, `prompt.saveInstead`; step count templated from numbers) → Task 3 ✓
- Tests: `moveToReview`, drop-action dispatch unit, bucket-board render, drop prompt, Move-to menu → Tasks 2, 5, 8, 6, 7/10 ✓

**2. Placeholder scan:** No TBD/TODO/"handle edge cases"/"similar to Task N" — every code step shows the code. ✓

**3. Type consistency:** `BucketId` defined in Task 4 (bucket.ts), consumed by Tasks 5/7/10. `bucketOfItem(item, now)` defined Task 4, used Task 10. `ACTION_FOR_BUCKET`/`dropPlan`/`DropPlan` (with `action`/`reopenFirst`/`prompt`) defined Task 5, consumed Task 10. `moveToReview(id)` defined Task 2, consumed Task 10. `MultiStepDropPrompt` props (`itemText`/`voice`/`onBreakNow`/`onSaveLater`/`onCancel`) Task 6 → Task 10. `MoveToMenu` props (`currentBucket`/`voice`/`onMove`) Task 7 → Task 10. `dragEndToMove(activeId, overId)` defined + exported Task 10, tested Task 10. `Item.steps` widened Task 4 (adds `estMinutes`/`subtaskEmoji`), consumed by the `TaskSteps` mapping in Task 9. ✓

**Deferred (not in this plan):** the real `/library?tab=done` Done view (Phase 3 stub); within-bucket reordering; per-step picker mid-drag for completed multi-step (whole-task reopen only).
