# Phase 2 — Inbox IA + Freshness + ☰ Nav Menu Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restructure the Inbox into wireframe IA (Needs review / To do → Single-task + Multi-step / Saved for later, with see-all deep-links), add a non-destructive 4-tier freshness system + 24h "still needed?" prompt, add capture-confirm and inline delete-confirm UX, and add the ☰ hamburger nav menu.

**Architecture:** Freshness is pure logic in `src/lib/aging.ts` (`freshnessTier()` over `age = now − max(createdAt, freshenedAt)`), driven by per-tier thresholds on the per-workspace `Settings` singleton. `freshenedAt`/`promptDismissedAt` are new non-destructive `BrainDumpItem` columns. The Inbox page loads Task+Step data so To-do sub-buckets can compute step progress; `InboxView` (client) re-buckets and re-sorts live. All reads/writes stay workspace-scoped. Voice strings come from Phase 1's `t()` layer.

**Tech Stack:** Next.js 16 (modified — read `node_modules/next/dist/docs/` before any App Router API), React server + client components, Prisma (Postgres prod / SQLite dev; statuses are plain strings, not enums), Vitest, Tailwind/shadcn.

## Global Constraints

- **AGENTS.md:** This is a modified Next.js. Read the relevant guide in `node_modules/next/dist/docs/` before writing any App Router code. `params`/`searchParams` are Promises — `await` them.
- **Plain voice is 100% emoji-free** (functional glyphs only: 🟢🟡🟠🔴 ✅ ▶ ⏸ ➕ ➖ 🗑️ 🔒 ⚠️). Every new user-facing string goes through `t(key, voice)` with a `{plain, playful}` entry in `src/lib/strings.ts`. Playful adds flavour emoji.
- **Workspace scoping is mandatory** on every DB read/write: page queries filter `where: { workspaceId }`; every action resolves `currentWorkspaceId()` and gates mutations with `findFirst({ where: { id, workspaceId } })` before writing.
- **Migrations must work on Postgres and SQLite**; follow the existing raw-SQL style in `prisma/migrations/`. Additive only. Run `npx prisma generate` after schema edits.
- **Freshness is non-destructive:** `age = now − max(createdAt, freshenedAt)`. Never overwrite `createdAt`.
- **TDD:** failing test → run (see it fail) → minimal impl → run (pass) → commit. `npx vitest run`, `npx tsc --noEmit`, `npm run build` must be green before an MR.
- **Freshness tier thresholds (verbatim from wireframe):** Recent/Fresh 🟢 (0, default) · Aging/Softening 🟡 (after **4h**) · Overdue/Soggy 🟠 (after **8h**) · Way overdue/Stale 🔴 (after **12h**). 24h → "still needed?" prompt.
- **Demo override:** `Settings.demoOverrideSeconds`, when set, wins and maps to tier boundaries at ×1/×2/×3 seconds (aging=override, overdue=2×, wayOverdue=3×) so all four tiers are demoable in seconds. Precedence "demo override wins" is preserved.

---

## Design decisions (resolved for this plan)

1. **Demo override scaling:** `demoOverrideSeconds` → aging boundary; overdue = 2×; wayOverdue = 3× (all in seconds). 24h prompt boundary in demo mode = 4× the override.
2. **24h prompt storage:** new `BrainDumpItem.promptDismissedAt DateTime?`, distinct from the notification `remindedAt`. Dismiss sets it; a dismissed item never re-shows the prompt. Non-destructive, no status change.
3. **Done graduation:** a broken-down Task with all steps `done` (or `Task.status==="done"`) is filtered OUT of the Multi-step To-do bucket in Phase 2. Phase 3's Library/Done tab surfaces it. Phase 2 does not build a Done section.
4. **Freshness applies only to Needs review** (unsorted `inbox`, not saved-for-later) items. Saved-for-later pauses freshness (excluded from tier computation).
5. **Tier thresholds stored as hours** on `Settings`: `agingHours`(4) `overdueHours`(8) `wayOverdueHours`(12). Legacy `agingThresholdMinutes`/`demoOverrideSeconds` stay for the existing notification path — untouched by this phase except that the freshness pill reads the new fields.

---

## File Structure

| File | Responsibility | Action |
|---|---|---|
| `prisma/schema.prisma` | `BrainDumpItem.freshenedAt`, `.promptDismissedAt`; `Settings.agingHours/overdueHours/wayOverdueHours` | Modify |
| `prisma/migrations/<ts>_phase2_freshness/migration.sql` | Additive columns w/ defaults | Create |
| `src/lib/aging.ts` | 4-tier `freshnessTier()`, `freshnessAgeMs()`, `shouldPrompt24h()`, extended `AgingSettings` | Modify |
| `src/lib/aging.test.ts` | Unit tests for tier logic + demo scaling + 24h | Create |
| `src/lib/strings.ts` | New keys: `nav.focusTimer`, `nav.settings`, `capture.confirm`, `prompt.stillNeeded`, `action.dismiss`, `action.delete`, `action.cancel`, `link.seeAll`, `pill.toDo`, `progress.done`, `progress.notScheduled` | Modify |
| `src/lib/strings.test.ts` | Assert new keys render + Plain emoji-free | Modify |
| `src/app/actions/braindump.ts` | `freshenItem`, `dismissPrompt` actions | Modify |
| `src/app/actions/braindump.test.ts` (or existing test file) | Action scoping tests | Create/Modify |
| `src/app/actions/settings.ts` | Extend `updateAgingSettings` to write 3 tier hours | Modify |
| `src/app/(app)/inbox/page.tsx` | Load Task+Step; pass tier thresholds + `freshenedAt`/`promptDismissedAt` | Modify |
| `src/components/inbox/inbox-view.tsx` | IA rewrite: Needs review / To do (single+multi) / Saved for later; capture ✓; delete confirm; 24h prompt; deep-links | Modify |
| `src/components/inbox/status-pill.tsx` (extract from inbox-view) | 4-tier freshness pill (dot + word) | Create |
| `src/components/inbox/status-pill.test.tsx` | Tier → dot+label mapping | Create |
| `src/components/inbox/settings-panel.tsx` | 3 tier-hour inputs | Modify |
| `src/components/nav/app-menu.tsx` | ☰ hamburger menu (client) | Create |
| `src/components/nav/app-menu.test.tsx` | Menu items + Task Breakdown absent | Create |
| `src/app/(app)/layout.tsx` | Mount ☰ menu | Modify |
| `src/app/(app)/library/page.tsx` | Route stub (Phase 3 target for see-all deep-links) | Create |
| `src/app/(app)/settings/page.tsx` | Route stub | Create |

---

### Task 1: Schema — freshness + prompt columns + tier thresholds

**Files:**
- Modify: `prisma/schema.prisma` (`BrainDumpItem`, `Settings`)
- Create: `prisma/migrations/<timestamp>_phase2_freshness/migration.sql`

**Interfaces:**
- Produces: `BrainDumpItem.freshenedAt: DateTime?`, `BrainDumpItem.promptDismissedAt: DateTime?`; `Settings.agingHours: Int @default(4)`, `Settings.overdueHours: Int @default(8)`, `Settings.wayOverdueHours: Int @default(12)`.

- [ ] **Step 1: Add columns to `schema.prisma`.** In `model BrainDumpItem` add `freshenedAt DateTime?` and `promptDismissedAt DateTime?`. In `model Settings` add `agingHours Int @default(4)`, `overdueHours Int @default(8)`, `wayOverdueHours Int @default(12)`.

- [ ] **Step 2: Create the migration SQL** (match existing raw-SQL migration style; safe on Postgres + SQLite):

```sql
-- BrainDumpItem: non-destructive freshness + 24h prompt dismissal
ALTER TABLE "BrainDumpItem" ADD COLUMN "freshenedAt" TIMESTAMP;
ALTER TABLE "BrainDumpItem" ADD COLUMN "promptDismissedAt" TIMESTAMP;
-- Settings: per-tier freshness thresholds (hours)
ALTER TABLE "Settings" ADD COLUMN "agingHours" INTEGER NOT NULL DEFAULT 4;
ALTER TABLE "Settings" ADD COLUMN "overdueHours" INTEGER NOT NULL DEFAULT 8;
ALTER TABLE "Settings" ADD COLUMN "wayOverdueHours" INTEGER NOT NULL DEFAULT 12;
```

(If the repo uses `DATETIME` for SQLite compatibility elsewhere, match that token; check a prior migration first.)

- [ ] **Step 3: Regenerate the client.** Run: `npx prisma generate` — Expected: succeeds, `PrismaClient` types now include the new fields.

- [ ] **Step 4: Apply migration locally.** Run: `export PATH="$HOME/.rd/bin:$PATH"; export DOCKER_HOST="unix://$HOME/.rd/docker.sock"; docker compose up -d db && npx prisma migrate deploy` — Expected: migration applies cleanly.

- [ ] **Step 5: Commit.**
```bash
git add prisma/schema.prisma prisma/migrations
git commit -m "feat(schema): add freshenedAt/promptDismissedAt + per-tier freshness thresholds"
```

---

### Task 2: Freshness model in `aging.ts`

**Files:**
- Modify: `src/lib/aging.ts`
- Create: `src/lib/aging.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces:
  - `type FreshnessTier = "recent" | "aging" | "overdue" | "wayOverdue"`
  - `type AgingSettings = { agingThresholdMinutes: number; demoOverrideSeconds: number | null; agingHours: number; overdueHours: number; wayOverdueHours: number }`
  - `freshnessAgeMs(createdAt: Date|string, freshenedAt: Date|string|null, now?: number): number` → `now − max(createdAt, freshenedAt)`
  - `freshnessTier(createdAt, freshenedAt, s: AgingSettings, now?: number): FreshnessTier`
  - `shouldPrompt24h(createdAt, freshenedAt, promptDismissedAt: Date|string|null, s: AgingSettings, now?: number): boolean`
  - Keep existing `effectiveAgingMs`/`isAging` unchanged (notification path).

- [ ] **Step 1: Write failing tests** in `src/lib/aging.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { freshnessTier, freshnessAgeMs, shouldPrompt24h, type AgingSettings } from "./aging";

const S: AgingSettings = {
  agingThresholdMinutes: 60, demoOverrideSeconds: null,
  agingHours: 4, overdueHours: 8, wayOverdueHours: 12,
};
const H = 3600_000;
const now = 1_000_000_000_000;

describe("freshnessAgeMs", () => {
  it("uses createdAt when no freshenedAt", () => {
    expect(freshnessAgeMs(new Date(now - 3 * H), null, now)).toBe(3 * H);
  });
  it("uses max(createdAt, freshenedAt) — freshenedAt resets age", () => {
    expect(freshnessAgeMs(new Date(now - 10 * H), new Date(now - 1 * H), now)).toBe(1 * H);
  });
});

describe("freshnessTier", () => {
  it("recent under 4h", () => { expect(freshnessTier(new Date(now - 2 * H), null, S, now)).toBe("recent"); });
  it("aging at 4h", () => { expect(freshnessTier(new Date(now - 4 * H), null, S, now)).toBe("aging"); });
  it("overdue at 8h", () => { expect(freshnessTier(new Date(now - 8 * H), null, S, now)).toBe("overdue"); });
  it("wayOverdue at 12h", () => { expect(freshnessTier(new Date(now - 13 * H), null, S, now)).toBe("wayOverdue"); });
  it("demo override scales tiers to seconds ×1/×2/×3", () => {
    const demo = { ...S, demoOverrideSeconds: 10 };
    expect(freshnessTier(new Date(now - 5_000), null, demo, now)).toBe("recent");   // <10s
    expect(freshnessTier(new Date(now - 12_000), null, demo, now)).toBe("aging");   // ≥10s
    expect(freshnessTier(new Date(now - 22_000), null, demo, now)).toBe("overdue"); // ≥20s
    expect(freshnessTier(new Date(now - 32_000), null, demo, now)).toBe("wayOverdue"); // ≥30s
  });
});

describe("shouldPrompt24h", () => {
  it("true after 24h untouched, not dismissed", () => {
    expect(shouldPrompt24h(new Date(now - 25 * H), null, null, S, now)).toBe(true);
  });
  it("false when dismissed", () => {
    expect(shouldPrompt24h(new Date(now - 25 * H), null, new Date(now - 1 * H), S, now)).toBe(false);
  });
  it("false when freshenedAt within 24h", () => {
    expect(shouldPrompt24h(new Date(now - 25 * H), new Date(now - 2 * H), null, S, now)).toBe(false);
  });
  it("demo override: prompts at 4× override seconds", () => {
    const demo = { ...S, demoOverrideSeconds: 10 };
    expect(shouldPrompt24h(new Date(now - 45_000), null, null, demo, now)).toBe(true);  // ≥40s
    expect(shouldPrompt24h(new Date(now - 35_000), null, null, demo, now)).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify fail.** Run: `npx vitest run src/lib/aging.test.ts` — Expected: FAIL (functions not exported).

- [ ] **Step 3: Implement** in `src/lib/aging.ts` (append; keep existing exports):

```ts
export type FreshnessTier = "recent" | "aging" | "overdue" | "wayOverdue";

const toMs = (d: Date | string): number => (typeof d === "string" ? new Date(d) : d).getTime();

/** age = now − max(createdAt, freshenedAt). freshenedAt resets the clock non-destructively. */
export function freshnessAgeMs(
  createdAt: Date | string,
  freshenedAt: Date | string | null,
  now: number = Date.now(),
): number {
  const base = freshenedAt ? Math.max(toMs(createdAt), toMs(freshenedAt)) : toMs(createdAt);
  return now - base;
}

/** Tier boundaries in ms. Demo override (seconds) wins and scales ×1/×2/×3. */
function tierBoundsMs(s: AgingSettings): { aging: number; overdue: number; wayOverdue: number } {
  if (s.demoOverrideSeconds != null && s.demoOverrideSeconds > 0) {
    const o = s.demoOverrideSeconds * 1000;
    return { aging: o, overdue: 2 * o, wayOverdue: 3 * o };
  }
  return {
    aging: s.agingHours * 3600_000,
    overdue: s.overdueHours * 3600_000,
    wayOverdue: s.wayOverdueHours * 3600_000,
  };
}

export function freshnessTier(
  createdAt: Date | string,
  freshenedAt: Date | string | null,
  s: AgingSettings,
  now: number = Date.now(),
): FreshnessTier {
  const age = freshnessAgeMs(createdAt, freshenedAt, now);
  const b = tierBoundsMs(s);
  if (age >= b.wayOverdue) return "wayOverdue";
  if (age >= b.overdue) return "overdue";
  if (age >= b.aging) return "aging";
  return "recent";
}

/** 24h "still needed?" boundary: 24h normally, 4× override seconds in demo mode. */
function promptBoundaryMs(s: AgingSettings): number {
  if (s.demoOverrideSeconds != null && s.demoOverrideSeconds > 0) return 4 * s.demoOverrideSeconds * 1000;
  return 24 * 3600_000;
}

export function shouldPrompt24h(
  createdAt: Date | string,
  freshenedAt: Date | string | null,
  promptDismissedAt: Date | string | null,
  s: AgingSettings,
  now: number = Date.now(),
): boolean {
  if (promptDismissedAt) return false;
  return freshnessAgeMs(createdAt, freshenedAt, now) >= promptBoundaryMs(s);
}
```

Also extend the `AgingSettings` type (add `agingHours`, `overdueHours`, `wayOverdueHours`).

- [ ] **Step 4: Run to verify pass.** Run: `npx vitest run src/lib/aging.test.ts` — Expected: PASS.

- [ ] **Step 5: Commit.**
```bash
git add src/lib/aging.ts src/lib/aging.test.ts
git commit -m "feat(aging): 4-tier freshness + 24h prompt logic with demo scaling"
```

---

### Task 3: Server actions — `freshenItem`, `dismissPrompt`, extended settings

**Files:**
- Modify: `src/app/actions/braindump.ts`
- Modify: `src/app/actions/settings.ts` (`updateAgingSettings`)
- Create/Modify: action test file (e.g. `src/app/actions/braindump.test.ts`) — follow existing action-test patterns if present; otherwise assert workspace-scoping via a mocked `prisma`.

**Interfaces:**
- Produces:
  - `freshenItem(id: string): Promise<void>` — sets `freshenedAt = now` on the caller's item; workspace-scoped.
  - `dismissPrompt(id: string): Promise<void>` — sets `promptDismissedAt = now`; workspace-scoped.
  - `updateAgingSettings` extended input `{ agingThresholdMinutes; demoOverrideSeconds; agingHours; overdueHours; wayOverdueHours }`.

- [ ] **Step 1: Write failing test** — assert `freshenItem` only updates a row matching `{ id, workspaceId }` and sets `freshenedAt`; `dismissPrompt` sets `promptDismissedAt`; both call `revalidatePath("/inbox")`. Mirror the mock style used by existing `braindump`/`settings` tests (check `guest-quota.test.ts` / existing action tests for the mock shape). Example shape:

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";
// mock next/cache revalidatePath, @/lib/workspace currentWorkspaceId → "owner", @/lib/db prisma
// then:
it("freshenItem updates only the scoped row", async () => {
  const { freshenItem } = await import("./braindump");
  await freshenItem("item-1");
  expect(prisma.brainDumpItem.updateMany).toHaveBeenCalledWith(
    expect.objectContaining({ where: { id: "item-1", workspaceId: "owner" } }),
  );
});
```

- [ ] **Step 2: Run to verify fail.** Run: `npx vitest run src/app/actions` — Expected: FAIL (functions not exported).

- [ ] **Step 3: Implement** in `braindump.ts` (follow the file's existing `"use server"` + `currentWorkspaceId()` + scoped-write pattern):

```ts
export async function freshenItem(id: string) {
  const workspaceId = await currentWorkspaceId();
  await prisma.brainDumpItem.updateMany({
    where: { id, workspaceId },
    data: { freshenedAt: new Date() },
  });
  revalidatePath("/inbox");
}

export async function dismissPrompt(id: string) {
  const workspaceId = await currentWorkspaceId();
  await prisma.brainDumpItem.updateMany({
    where: { id, workspaceId },
    data: { promptDismissedAt: new Date() },
  });
  revalidatePath("/inbox");
}
```

And in `settings.ts`, extend `updateAgingSettings` to validate + persist `agingHours`/`overdueHours`/`wayOverdueHours` (clamp each to `>= 1`, integers) alongside the existing fields, keeping the upsert workspace-scoped.

- [ ] **Step 4: Run to verify pass.** Run: `npx vitest run src/app/actions` — Expected: PASS.

- [ ] **Step 5: Commit.**
```bash
git add src/app/actions
git commit -m "feat(actions): freshenItem/dismissPrompt + per-tier aging settings"
```

---

### Task 4: Strings — nav/menu/prompt/confirm keys

**Files:**
- Modify: `src/lib/strings.ts`
- Modify: `src/lib/strings.test.ts`

**Interfaces:**
- Produces new `StringKey`s (all with `{plain, playful}`; Plain emoji-free):

| key | plain | playful |
|---|---|---|
| `nav.focusTimer` | Focus Timer | ⏱️ Focus Timer |
| `nav.settings` | Settings | ⚙️ Settings |
| `capture.confirm` | captured ✓ | captured ✓ |
| `prompt.stillNeeded` | This has been sitting a while — still needed? | 🕐 This snack's been sitting a while — still want it? |
| `action.dismiss` | Dismiss | Not now |
| `action.delete` | Delete | Delete |
| `action.cancel` | Cancel | Cancel |
| `link.seeAll` | see all → | see all → |
| `pill.toDo` | ▶ to-do | ▶ to-do |
| `progress.done` | done | done |
| `progress.notScheduled` | not scheduled | not scheduled |

(`✓`, `▶`, `→` are functional glyphs — allowed in Plain. Confirm the emoji-free guard's `FUNCTIONAL_GLYPHS` regex covers `✓`/`→`; if not, add them or omit from the plain-only assertion list. The guard currently allows `✅▶⏸️➕➖🗑🔒⚠🟢🟡🟠🔴`.)

- [ ] **Step 1: Write failing tests** — add render cases + include the new plain keys (except `capture.confirm`/`pill.toDo`/`link.seeAll` if their glyphs aren't in the functional-glyph allowlist) to the emoji-free `plainOnlyKeys` list in `strings.test.ts`. Example:
```ts
["nav.focusTimer", "plain", "Focus Timer"],
["nav.settings", "plain", "Settings"],
["action.dismiss", "plain", "Dismiss"],
["action.dismiss", "playful", "Not now"],
["prompt.stillNeeded", "plain", "This has been sitting a while — still needed?"],
```

- [ ] **Step 2: Run to verify fail.** Run: `npx vitest run src/lib/strings.test.ts` — Expected: FAIL (keys missing).

- [ ] **Step 3: Add the entries** to `STRINGS` in `src/lib/strings.ts` (grouped logically; keep alignment style of the file).

- [ ] **Step 4: Run to verify pass.** Run: `npx vitest run src/lib/strings.test.ts` — Expected: PASS.

- [ ] **Step 5: Commit.**
```bash
git add src/lib/strings.ts src/lib/strings.test.ts
git commit -m "feat(strings): nav/menu/prompt/confirm keys for Inbox IA"
```

---

### Task 5: Inbox page query — load tasks/steps + pass thresholds

**Files:**
- Modify: `src/app/(app)/inbox/page.tsx`

**Interfaces:**
- Consumes: `Settings.agingHours/overdueHours/wayOverdueHours`, `BrainDumpItem.freshenedAt/promptDismissedAt`.
- Produces: `InboxView` props gain — each item includes `freshenedAt`, `promptDismissedAt`, and (when `taskId` set) `task: { id, status, steps: { done }[] }` (or a derived `{ taskId, stepsTotal, stepsDone }`); `settings` gains `agingHours/overdueHours/wayOverdueHours`.

- [ ] **Step 1: Read the Next 16 data-fetch guide.** Confirm server-component async + Promise `searchParams` conventions in `node_modules/next/dist/docs/`.

- [ ] **Step 2: Extend the item query** to `include` (or secondary-query) the linked Task with its steps' `done` flags, scoped to `workspaceId`. Keep `orderBy: { createdAt: "desc" }` and `dynamic = "force-dynamic"`.

- [ ] **Step 3: Map to `InboxView` props** — add `freshenedAt`, `promptDismissedAt`, and per-item `stepsTotal`/`stepsDone` (0/0 when no task or single-task). Pass the three tier-hour settings.

- [ ] **Step 4: Verify build/types.** Run: `npx tsc --noEmit` — Expected: PASS (will fail until Task 7 consumes the new props; if so, land Task 5+7 together or stub the `Item` type first). Prefer to do Steps here that only widen the query, and let Task 7's type changes make it compile — sequence 5→7 without an intermediate commit if needed, or add the fields to the `Item` type in this task.

- [ ] **Step 5: Commit.**
```bash
git add "src/app/(app)/inbox/page.tsx"
git commit -m "feat(inbox): load task/step progress + freshness fields into InboxView"
```

---

### Task 6: 4-tier `StatusPill` component

**Files:**
- Create: `src/components/inbox/status-pill.tsx` (extract + extend the inline pill from `inbox-view.tsx:353-365`)
- Create: `src/components/inbox/status-pill.test.tsx`

**Interfaces:**
- Consumes: `freshnessTier` (Task 2), `t` + `Voice`.
- Produces: `<StatusPill tier={FreshnessTier} voice={Voice} />` rendering **dot + word** (never colour alone — a11y): 🟢 `t("freshness.recent")` / 🟡 `t("freshness.aging")` / 🟠 `t("freshness.overdue")` / 🔴 `t("freshness.wayOverdue")`, with tier colours `#2f7d32 / #b8860b / #d35400 / #c0392b`.

- [ ] **Step 1: Write failing test** (`status-pill.test.tsx`, React Testing Library — match existing component-test setup):
```ts
it("renders dot + word per tier", () => {
  render(<StatusPill tier="overdue" voice="plain" />);
  expect(screen.getByText(/Overdue/)).toBeInTheDocument();
  expect(screen.getByText("🟠")).toBeInTheDocument();
});
it("playful uses Soggy", () => {
  render(<StatusPill tier="overdue" voice="playful" />);
  expect(screen.getByText(/Soggy/)).toBeInTheDocument();
});
```

- [ ] **Step 2: Run to verify fail.** Run: `npx vitest run src/components/inbox/status-pill.test.tsx` — Expected: FAIL.

- [ ] **Step 3: Implement** the component (dot+word, tier→colour map, label via `t`).

- [ ] **Step 4: Run to verify pass.** Run: `npx vitest run src/components/inbox/status-pill.test.tsx` — Expected: PASS.

- [ ] **Step 5: Commit.**
```bash
git add src/components/inbox/status-pill.tsx src/components/inbox/status-pill.test.tsx
git commit -m "feat(inbox): 4-tier freshness StatusPill (dot + word, a11y)"
```

---

### Task 7: InboxView IA rewrite — sections + sub-buckets + deep-links

**Files:**
- Modify: `src/components/inbox/inbox-view.tsx`

**Interfaces:**
- Consumes: new item props (Task 5), `StatusPill` (Task 6), `freshnessTier`/`shouldPrompt24h` (Task 2), strings (Task 4).
- Produces: rendered sections in order — **Needs review** (freshest/newest first, freshness pills) → **To do** with **Single-task** + **Multi-step** sub-buckets (each header shows count + `see all →` to `/library?tab=plated|sorted`) → **Saved for later** (`/library?tab=pantry` see-all).

- [ ] **Step 1: Write/extend a failing test** for bucket derivation — given items with mixed states, assert Needs-review contains only unsorted `inbox` (not saved-for-later), Single-task = triaged + 0 steps, Multi-step = triaged + steps & not all done, fully-done excluded. Prefer a pure `bucketItems(items, now)` helper so it's unit-testable without rendering; test that helper.

- [ ] **Step 2: Run to verify fail.** Run: `npx vitest run src/components/inbox` — Expected: FAIL.

- [ ] **Step 3: Implement** — extract a pure `bucketItems()` (Needs review / single / multi / savedLater, applying Design decision 3 & 4), replace the three old sections with the new IA, render `StatusPill` per Needs-review row using `freshnessTier`, show `N/total done` on multi-step rows (link to `/tasks/[taskId]`), single-task rows show `pill.toDo`, and add `see all →` deep-links (`link.seeAll`) per section header. Rename "Snoozed" → `section.savedLater`.

- [ ] **Step 4: Run to verify pass + types.** Run: `npx vitest run src/components/inbox && npx tsc --noEmit` — Expected: PASS.

- [ ] **Step 5: Commit.**
```bash
git add src/components/inbox/inbox-view.tsx
git commit -m "feat(inbox): wireframe IA — Needs review / To do (single+multi) / Saved for later + deep-links"
```

---

### Task 8: Capture ✓, inline delete confirm, 24h prompt

**Files:**
- Modify: `src/components/inbox/inbox-view.tsx`

**Interfaces:**
- Consumes: `dismissPrompt`/`freshenItem` (Task 3), `shouldPrompt24h` (Task 2), strings (Task 4).

- [ ] **Step 1: Write failing tests** — (a) after capture submit, a transient `capture.confirm` ("captured ✓") appears; (b) clicking delete shows a `Delete · cancel` confirm and does NOT call `deleteBrainDumpItem` until confirmed; (c) an item passing `shouldPrompt24h` renders `prompt.stillNeeded` with a `action.dismiss` button that calls `dismissPrompt`.

- [ ] **Step 2: Run to verify fail.** Run: `npx vitest run src/components/inbox` — Expected: FAIL.

- [ ] **Step 3: Implement** — transient "captured ✓" state on submit (clears after ~1.5s); per-row `confirmingDelete` state gating `deleteBrainDumpItem`; inline 24h prompt block (bg `#fff5f5`, border `#c0392b`) with Dismiss→`dismissPrompt`. Reconcile with the existing desktop-notification path (`markReminded`/`showReminder`, lines ~126-143) so the inline prompt and notification don't double-signal — the inline prompt is the canonical review nudge; keep notifications but gate on `!promptDismissedAt`.

- [ ] **Step 4: Run to verify pass.** Run: `npx vitest run src/components/inbox` — Expected: PASS.

- [ ] **Step 5: Commit.**
```bash
git add src/components/inbox/inbox-view.tsx
git commit -m "feat(inbox): captured-check, inline delete confirm, 24h still-needed prompt"
```

---

### Task 9: Settings panel — 3 tier-hour inputs

**Files:**
- Modify: `src/components/inbox/settings-panel.tsx`

**Interfaces:**
- Consumes: extended `updateAgingSettings` (Task 3).

- [ ] **Step 1: Write failing test** — panel renders three labelled hour inputs (Aging/Softening, Overdue/Soggy, Way overdue/Stale) seeded from settings, and submitting calls `updateAgingSettings` with the three hour values.

- [ ] **Step 2: Run to verify fail.** Run: `npx vitest run src/components/inbox` — Expected: FAIL.

- [ ] **Step 3: Implement** — add the three inputs (voice-aware labels via `t("freshness.*")`), wire into the existing save transition.

- [ ] **Step 4: Run to verify pass.** Run: `npx vitest run src/components/inbox` — Expected: PASS.

- [ ] **Step 5: Commit.**
```bash
git add src/components/inbox/settings-panel.tsx
git commit -m "feat(settings): configurable 4-tier freshness thresholds"
```

---

### Task 10: ☰ hamburger nav menu + route stubs

**Files:**
- Create: `src/components/nav/app-menu.tsx` (client)
- Create: `src/components/nav/app-menu.test.tsx`
- Modify: `src/app/(app)/layout.tsx`
- Create: `src/app/(app)/library/page.tsx` (stub)
- Create: `src/app/(app)/settings/page.tsx` (stub)

**Interfaces:**
- Consumes: `t` + `Voice` (passed from layout), Next `Link`.
- Produces: `<AppMenu voice={Voice} />` — a ☰ button toggling a menu of: Inbox (`/inbox`), Focus Timer (`/focus`), Dashboard (`/dashboard`), Everything (`/library`), Settings (`/settings`). **Task Breakdown is NOT listed.**

- [ ] **Step 1: Write failing test** (`app-menu.test.tsx`) — after clicking ☰, the five destinations render with correct hrefs and **no** "Task Breakdown"/"Break into steps" entry:
```ts
it("lists the five destinations and excludes Task Breakdown", async () => {
  render(<AppMenu voice="plain" />);
  await userEvent.click(screen.getByRole("button", { name: /menu/i }));
  expect(screen.getByRole("link", { name: /Inbox/ })).toHaveAttribute("href", "/inbox");
  expect(screen.getByRole("link", { name: /Focus Timer/ })).toHaveAttribute("href", "/focus");
  expect(screen.getByRole("link", { name: /Everything/ })).toHaveAttribute("href", "/library");
  expect(screen.getByRole("link", { name: /Settings/ })).toHaveAttribute("href", "/settings");
  expect(screen.queryByText(/Task Breakdown|Break into steps/)).not.toBeInTheDocument();
});
```

- [ ] **Step 2: Run to verify fail.** Run: `npx vitest run src/components/nav` — Expected: FAIL.

- [ ] **Step 3: Implement** `AppMenu` (accessible: ☰ button with `aria-label`/`aria-expanded`, ≥44px targets, closes on route change/escape), voice-aware labels (`nav.*`). Mount it in `layout.tsx` header (replace or augment the current inline links). Create `/library` and `/settings` minimal server-component stubs (each: heading via `t`, a "coming soon"/back link; `/library` reads `searchParams.tab` (awaited Promise) so deep-links don't 404).

- [ ] **Step 4: Run to verify pass + build.** Run: `npx vitest run src/components/nav && npm run build` — Expected: PASS; `/library` + `/settings` routes compile.

- [ ] **Step 5: Commit.**
```bash
git add src/components/nav "src/app/(app)/layout.tsx" "src/app/(app)/library" "src/app/(app)/settings"
git commit -m "feat(nav): ☰ hamburger menu + library/settings route stubs"
```

---

### Task 11: Full verification + MR

- [ ] **Step 1: Full suite.** Run: `npx vitest run` — Expected: all green.
- [ ] **Step 2: Types + build.** Run: `npx tsc --noEmit && npm run build` — Expected: clean.
- [ ] **Step 3: Manual/`/verify` smoke** — capture an item → see "captured ✓"; watch a Needs-review item change tier (use demo override); dismiss a 24h prompt; delete with confirm; open ☰ menu → each destination routes; deep-links resolve. Confirm Plain voice shows no decorative emoji.
- [ ] **Step 4: Push + open MR** → `main`, assign @GitLabDuo, milestone v0.0.2, description linking #8 (Phase 2) + Decision 3 (freshenedAt) + the ☰-into-Phase-2 note. **Do not merge — owner approval required.**

---

## Self-Review

- **Spec coverage:** Inbox IA (T5,T7) ✓ · freshness 4-tier (T1,T2,T6) ✓ · thresholds configurable (T1,T3,T9) ✓ · `freshenedAt` non-destructive (T1,T2) ✓ · 24h prompt + Dismiss (T1,T2,T8) ✓ · capture ✓ (T8) · new-to-top (existing desc sort + T7) ✓ · inline delete confirm (T8) ✓ · see-all deep-links (T7) ✓ · ☰ menu w/o Task Breakdown (T10) ✓ · Plain emoji-free (Global + T4) ✓ · workspace scoping (Global + T3,T5) ✓.
- **Type consistency:** `AgingSettings` extended once (T2) and consumed by T3/T5/T6/T7/T9; `FreshnessTier` defined T2, used T6/T7; `freshenItem`/`dismissPrompt` names consistent T3↔T8.
- **Sequencing note:** T5 (page props) and T7 (InboxView consuming them) are type-coupled — if `tsc` can't pass between them, add the widened `Item` type fields in T5 and land T5→T7 back-to-back. Flagged in T5 Step 4.
- **Known Phase-3 handoff:** Done bucket + real Library tabs are Phase 3; Phase 2 only filters done tasks out and points see-all at `/library?tab=…` stubs.
