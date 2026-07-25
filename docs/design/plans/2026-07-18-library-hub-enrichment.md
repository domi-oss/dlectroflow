# Library Hub Enrichment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Library hub as alive/ADHD-supportive as the Inbox — rename it, give the Multi-step tab inline expansion at inbox parity, add Select-mode bulk edit and curated collapsed-row meta (incl. an editable single-task estimate), and fold in GitLabDuo's formatter de-dup.

**Architecture:** Extend the Library's own client components and **reuse** the Inbox's step list (`TaskSteps`), row primitives (`RowActions`/`CompleteButton`), and the existing workspace-scoped braindump server actions. Add exactly one additive nullable DB column (`BrainDumpItem.estMinutes`) and two server actions (`setItemEstimate`, `bulkBrainDumpAction`). `inbox-view.tsx` behavior is untouched (only a formatter import swap).

**Tech Stack:** Next.js (modified fork — see Global Constraints), React (client components), Prisma/Postgres, TypeScript, Vitest + Testing Library (jsdom).

## Global Constraints

- **This is a modified Next.js fork.** Before writing any Next-specific code, read the relevant guide in `node_modules/next/dist/docs/`. Heed deprecation notices.
- **Voice layer:** all user-facing text resolves via `t(key, voice)`. `t()` returns a **static** string — there is **no `{n}` interpolation**; compose numbers in JSX around static unit strings. Plain voice = no decorative emoji; the **emoji anchor is playful-voice only**.
- **Workspace isolation:** every server action resolves `currentWorkspaceId()` and filters every query by it (IDOR-safe). Never trust caller-supplied ids without a `workspaceId` guard.
- **Branch/MR:** work on `feat/library-hub` (!83). **Do NOT merge** — owner sign-off + GitLabDuo re-review gate the merge.
- **Gates before every push:** `npx tsc --noEmit` clean · `npm run lint` 0 errors · `npx vitest run --exclude '**/*.integration.test.ts'` all green.
- **Discipline:** DRY, YAGNI, TDD, one commit per task.
- Run all commands from the worktree root: `/Users/gitlab_dlectronique/workdev/dlectroflow/.claude/worktrees/library-hub`.

## File Structure

**Create:**
- `src/lib/format.ts` — pure `formatAgo` / `formatWake`.
- `src/lib/format.test.ts` — unit tests.
- `src/components/library/library-row-meta.tsx` — pure meta helpers + presentational meta bits.
- `src/components/library/library-row-meta.test.tsx` — unit tests for the helpers.
- `src/components/library/use-select-mode.ts` — shared select-mode hook.
- `src/components/library/select-action-bar.tsx` — presentational bulk-action bar.
- `src/components/library/library-multistep.tsx` — client Multi-step tab (expand + meta + select).
- `src/components/library/library-multistep.test.tsx` — RTL tests.
- `src/components/library/library-rows.test.tsx` — RTL tests for the extended single-task rows.
- `prisma/migrations/<ts>_braindump_item_est_minutes/migration.sql` — additive column.

**Modify:**
- `prisma/schema.prisma` — add `estMinutes Int?` to `BrainDumpItem`.
- `src/components/inbox/bucket.ts` — add `estMinutes` to the `Item` type.
- `src/app/actions/braindump.ts` — add `setItemEstimate` + `bulkBrainDumpAction`.
- `src/lib/strings.ts` — rename `nav.everything` value + new keys.
- `src/components/library/library-rows.tsx` — import shared formatter; add select-mode, meta, inline estimate editor.
- `src/components/inbox/inbox-view.tsx` — import shared `formatAgo` (delete local copy).
- `src/app/(app)/library/page.tsx` — wire Multi-step → `LibraryMultistep`; pass `agingSettings`/`now`/`estMinutes`; add Select entry on the two to-do tabs.

---

## Task 1: Shared time formatter (Duo !83 nit)

**Files:**
- Create: `src/lib/format.ts`
- Create: `src/lib/format.test.ts`
- Modify: `src/components/library/library-rows.tsx:162-180` (delete local copies, import instead) and `:113,:115` (call sites already use the names)
- Modify: `src/components/inbox/inbox-view.tsx:1634-1643` (delete local `formatAgo`, import)

**Interfaces:**
- Produces: `formatAgo(ms: number): string`, `formatWake(when: Date | string): string`

- [ ] **Step 1: Write the failing test**

```ts
// src/lib/format.test.ts
import { describe, it, expect } from "vitest";
import { formatAgo, formatWake } from "./format";

describe("formatAgo", () => {
  it("renders seconds/minutes/hours/days", () => {
    expect(formatAgo(5_000)).toBe("5s ago");
    expect(formatAgo(5 * 60_000)).toBe("5m ago");
    expect(formatAgo(3 * 3_600_000)).toBe("3h ago");
    expect(formatAgo(2 * 86_400_000)).toBe("2d ago");
  });
});

describe("formatWake", () => {
  it("accepts a Date and a string and returns a weekday + time", () => {
    const d = new Date("2026-07-20T08:00:00");
    expect(formatWake(d)).toBe(formatWake(d.toISOString()));
    expect(formatWake(d)).toMatch(/\w{3}/); // "Mon" etc.
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/format.test.ts`
Expected: FAIL — cannot find module `./format`.

- [ ] **Step 3: Create the module**

```ts
// src/lib/format.ts
/** Compact relative age, e.g. "2h ago". */
export function formatAgo(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

/** Wake time for a saved-for-later row, e.g. "Mon 08:00". */
export function formatWake(when: Date | string): string {
  return new Date(when).toLocaleString(undefined, {
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}
```

- [ ] **Step 4: Swap the call sites to the shared module**

In `src/components/library/library-rows.tsx`: add to the import block near the top:
```ts
import { formatAgo, formatWake } from "@/lib/format";
```
Then **delete** the two local functions at the bottom (`function formatAgo…` and `function formatWake…`, lines ~162-180). The existing call sites (`formatAgo(now - …)`, `formatWake(item.snoozedUntil)`) are unchanged.

In `src/components/inbox/inbox-view.tsx`: add `import { formatAgo } from "@/lib/format";` to the imports and **delete** the local `function formatAgo(ms: number): string { … }` (lines ~1634-1643). Do not touch anything else in this file.

- [ ] **Step 5: Verify tests + gates**

Run: `npx vitest run src/lib/format.test.ts && npx tsc --noEmit && npm run lint`
Expected: format tests PASS; tsc clean; lint 0 errors.

- [ ] **Step 6: Run the full suite (no regressions from the import swap)**

Run: `npx vitest run --exclude '**/*.integration.test.ts'`
Expected: all pass (same count as before + the new format tests).

- [ ] **Step 7: Commit**

```bash
git add src/lib/format.ts src/lib/format.test.ts src/components/library/library-rows.tsx src/components/inbox/inbox-view.tsx
git commit -m "refactor(#8): extract shared formatAgo/formatWake to lib/format (Duo !83 nit)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: `estMinutes` column + `Item` field

**Files:**
- Modify: `prisma/schema.prisma` (model `BrainDumpItem`)
- Create: `prisma/migrations/<timestamp>_braindump_item_est_minutes/migration.sql`
- Modify: `src/components/inbox/bucket.ts` (`Item` type, ~line 32)
- Modify: `src/app/(app)/library/page.tsx` (item mapping)

**Interfaces:**
- Produces: `BrainDumpItem.estMinutes: number | null` (DB) and `Item.estMinutes: number | null` (type).

- [ ] **Step 1: Add the column to the schema**

In `prisma/schema.prisma`, inside `model BrainDumpItem`, add after `completedAt`:
```prisma
  estMinutes       Int?      // single-task time estimate (minutes); null → display default 5
```

- [ ] **Step 2: Generate the migration**

Run: `npx prisma migrate dev --name braindump_item_est_minutes --create-only`
This creates `prisma/migrations/<timestamp>_braindump_item_est_minutes/migration.sql`. Confirm its contents are exactly (additive, nullable — safe, no backfill/lock):
```sql
-- AlterTable
ALTER TABLE "BrainDumpItem" ADD COLUMN "estMinutes" INTEGER;
```

- [ ] **Step 3: Apply + regenerate client**

Run: `npx prisma migrate dev` (applies) then confirm `npx prisma generate` ran. Expected: migration applied, Prisma Client typechecks `estMinutes`.

- [ ] **Step 4: Add `estMinutes` to the `Item` type**

In `src/components/inbox/bucket.ts`, in the `Item` type add (near `scheduledAt`):
```ts
  /** Single-task time estimate in minutes; null → display default of 5. */
  estMinutes: number | null;
```

- [ ] **Step 5: Thread it through the page mapping**

In `src/app/(app)/library/page.tsx`, in the `rawItems.map(...)` that builds `Item[]`, add the field (the `findMany` already selects all scalar columns, so `item.estMinutes` exists):
```ts
    estMinutes: item.estMinutes,
```

- [ ] **Step 6: Verify**

Run: `npx tsc --noEmit`
Expected: clean (the new field is required on `Item`; the page now supplies it). If any other constructor of `Item` exists it must also supply `estMinutes` — grep `: Item = {` / `stepsTotal:` to confirm the inbox page maps through Prisma rows too; if a second mapping breaks, add `estMinutes: item.estMinutes` there as well.

- [ ] **Step 7: Commit**

```bash
git add prisma/schema.prisma prisma/migrations src/components/inbox/bucket.ts "src/app/(app)/library/page.tsx"
git commit -m "feat(#8): add nullable BrainDumpItem.estMinutes + Item field

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: `setItemEstimate` server action

**Files:**
- Modify: `src/app/actions/braindump.ts` (add export)
- Create: test `src/app/actions/set-estimate.test.ts`

**Interfaces:**
- Consumes: `prisma`, `currentWorkspaceId`, `INBOX_PATH` (all already in the file).
- Produces: `setItemEstimate(id: string, minutes: number): Promise<void>`

- [ ] **Step 1: Write the failing test** (mirror the existing `snooze.test.ts` mocking style — inspect it first for the exact `prisma`/`currentWorkspaceId` mocks)

```ts
// src/app/actions/set-estimate.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";

const updateMany = vi.fn();
vi.mock("@/lib/db", () => ({ prisma: { brainDumpItem: { updateMany: (...a: unknown[]) => updateMany(...a) } } }));
vi.mock("@/lib/workspace", () => ({ currentWorkspaceId: () => Promise.resolve("ws1") }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { setItemEstimate } from "./braindump";

beforeEach(() => updateMany.mockReset().mockResolvedValue({ count: 1 }));

describe("setItemEstimate", () => {
  it("scopes the update to the current workspace", async () => {
    await setItemEstimate("i1", 25);
    expect(updateMany).toHaveBeenCalledWith({
      where: { id: "i1", workspaceId: "ws1" },
      data: { estMinutes: 25 },
    });
  });
  it("clamps to [1, 600] and rounds", async () => {
    await setItemEstimate("i1", 0);
    expect(updateMany).toHaveBeenLastCalledWith(expect.objectContaining({ data: { estMinutes: 1 } }));
    await setItemEstimate("i1", 9999);
    expect(updateMany).toHaveBeenLastCalledWith(expect.objectContaining({ data: { estMinutes: 600 } }));
    await setItemEstimate("i1", 12.6);
    expect(updateMany).toHaveBeenLastCalledWith(expect.objectContaining({ data: { estMinutes: 13 } }));
  });
  it("ignores non-finite input", async () => {
    await setItemEstimate("i1", Number.NaN);
    expect(updateMany).not.toHaveBeenCalled();
  });
});
```

> Note: match the actual mock shape used by `src/app/actions/snooze.test.ts`. If that suite mocks a full `prisma` client, copy its mock object and add `brainDumpItem.updateMany`.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/app/actions/set-estimate.test.ts`
Expected: FAIL — `setItemEstimate` is not exported.

- [ ] **Step 3: Implement the action** (append to `src/app/actions/braindump.ts`)

```ts
/**
 * Set a single-task item's time estimate (minutes). Workspace-scoped +
 * IDOR-safe via updateMany's workspace filter. Clamped to a sane [1, 600].
 */
export async function setItemEstimate(id: string, minutes: number) {
  if (!Number.isFinite(minutes)) return;
  const workspaceId = await currentWorkspaceId();
  const clamped = Math.max(1, Math.min(600, Math.round(minutes)));
  await prisma.brainDumpItem.updateMany({
    where: { id, workspaceId },
    data: { estMinutes: clamped },
  });
  revalidatePath(INBOX_PATH);
  revalidatePath("/library");
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/app/actions/set-estimate.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/app/actions/braindump.ts src/app/actions/set-estimate.test.ts
git commit -m "feat(#8): setItemEstimate server action (workspace-scoped, clamped)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: `bulkBrainDumpAction` server action

**Files:**
- Modify: `src/app/actions/braindump.ts` (add export)
- Create: test `src/app/actions/bulk-action.test.ts`

**Design note:** the action **reuses** the existing per-item actions (`completeItem`, `snoozeBrainDumpItem`, `deleteBrainDumpItem`) rather than reimplementing their reward/badge/streak/graduation logic. It first filters ids to the caller's workspace (accurate count + explicit IDOR guard), then loops. This deliberately trades the spec's "single transaction/single revalidate" for DRY + reuse of well-tested logic (the redundant `revalidatePath` calls are harmless).

**Interfaces:**
- Consumes: `completeItem`, `snoozeBrainDumpItem`, `deleteBrainDumpItem` (same module), `prisma`, `currentWorkspaceId`.
- Produces: `bulkBrainDumpAction(ids: string[], action: "complete" | "saveForLater" | "delete"): Promise<{ count: number }>`

- [ ] **Step 1: Write the failing test**

```ts
// src/app/actions/bulk-action.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";

const findMany = vi.fn();
vi.mock("@/lib/db", () => ({
  prisma: { brainDumpItem: { findMany: (...a: unknown[]) => findMany(...a) } },
}));
vi.mock("@/lib/workspace", () => ({ currentWorkspaceId: () => Promise.resolve("ws1") }));

// Spy on the per-item actions this action reuses.
const completeItem = vi.fn();
const snoozeBrainDumpItem = vi.fn();
const deleteBrainDumpItem = vi.fn();
vi.mock("./braindump", async (orig) => {
  const actual = await (orig as () => Promise<Record<string, unknown>>)();
  return { ...actual, completeItem, snoozeBrainDumpItem, deleteBrainDumpItem };
});

import { bulkBrainDumpAction } from "./braindump";

beforeEach(() => {
  [completeItem, snoozeBrainDumpItem, deleteBrainDumpItem, findMany].forEach((f) => f.mockReset());
});

describe("bulkBrainDumpAction", () => {
  it("acts only on ids owned by the workspace and returns the count", async () => {
    findMany.mockResolvedValue([{ id: "a" }, { id: "b" }]); // "c" filtered out
    const res = await bulkBrainDumpAction(["a", "b", "c"], "delete");
    expect(findMany).toHaveBeenCalledWith({
      where: { id: { in: ["a", "b", "c"] }, workspaceId: "ws1" },
      select: { id: true },
    });
    expect(deleteBrainDumpItem).toHaveBeenCalledTimes(2);
    expect(res).toEqual({ count: 2 });
  });
  it("routes saveForLater to a 60-minute snooze", async () => {
    findMany.mockResolvedValue([{ id: "a" }]);
    await bulkBrainDumpAction(["a"], "saveForLater");
    expect(snoozeBrainDumpItem).toHaveBeenCalledWith("a", 60);
  });
  it("no-ops on empty input", async () => {
    const res = await bulkBrainDumpAction([], "complete");
    expect(res).toEqual({ count: 0 });
    expect(findMany).not.toHaveBeenCalled();
  });
});
```

> Note: self-mocking the module (`vi.mock("./braindump", …)`) can be finicky. If it fights the toolchain, instead extract the three reused calls behind a thin dispatch you can inject, OR assert on `prisma`-level effects. Keep the *behavior* asserted: workspace filtering, per-action routing, count.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/app/actions/bulk-action.test.ts`
Expected: FAIL — `bulkBrainDumpAction` not exported.

- [ ] **Step 3: Implement** (append to `src/app/actions/braindump.ts`)

```ts
/**
 * Bulk edit for the Library to-do tabs. Reuses the per-item actions (which are
 * each workspace-scoped + carry the reward/badge/streak/graduation logic) so we
 * never re-implement that. Pre-filters ids to the caller's workspace for an
 * accurate count + explicit IDOR guard.
 */
export async function bulkBrainDumpAction(
  ids: string[],
  action: "complete" | "saveForLater" | "delete",
): Promise<{ count: number }> {
  if (!ids.length) return { count: 0 };
  const workspaceId = await currentWorkspaceId();
  const owned = await prisma.brainDumpItem.findMany({
    where: { id: { in: ids }, workspaceId },
    select: { id: true },
  });
  for (const { id } of owned) {
    if (action === "delete") await deleteBrainDumpItem(id);
    else if (action === "saveForLater") await snoozeBrainDumpItem(id, 60);
    else await completeItem(id);
  }
  return { count: owned.length };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/app/actions/bulk-action.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/app/actions/braindump.ts src/app/actions/bulk-action.test.ts
git commit -m "feat(#8): bulkBrainDumpAction (complete/saveForLater/delete, workspace-scoped)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: Rename "Everything" → "Library" + new strings

**Files:**
- Modify: `src/lib/strings.ts` (`nav.everything` value + new keys)
- Create/Modify: `src/lib/strings.test.ts` (add assertions; create if absent)

**Interfaces:**
- Produces new `StringKey`s: `lib.select`, `lib.selectAll`, `lib.selected`, `lib.openTask`, `lib.deleteConfirm`, `lib.next`, `lib.minLeft`, `lib.min`, `lib.editEstimate`. (Note: adding keys to `STRINGS` auto-extends `StringKey = keyof typeof STRINGS`.)

- [ ] **Step 1: Write the failing test**

```ts
// src/lib/strings.test.ts  (add these; create file with imports if it doesn't exist)
import { describe, it, expect } from "vitest";
import { t } from "./strings";

describe("library strings", () => {
  it("renames Everything → Library (plain) keeping Larder (playful)", () => {
    expect(t("nav.everything", "plain")).toBe("Library");
    expect(t("nav.everything", "playful")).toBe("🍱 Larder");
  });
  it("has the new bulk/meta keys in both voices", () => {
    for (const k of ["lib.select","lib.selectAll","lib.selected","lib.openTask","lib.deleteConfirm","lib.next","lib.minLeft","lib.min","lib.editEstimate"] as const) {
      expect(t(k, "plain")).toBeTruthy();
      expect(t(k, "playful")).toBeTruthy();
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/strings.test.ts`
Expected: FAIL — `nav.everything` still "Everything"; new keys don't exist (also a TS error on the unknown keys).

- [ ] **Step 3: Edit `src/lib/strings.ts`**

Change line ~74:
```ts
  "nav.everything":      { plain: "Library",           playful: "🍱 Larder" },
```
Add these keys near the other `lib.*` keys (keep the column alignment style of the block):
```ts
  "lib.select":          { plain: "Select",            playful: "Select" },
  "lib.selectAll":       { plain: "Select all",        playful: "Select all" },
  "lib.selected":        { plain: "selected",          playful: "selected" },
  "lib.openTask":        { plain: "Open task",         playful: "Open task" },
  "lib.deleteConfirm":   { plain: "Delete these?",     playful: "Delete these?" },
  "lib.next":            { plain: "Next:",             playful: "Next:" },
  "lib.minLeft":         { plain: "min left",          playful: "min left" },
  "lib.min":             { plain: "min",               playful: "min" },
  "lib.editEstimate":    { plain: "Edit estimate",     playful: "Edit estimate" },
```

- [ ] **Step 4: Run tests + tsc**

Run: `npx vitest run src/lib/strings.test.ts && npx tsc --noEmit`
Expected: PASS + clean.

- [ ] **Step 5: Commit**

```bash
git add src/lib/strings.ts src/lib/strings.test.ts
git commit -m "feat(#8): rename hub to Library (plain) + Library bulk/meta strings

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: Collapsed-row meta — pure helpers + presentational bits

**Files:**
- Create: `src/components/library/library-row-meta.tsx`
- Create: `src/components/library/library-row-meta.test.tsx`

**Interfaces:**
- Consumes: `Item` (from `@/components/inbox/bucket`), `AgingSettings` + `isAging` (from `@/lib/aging`), `t`/`Voice` (from `@/lib/strings`).
- Produces (pure, exported for reuse + test):
  - `nextStepText(item: Item): string | null`
  - `remainingMinutes(item: Item): number` — Σ `estMinutes` of not-done steps
  - `singleTaskEstimate(item: Item): number` — `item.estMinutes ?? 5`
  - `rowEmoji(item: Item): string | null` — first not-done step's `subtaskEmoji` (fallback first step)
- Produces (components): `RowNumber`, `NextStepLine`, `ProgressBar`, `AgeLabel`, `EstimatePill` — small presentational pieces the row shells compose. `AgeLabel` takes `{ item, now, voice, settings }` and applies the amber accent when `isAging`.

- [ ] **Step 1: Write the failing test**

```tsx
// src/components/library/library-row-meta.test.tsx
import { describe, it, expect } from "vitest";
import { nextStepText, remainingMinutes, singleTaskEstimate, rowEmoji } from "./library-row-meta";
import type { Item } from "@/components/inbox/bucket";

const base: Item = {
  id: "1", text: "T", createdAt: new Date(), status: "triaged", triagedAt: null,
  remindedAt: null, snoozedUntil: null, taskId: "t1", freshenedAt: null,
  promptDismissedAt: null, breakdownRequestedAt: null, stepsTotal: 3, stepsDone: 1,
  taskStatus: "active", completedAt: null, scheduledAt: null, estMinutes: null,
  steps: [
    { id: "s1", order: 1, text: "one", done: true, estMinutes: 10, subtaskEmoji: "🍳", resumable: false },
    { id: "s2", order: 2, text: "two", done: false, estMinutes: 15, subtaskEmoji: "🥕", resumable: false },
    { id: "s3", order: 3, text: "three", done: false, estMinutes: 5, subtaskEmoji: null, resumable: false },
  ],
};

describe("meta helpers", () => {
  it("nextStepText picks the first not-done step", () => {
    expect(nextStepText(base)).toBe("two");
    expect(nextStepText({ ...base, steps: [] })).toBeNull();
  });
  it("remainingMinutes sums only not-done step minutes", () => {
    expect(remainingMinutes(base)).toBe(20); // 15 + 5
  });
  it("singleTaskEstimate falls back to 5 when null", () => {
    expect(singleTaskEstimate({ ...base, estMinutes: null })).toBe(5);
    expect(singleTaskEstimate({ ...base, estMinutes: 12 })).toBe(12);
  });
  it("rowEmoji is the first not-done step's emoji", () => {
    expect(rowEmoji(base)).toBe("🥕");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/components/library/library-row-meta.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the helpers + presentational bits**

```tsx
// src/components/library/library-row-meta.tsx
import { cn } from "@/lib/utils";
import { t, type Voice } from "@/lib/strings";
import { isAging, type AgingSettings } from "@/lib/aging";
import { formatAgo } from "@/lib/format";
import type { Item } from "@/components/inbox/bucket";

export function nextStepText(item: Item): string | null {
  return item.steps.find((s) => !s.done)?.text ?? null;
}
export function remainingMinutes(item: Item): number {
  return item.steps.filter((s) => !s.done).reduce((n, s) => n + (s.estMinutes || 0), 0);
}
export function singleTaskEstimate(item: Item): number {
  return item.estMinutes ?? 5;
}
export function rowEmoji(item: Item): string | null {
  return (item.steps.find((s) => !s.done) ?? item.steps[0])?.subtaskEmoji ?? null;
}

/** Subtle tabular row index, e.g. "2." */
export function RowNumber({ n }: { n: number }) {
  return <span className="text-muted-foreground min-w-[1.25rem] text-right text-xs tabular-nums">{n}.</span>;
}

/** "Next: <step>" preview (multi-step only). */
export function NextStepLine({ item, voice }: { item: Item; voice: Voice }) {
  const next = nextStepText(item);
  if (!next) return null;
  return (
    <p className="text-muted-foreground truncate text-xs">
      {t("lib.next", voice)} <span className="text-foreground">{next}</span>
    </p>
  );
}

/** Thin progress bar (multi-step only). */
export function ProgressBar({ item }: { item: Item }) {
  if (item.stepsTotal <= 0) return null;
  const pct = Math.round((item.stepsDone / item.stepsTotal) * 100);
  return (
    <div className="bg-secondary mt-1 h-1 w-full max-w-[180px] overflow-hidden rounded-full">
      <div className="bg-primary h-full" style={{ width: `${pct}%` }} />
    </div>
  );
}

/** "added Xh ago" with an amber accent once the item is aging. */
export function AgeLabel({ item, now, voice, settings }: { item: Item; now: number; voice: Voice; settings: AgingSettings }) {
  const aging = isAging(item.createdAt, settings);
  return (
    <span className={cn("text-xs", aging ? "text-amber-600" : "text-muted-foreground")}>
      {t("lib.added", voice)} {formatAgo(now - new Date(item.createdAt).getTime())}
    </span>
  );
}

/** Right-aligned estimate pill. `min left` for multi-step, `min` for single. */
export function EstimatePill({ minutes, voice, variant }: { minutes: number; voice: Voice; variant: "left" | "flat" }) {
  if (minutes <= 0) return null;
  return (
    <span className="text-muted-foreground shrink-0 rounded-full border px-2 py-0.5 text-xs">
      ≈{minutes} {t(variant === "left" ? "lib.minLeft" : "lib.min", voice)}
    </span>
  );
}
```

> Emoji anchor: rendered only in the **playful** row shells (Tasks 7/8) — the helper exposes it, but Plain never renders it. `t("lib.added", …)` already exists (used by the current `library-rows.tsx`).

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/components/library/library-row-meta.test.tsx`
Expected: PASS.

- [ ] **Step 5: tsc + commit**

Run: `npx tsc --noEmit` (expect clean)
```bash
git add src/components/library/library-row-meta.tsx src/components/library/library-row-meta.test.tsx
git commit -m "feat(#8): pure Library row-meta helpers + presentational bits

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 7: Select-mode hook + action bar

**Files:**
- Create: `src/components/library/use-select-mode.ts`
- Create: `src/components/library/select-action-bar.tsx`

**Interfaces:**
- Produces:
  - `useSelectMode(): { selecting: boolean; selected: Set<string>; enter(): void; exit(): void; toggle(id: string): void; selectAll(ids: string[]): void }`
  - `SelectActionBar` component — props below.

- [ ] **Step 1: Implement the hook** (no separate unit test — covered via the row RTL tests in Tasks 8/9; the hook is trivial state)

```ts
// src/components/library/use-select-mode.ts
"use client";
import { useCallback, useState } from "react";

export function useSelectMode() {
  const [selecting, setSelecting] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(() => new Set());

  const enter = useCallback(() => setSelecting(true), []);
  const exit = useCallback(() => { setSelecting(false); setSelected(new Set()); }, []);
  const toggle = useCallback((id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    }), []);
  const selectAll = useCallback((ids: string[]) =>
    setSelected((prev) => (prev.size === ids.length ? new Set() : new Set(ids))), []);

  return { selecting, selected, enter, exit, toggle, selectAll };
}
```

- [ ] **Step 2: Implement the action bar**

```tsx
// src/components/library/select-action-bar.tsx
"use client";
import { useState } from "react";
import { t, type Voice } from "@/lib/strings";

/**
 * Sticky bulk-action bar shown while selecting. Delete is a two-step confirm
 * mirroring the row delete: first tap swaps to "Delete these? · Confirm ·
 * Cancel". Actions are disabled while none are selected or a call is pending.
 */
export function SelectActionBar({
  count, voice, pending, onComplete, onSaveForLater, onDelete,
}: {
  count: number;
  voice: Voice;
  pending: boolean;
  onComplete: () => void;
  onSaveForLater: () => void;
  onDelete: () => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const disabled = count === 0 || pending;
  return (
    <div className="bg-secondary/60 sticky bottom-2 z-10 flex items-center gap-2 rounded-lg border px-3 py-2 text-sm backdrop-blur">
      <span className="font-medium">{count} {t("lib.selected", voice)}</span>
      <span className="flex-1" />
      {confirming ? (
        <>
          <span className="text-muted-foreground">{t("lib.deleteConfirm", voice)}</span>
          <button
            className="text-destructive rounded-md px-2.5 py-1 font-medium disabled:opacity-50"
            disabled={disabled}
            onClick={() => { setConfirming(false); onDelete(); }}
          >
            {t("action.delete", voice)}
          </button>
          <button className="text-muted-foreground rounded-md px-2.5 py-1" onClick={() => setConfirming(false)}>
            {t("action.cancel", voice)}
          </button>
        </>
      ) : (
        <>
          <button className="hover:bg-accent rounded-md border px-2.5 py-1 disabled:opacity-50" disabled={disabled} onClick={onComplete}>
            {t("action.complete", voice)}
          </button>
          <button className="hover:bg-accent rounded-md border px-2.5 py-1 disabled:opacity-50" disabled={disabled} onClick={onSaveForLater}>
            {t("action.saveForLater", voice)}
          </button>
          <button className="text-destructive rounded-md border px-2.5 py-1 disabled:opacity-50" disabled={disabled} onClick={() => setConfirming(true)}>
            {t("action.delete", voice)}
          </button>
        </>
      )}
    </div>
  );
}
```

> `action.saveForLater`, `action.complete`, `action.delete`, `action.cancel` all already exist in `strings.ts`.

- [ ] **Step 3: tsc + commit**

Run: `npx tsc --noEmit` (expect clean)
```bash
git add src/components/library/use-select-mode.ts src/components/library/select-action-bar.tsx
git commit -m "feat(#8): select-mode hook + bulk action bar for the Library

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 8: Multi-step tab — `LibraryMultistep` (expand + meta + select)

**Files:**
- Create: `src/components/library/library-multistep.tsx`
- Create: `src/components/library/library-multistep.test.tsx`

**Interfaces:**
- Consumes: `Item`, `TaskSteps` (`@/components/breakdown/task-steps`), the meta bits (Task 6), `useSelectMode` + `SelectActionBar` (Task 7), `bulkBrainDumpAction` (Task 4), `AgingSettings`, `t`/`Voice`.
- Props: `{ items: Item[]; voice: Voice; now: number; settings: AgingSettings }`

- [ ] **Step 1: Write the failing test**

```tsx
// src/components/library/library-multistep.test.tsx
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, within } from "@testing-library/react";
import { LibraryMultistep } from "./library-multistep";
import type { Item } from "@/components/inbox/bucket";
import type { AgingSettings } from "@/lib/aging";

vi.mock("@/app/actions/braindump", () => ({ bulkBrainDumpAction: vi.fn().mockResolvedValue({ count: 1 }) }));
// TaskSteps is heavy (its own server actions) — stub it; we only assert it mounts for the open row.
vi.mock("@/components/breakdown/task-steps", () => ({
  TaskSteps: ({ taskId }: { taskId: string }) => <div data-testid="task-steps">{taskId}</div>,
}));

const settings: AgingSettings = { agingThresholdMinutes: 60, demoOverrideSeconds: null, agingHours: 24, overdueHours: 48, wayOverdueHours: 72 };
const mk = (id: string, createdAt: Date): Item => ({
  id, text: `task ${id}`, createdAt, status: "triaged", triagedAt: null, remindedAt: null,
  snoozedUntil: null, taskId: `T${id}`, freshenedAt: null, promptDismissedAt: null,
  breakdownRequestedAt: null, stepsTotal: 2, stepsDone: 0, taskStatus: "active",
  completedAt: null, scheduledAt: null, estMinutes: null,
  steps: [
    { id: `${id}a`, order: 1, text: "first", done: false, estMinutes: 10, subtaskEmoji: "🍳", resumable: false },
    { id: `${id}b`, order: 2, text: "second", done: false, estMinutes: 5, subtaskEmoji: null, resumable: false },
  ],
});
const items = [mk("new", new Date("2026-07-18")), mk("old", new Date("2026-07-01"))]; // newest first

beforeEach(() => vi.clearAllMocks());

describe("LibraryMultistep", () => {
  it("opens the latest (first) row by default and shows its steps", () => {
    render(<LibraryMultistep items={items} voice="plain" now={Date.now()} settings={settings} />);
    expect(screen.getByTestId("task-steps")).toHaveTextContent("Tnew");
  });
  it("single-open: opening another row collapses the first", () => {
    render(<LibraryMultistep items={items} voice="plain" now={Date.now()} settings={settings} />);
    fireEvent.click(screen.getByRole("button", { name: /task old/i }));
    expect(screen.getByTestId("task-steps")).toHaveTextContent("Told");
  });
  it("shows next-step + estimate meta on a collapsed row", () => {
    render(<LibraryMultistep items={items} voice="plain" now={Date.now()} settings={settings} />);
    // The collapsed "old" row shows its next step preview.
    expect(screen.getByText("first", { selector: "*" })).toBeTruthy();
  });
  it("select mode: Select → tick a row → Delete calls bulkBrainDumpAction", async () => {
    const { bulkBrainDumpAction } = await import("@/app/actions/braindump");
    render(<LibraryMultistep items={items} voice="plain" now={Date.now()} settings={settings} />);
    fireEvent.click(screen.getByRole("button", { name: /^select$/i }));
    fireEvent.click(screen.getByRole("checkbox", { name: /task new/i }));
    fireEvent.click(screen.getByRole("button", { name: /^delete$/i }));       // bar → confirm
    fireEvent.click(screen.getByRole("button", { name: /^delete$/i }));       // confirm
    expect(bulkBrainDumpAction).toHaveBeenCalledWith(["new"], "delete");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/components/library/library-multistep.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `LibraryMultistep`**

```tsx
// src/components/library/library-multistep.tsx
"use client";
import { useState, useTransition } from "react";
import Link from "next/link";
import { cn } from "@/lib/utils";
import { t, type Voice } from "@/lib/strings";
import { type AgingSettings } from "@/lib/aging";
import type { Item } from "@/components/inbox/bucket";
import { TaskSteps } from "@/components/breakdown/task-steps";
import { bulkBrainDumpAction } from "@/app/actions/braindump";
import { useSelectMode } from "./use-select-mode";
import { SelectActionBar } from "./select-action-bar";
import { RowNumber, NextStepLine, ProgressBar, AgeLabel, EstimatePill, rowEmoji, remainingMinutes } from "./library-row-meta";
import { useRouter } from "next/navigation";

export function LibraryMultistep({
  items, voice, now, settings,
}: { items: Item[]; voice: Voice; now: number; settings: AgingSettings }) {
  const router = useRouter();
  // Default open = latest (bucket is createdAt desc → first row).
  const [expandedId, setExpandedId] = useState<string | null>(items[0]?.id ?? null);
  const sel = useSelectMode();
  const [pending, startTransition] = useTransition();
  const ids = items.map((i) => i.id);

  const runBulk = (action: "complete" | "saveForLater" | "delete") =>
    startTransition(async () => {
      await bulkBrainDumpAction([...sel.selected], action);
      sel.exit();
      router.refresh();
    });

  return (
    <div className="space-y-2">
      <div className="flex justify-end">
        {sel.selecting ? (
          <div className="flex gap-2 text-sm">
            <button className="hover:bg-accent rounded-md border px-2.5 py-1" onClick={() => sel.selectAll(ids)}>
              {t("lib.selectAll", voice)}
            </button>
            <button className="text-muted-foreground rounded-md border px-2.5 py-1" onClick={sel.exit}>
              {t("action.cancel", voice)}
            </button>
          </div>
        ) : (
          <button className="hover:bg-accent rounded-md border px-2.5 py-1 text-sm" onClick={sel.enter}>
            {t("lib.select", voice)}
          </button>
        )}
      </div>

      <ul className={cn("space-y-2", pending && "opacity-70")}>
        {items.map((item, i) => {
          const expanded = expandedId === item.id && !sel.selecting;
          const checked = sel.selected.has(item.id);
          const emoji = voice === "playful" ? rowEmoji(item) : null;
          return (
            <li key={item.id} className={cn("rounded-lg border px-4 py-3 text-sm", checked && "ring-primary ring-2")}>
              <div className="flex items-start gap-3">
                {sel.selecting && (
                  <input
                    type="checkbox"
                    className="mt-1"
                    checked={checked}
                    aria-label={item.text}
                    onChange={() => sel.toggle(item.id)}
                  />
                )}
                <RowNumber n={i + 1} />
                {emoji && <span aria-hidden className="text-base">{emoji}</span>}
                <div className="min-w-0 flex-1">
                  <button
                    type="button"
                    className="block w-full text-left font-medium break-words"
                    aria-expanded={expanded}
                    disabled={sel.selecting}
                    onClick={() => (sel.selecting ? sel.toggle(item.id) : setExpandedId(expanded ? null : item.id))}
                  >
                    {item.text}
                  </button>
                  {!expanded && <NextStepLine item={item} voice={voice} />}
                  {!expanded && <ProgressBar item={item} />}
                  {!expanded && <div className="mt-1"><AgeLabel item={item} now={now} voice={voice} settings={settings} /></div>}
                </div>
                {!expanded && (
                  <span className="text-muted-foreground shrink-0 rounded-full border px-2 py-0.5 text-xs">
                    {item.stepsDone}/{item.stepsTotal} {t("progress.done", voice)}
                  </span>
                )}
                {!expanded && <EstimatePill minutes={remainingMinutes(item)} voice={voice} variant="left" />}
              </div>

              {expanded && item.taskId && (
                <div className="mt-3 space-y-2">
                  <TaskSteps
                    taskId={item.taskId}
                    voice={voice}
                    steps={item.steps.map((s) => ({
                      id: s.id, order: s.order, total: item.stepsTotal, text: s.text,
                      subtaskEmoji: s.subtaskEmoji, estMinutes: s.estMinutes, done: s.done, resumable: s.resumable,
                    }))}
                  />
                  <Link href={`/tasks/${item.taskId}`} className="text-muted-foreground hover:text-foreground inline-block text-xs">
                    {t("lib.openTask", voice)} →
                  </Link>
                </div>
              )}
            </li>
          );
        })}
      </ul>

      {sel.selecting && (
        <SelectActionBar
          count={sel.selected.size}
          voice={voice}
          pending={pending}
          onComplete={() => runBulk("complete")}
          onSaveForLater={() => runBulk("saveForLater")}
          onDelete={() => runBulk("delete")}
        />
      )}
    </div>
  );
}
```

> Confirm `progress.done` exists in `strings.ts` (the current `page.tsx` `ProgressPill` uses `t("progress.done", voice)` — it does). Verify `TaskSteps`' `total` prop matches its `TaskStepRow` type (it does: `total: number`).

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/components/library/library-multistep.test.tsx`
Expected: PASS. If the "next-step on collapsed row" query is ambiguous, tighten the selector to the collapsed `old` row via `within(...)`.

- [ ] **Step 5: tsc + lint + commit**

Run: `npx tsc --noEmit && npm run lint`
```bash
git add src/components/library/library-multistep.tsx src/components/library/library-multistep.test.tsx
git commit -m "feat(#8): Library Multi-step tab — inline expansion, meta, select mode

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 9: Single-task rows — meta, inline estimate editor, select mode

**Files:**
- Modify: `src/components/library/library-rows.tsx`
- Create: `src/components/library/library-rows.test.tsx`

**Scope:** the Single-task ("plated") tab gets: collapsed meta (number, age, editable estimate rightmost), and select mode. **Saved-for-later ("pantry") keeps its current behavior** — no meta/select there (it already shows wake times). Gate the new behavior on `tab === "plated"`.

**Interfaces:**
- Consumes: meta bits (Task 6), `useSelectMode`/`SelectActionBar` (Task 7), `bulkBrainDumpAction` (Task 4), `setItemEstimate` (Task 3), `AgingSettings`.
- Props change: add `settings: AgingSettings` to `LibraryRows`.

- [ ] **Step 1: Write the failing test**

```tsx
// src/components/library/library-rows.test.tsx
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { LibraryRows } from "./library-rows";
import type { Item } from "@/components/inbox/bucket";
import type { AgingSettings } from "@/lib/aging";

vi.mock("@/app/actions/braindump", () => ({
  bulkBrainDumpAction: vi.fn().mockResolvedValue({ count: 1 }),
  setItemEstimate: vi.fn().mockResolvedValue(undefined),
  completeItem: vi.fn(), deleteBrainDumpItem: vi.fn(), ensureFocusStep: vi.fn(),
}));

const settings: AgingSettings = { agingThresholdMinutes: 60, demoOverrideSeconds: null, agingHours: 24, overdueHours: 48, wayOverdueHours: 72 };
const item = (id: string, estMinutes: number | null): Item => ({
  id, text: `todo ${id}`, createdAt: new Date(), status: "triaged", triagedAt: null,
  remindedAt: null, snoozedUntil: null, taskId: null, freshenedAt: null, promptDismissedAt: null,
  breakdownRequestedAt: null, stepsTotal: 0, stepsDone: 0, taskStatus: null, completedAt: null,
  scheduledAt: null, estMinutes, steps: [],
});

beforeEach(() => vi.clearAllMocks());

describe("LibraryRows (plated)", () => {
  it("shows a 5-min default estimate that persists on edit", async () => {
    const { setItemEstimate } = await import("@/app/actions/braindump");
    render(<LibraryRows items={[item("a", null)]} tab="plated" voice="plain" now={Date.now()} settings={settings} />);
    expect(screen.getByText(/≈5 min/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /edit estimate/i }));
    const input = screen.getByRole("spinbutton", { name: /edit estimate/i });
    fireEvent.change(input, { target: { value: "20" } });
    fireEvent.blur(input);
    expect(setItemEstimate).toHaveBeenCalledWith("a", 20);
  });
  it("select mode → complete calls bulkBrainDumpAction with the ticked ids", async () => {
    const { bulkBrainDumpAction } = await import("@/app/actions/braindump");
    render(<LibraryRows items={[item("a", null), item("b", 10)]} tab="plated" voice="plain" now={Date.now()} settings={settings} />);
    fireEvent.click(screen.getByRole("button", { name: /^select$/i }));
    fireEvent.click(screen.getByRole("checkbox", { name: /todo a/i }));
    fireEvent.click(screen.getByRole("button", { name: /^complete$/i }));
    expect(bulkBrainDumpAction).toHaveBeenCalledWith(["a"], "complete");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/components/library/library-rows.test.tsx`
Expected: FAIL — `settings` prop / estimate editor / select mode don't exist yet.

- [ ] **Step 3: Extend `library-rows.tsx`**

Add imports:
```ts
import { useSelectMode } from "./use-select-mode";
import { SelectActionBar } from "./select-action-bar";
import { RowNumber, AgeLabel, singleTaskEstimate } from "./library-row-meta";
import { bulkBrainDumpAction, setItemEstimate } from "@/app/actions/braindump";
import { type AgingSettings } from "@/lib/aging";
```
Add `settings: AgingSettings` to the props type + destructure. Add select-mode + bulk runner (mirror Task 8's `runBulk`) and, for `tab === "plated"`, render: a **Select** button header, a leading checkbox per row when selecting (label = `item.text`), the `RowNumber` + `AgeLabel` meta, an **editable estimate** on the right, and the `SelectActionBar` when selecting. Suppress the existing `RowActions` cluster while selecting. Keep `tab === "pantry"` exactly as it is today.

Estimate editor (inline, mirrors the breakdown step input; default via `singleTaskEstimate`):
```tsx
function EstimateEditor({ id, minutes, voice, onSaved }: { id: string; minutes: number; voice: Voice; onSaved: () => void }) {
  const [editing, setEditing] = useState(false);
  const [val, setVal] = useState(minutes);
  if (!editing) {
    return (
      <button
        type="button"
        aria-label={t("lib.editEstimate", voice)}
        className="text-muted-foreground hover:text-foreground shrink-0 rounded-full border px-2 py-0.5 text-xs"
        onClick={() => setEditing(true)}
      >
        ≈{minutes} {t("lib.min", voice)}
      </button>
    );
  }
  const commit = () => {
    setEditing(false);
    if (val !== minutes) { void setItemEstimate(id, val); onSaved(); }
  };
  return (
    <input
      type="number" min={1} autoFocus
      aria-label={t("lib.editEstimate", voice)}
      value={val}
      onChange={(e) => setVal(Number(e.target.value))}
      onBlur={commit}
      onKeyDown={(e) => { if (e.key === "Enter") commit(); }}
      className="border-input w-16 rounded-md border px-1 py-0.5 text-right text-xs"
    />
  );
}
```
Wire `onSaved={() => router.refresh()}` and feed `minutes={singleTaskEstimate(item)}`.

> The plated meta shows only number + age + editable estimate per the spec (single-tasks have no steps → no next-step/bar/emoji). Keep the row's title text as-is.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/components/library/library-rows.test.tsx`
Expected: PASS.

- [ ] **Step 5: tsc + lint + commit**

Run: `npx tsc --noEmit && npm run lint`
```bash
git add src/components/library/library-rows.tsx src/components/library/library-rows.test.tsx
git commit -m "feat(#8): Library single-task rows — meta, editable estimate, select mode

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 10: Wire the page (Multi-step tab + settings + rename verified)

**Files:**
- Modify: `src/app/(app)/library/page.tsx`

**Interfaces:**
- Consumes: `LibraryMultistep` (Task 8), extended `LibraryRows` (Task 9), the `AgingSettings` fields on `settings`.

- [ ] **Step 1: Build the `AgingSettings` object + pass to rows**

In `page.tsx`, after `getSettings`, build (mirroring `inbox/page.tsx:97-103`):
```ts
  const agingSettings = {
    agingThresholdMinutes: settings.agingThresholdMinutes,
    demoOverrideSeconds: settings.demoOverrideSeconds,
    agingHours: settings.agingHours,
    overdueHours: settings.overdueHours,
    wayOverdueHours: settings.wayOverdueHours,
  };
```

- [ ] **Step 2: Wire the tabs**

Import `LibraryMultistep`. Replace the render branch so:
- `plated` / `pantry` → `<LibraryRows items={rows} tab={active} voice={voice} now={now} settings={agingSettings} />` (added `settings`).
- `sorted` → `<LibraryMultistep items={rows} voice={voice} now={now} settings={agingSettings} />`.
- `done` → keep the existing static `LibraryRow` list.

Concretely, change the conditional:
```tsx
        ) : active === "plated" || active === "pantry" ? (
          <LibraryRows items={rows} tab={active} voice={voice} now={now} settings={agingSettings} />
        ) : active === "sorted" ? (
          <LibraryMultistep items={rows} voice={voice} now={now} settings={agingSettings} />
        ) : (
          <ul className="space-y-2">
            {rows.map((item) => (
              <LibraryRow key={item.id} item={item} tab={active} voice={voice} />
            ))}
          </ul>
        )}
```
Note: `LibraryRow`'s `tab` type is `Extract<TabParam, "sorted" | "done">`; now only `done` reaches it, so narrow that type to `"done"` (and the `ProgressPill`/`title` branches for `"sorted"` become dead — remove the `sorted` arms or keep the type as `"done"` only). Keep changes minimal and let `tsc` guide you.

- [ ] **Step 3: Verify heading + nav read "Library"**

The `<h1>` already renders `t("nav.everything", voice)` → now "Library" (plain). Confirm the nav item (search `nav.everything` across `src/components` / `src/app` layout) also picks up the rename automatically.

- [ ] **Step 4: Run the full suite + gates**

Run: `npx tsc --noEmit && npm run lint && npx vitest run --exclude '**/*.integration.test.ts'`
Expected: clean · 0 errors · all green.

- [ ] **Step 5: Commit**

```bash
git add "src/app/(app)/library/page.tsx"
git commit -m "feat(#8): wire Library page — Multi-step expansion, meta settings, Library rename

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 11: Manual verification + push

- [ ] **Step 1: Drive the app** (use the `run` / `verify` project skill)

Start the app; on `/library`:
- Heading + nav read **Library** (plain) / **🍱 Larder** (playful).
- **Multi-step** tab: newest task open by default; clicking another collapses it and opens the clicked one; steps are interactive; **Open task** navigates; collapsed rows show number, Next-step, progress bar, amber-when-aging age, done pill, `≈N min left` rightmost.
- **Single-task** tab: rows show number, age, `≈5 min` default; editing persists; **Select** → tick → Complete/Save-for-later/Delete (with confirm) works and the list updates.
- Toggle voice → emoji anchor appears only in playful; Plain stays emoji-free.

- [ ] **Step 2: Final gates**

Run: `npx tsc --noEmit && npm run lint && npx vitest run --exclude '**/*.integration.test.ts'`
Expected: all green. Record the vitest passed count.

- [ ] **Step 3: Push to !83 (do NOT merge)**

```bash
git push origin feat/library-hub
```
Then: reply to GitLabDuo's !83 formatter thread noting the shared-`format.ts` extraction; request GitLabDuo re-review; hand to the owner for merge sign-off.

---

## Self-Review (author checklist — completed)

- **Spec coverage:** Rename → T5/T10. Multi-step expand (latest-open, single-open, TaskSteps parity, Open task) → T8. Bulk edit (Select mode, 3 actions, Select all, delete confirm, `bulkBrainDumpAction`) → T4/T7/T8/T9. Row meta A–F → T6 (helpers) + T8/T9 (render); emoji playful-only enforced in shells. Single-task editable estimate (default 5, migration, `setItemEstimate`) → T2/T3/T9. Duo formatter nit → T1. Strings/no-interpolation → T5 + composition in shells. Gates/branch/no-merge → Global Constraints + T11.
- **Placeholders:** none — every code step carries real code; test steps carry real assertions.
- **Type consistency:** `Item.estMinutes: number | null` (T2) used by helpers (T6) + rows (T9) + page (T2). `AgingSettings` object shape (T10) matches `@/lib/aging` (T6/T8/T9). `bulkBrainDumpAction(ids, "complete"|"saveForLater"|"delete")` signature identical across T4/T7/T8/T9. `TaskSteps` props (`taskId`, `steps: TaskStepRow[]`, `voice?`) match T8's usage.
- **Known deviation from spec:** `bulkBrainDumpAction` reuses per-item actions instead of one `$transaction`/single revalidate — safer + DRY (preserves reward/badge/streak/graduation logic); documented in T4.
