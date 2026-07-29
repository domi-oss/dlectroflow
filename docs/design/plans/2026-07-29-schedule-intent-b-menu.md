# Schedule intent B — the Schedule menu Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Let the owner say **when a task must be done and how urgent it is** before it is pushed to Reclaim, in a popover that remembers what they said last time.

**Architecture:** Sub-project A built the whole pipeline — `ScheduleIntent` → `deriveWindows` → encoders → `upsertGoogleTask` — and gave it a `defaultIntentFor()` so the no-menu path already behaves correctly. B adds the two things a UI needs on top: three nullable columns so an intent survives being closed, and a presentational popover that edits an intent and hands it back. The server action's signature grows one optional parameter; nothing else in A moves.

**Tech Stack:** TypeScript, Next.js 16.2, Prisma + Postgres, `@base-ui/react/popover`, vitest 4.1 + jsdom/RTL, `vitest-axe`, Playwright.

**Spec:** [`docs/design/specs/2026-07-29-schedule-intent-design.md`](../specs/2026-07-29-schedule-intent-design.md) §6
**Issue:** #106. **Depends on #104** (sub-project A) being merged — this plan imports `ScheduleIntent`, `defaultIntentFor`, `deriveWindows` and `SCHEDULE_MIN_BLOCK_MIN` from it. Cut the branch from `main` **after** A lands, or from A's branch if you are stacking.

## Global Constraints

- **No new npm dependencies.** `@base-ui/react/popover` is already used; the duration popover in `src/components/inbox/row-actions.tsx:250` is the pattern to copy.
- **`AGENTS.md` applies:** Next.js 16.2, APIs differ from training data. Read `node_modules/next/dist/docs/` before touching framework code.
- **Defaults must match A exactly** — deadline 3 days out, priority `high`, hours `work`, `busy` true. They come from `defaultIntentFor()`; do not restate them as literals in the UI, or the menu path and the no-menu path will drift.
- **`defaultIntentFor` lives in `src/lib/scheduling/intent.ts`, not in the action file.** !187 had to move it there: `next build` rejects a **synchronous** export from a `"use server"` module, and making it async would have turned "what are the defaults?" into a network call from this plan's client component. Import it from `@/lib/scheduling/intent`.
- **Pseudo-enum columns get CHECK constraints** named `<Table>_<column>_check`, mirroring the const object, and **must be registered** in `src/lib/enum-constraint-sync.integration.test.ts`'s `REGISTRY` — the suite fails if a managed constraint exists without a registry entry or vice versa.
- **Migrations repair before they enforce** (see `prisma/migrations/20260727194512_step_est_minutes_check/migration.sql`): if a column could hold a violating value, `UPDATE` it first so `prisma migrate deploy` cannot wedge a release halfway.
- **Accessibility is a gate, not a polish pass.** The popover needs an accessible name (axe's `aria-dialog-name`), labelled controls, full keyboard operation, focus restored to the trigger on close, and 44×44 minimum touch targets via `touchTarget` from `src/lib/utils.ts`.
- **Verify in a production build**, not only jsdom — `next build`'s JSX whitespace trimming differs from vitest's and shipped `"rolling 30 dayswindow"` once.
- **Commit trailer** on every commit: `Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>`
- Gates before the MR: `npm test`, `npx tsc --noEmit`, `npm run lint`, `npm run format:check`, `npm run build && npm run test:e2e`.

## File Structure

| File | Responsibility |
|---|---|
| `prisma/schema.prisma` **(modify)** | Three nullable columns on `Task`. |
| `prisma/migrations/<ts>_task_schedule_intent/migration.sql` **(create)** | Columns + two CHECK constraints, with the repair-before-enforce comment block. |
|  ~~`src/lib/scheduling/constants.ts`~~ **(not created)** | Nothing new — see Task 1 Step 3. The enum values already live in `src/lib/scheduling/types.ts`; this file is **not** created. |
| `src/lib/enum-constraint-sync.integration.test.ts` **(modify)** | Two `REGISTRY` entries so the new constraints are managed, not orphaned. |
| `src/lib/scheduling/summary.ts` **(create)** | Pure: turns a `WindowPlan` into the menu's one-line summary or its feasibility warning. Testable without a DOM. |
| `src/app/actions/schedule-intent.ts` **(create)** | `loadScheduleIntent(taskId)` — persisted-or-default intent for prefill. Server-only. |
| `src/components/scheduling/schedule-menu.tsx` **(create)** | Presentational popover. Props in, one `onSchedule(intent)` out. No data fetching, no server actions. |
| `src/app/actions/google-schedule.ts` **(modify)** | `pushStepsToGoogleTasks` takes an optional intent and persists it. |
| `src/components/inbox/row-actions.tsx` **(modify)** | The Google branch of the 📅 control opens the menu instead of firing immediately. ICS branch untouched. |

The split matters: `summary.ts` holds the only logic worth testing without a DOM, `schedule-menu.tsx` stays dumb enough to test with RTL alone, and the action keeps all the Prisma access. Nothing in this list is over ~200 lines.

---

### Task 1: Persist the intent

**Files:**
- Modify: `prisma/schema.prisma` (`model Task`)
- Create: `prisma/migrations/<timestamp>_task_schedule_intent/migration.sql`
- Modify: `src/lib/enum-constraint-sync.integration.test.ts` (`REGISTRY`)
- Test: `src/lib/task-schedule-intent-check.integration.test.ts` (create)

**Interfaces:**
- Produces: `Task.scheduleDueAt: DateTime?`, `Task.schedulePriority: String?`, `Task.scheduleHours: String?`

- [x] **Step 1: Write the failing integration test**

Read `src/lib/step-est-minutes-check.integration.test.ts` first — it is the template for how this repo proves a constraint behaviourally (raw SQL insert, expect rejection). Create `src/lib/task-schedule-intent-check.integration.test.ts` in the same shape:

```ts
import { describe, it, expect } from "vitest";
import { prisma } from "@/lib/db";

/**
 * The DB refuses a schedule intent it cannot mean (#106). The app only ever
 * writes values from SchedulePriority / ScheduleHours, but a constraint is what
 * makes that true for the fifth writer added later.
 */
describe("Task schedule-intent CHECK constraints", () => {
  it("accepts every legal priority", async () => {
    for (const p of ["critical", "high", "normal", "low"]) {
      await expect(
        prisma.$executeRawUnsafe(
          `UPDATE "Task" SET "schedulePriority" = $1 WHERE false`,
          p,
        ),
      ).resolves.toBeDefined();
    }
  });

  it("rejects a priority that is not one of the four", async () => {
    await expect(
      prisma.$executeRawUnsafe(
        `INSERT INTO "Task" ("id","title","status","source","workspaceId","schedulePriority","createdAt","updatedAt")
         VALUES ('t_bad_prio','x','active','braindump',
                 (SELECT "id" FROM "Workspace" LIMIT 1),'urgent',now(),now())`,
      ),
    ).rejects.toThrow(/Task_schedulePriority_check/);
  });

  it("rejects hours that are neither work nor personal", async () => {
    await expect(
      prisma.$executeRawUnsafe(
        `INSERT INTO "Task" ("id","title","status","source","workspaceId","scheduleHours","createdAt","updatedAt")
         VALUES ('t_bad_hours','x','active','braindump',
                 (SELECT "id" FROM "Workspace" LIMIT 1),'evenings',now(),now())`,
      ),
    ).rejects.toThrow(/Task_scheduleHours_check/);
  });

  it("allows NULL — an unscheduled task has no intent yet", async () => {
    const ws = await prisma.workspace.findFirst();
    const created = await prisma.task.create({
      data: { title: "no intent", status: "active", source: "braindump", workspaceId: ws!.id },
    });
    expect(created.schedulePriority).toBeNull();
    expect(created.scheduleHours).toBeNull();
    expect(created.scheduleDueAt).toBeNull();
    await prisma.task.delete({ where: { id: created.id } });
  });
});
```

- [x] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/lib/task-schedule-intent-check.integration.test.ts`
Expected: FAIL — `column "schedulePriority" of relation "Task" does not exist`.

- [x] **Step 3: Add the columns to the schema**

In `prisma/schema.prisma`, inside `model Task`, add:

```prisma
  /// What the owner asked for the last time this task was scheduled (#106), so
  /// the Schedule menu can prefill instead of asking again. Null until a task is
  /// scheduled through the menu; `defaultIntentFor()` supplies the fallback.
  scheduleDueAt    DateTime?
  /// SchedulePriority — critical | high | normal | low. CHECK-constrained.
  schedulePriority String?
  /// ScheduleHours — work | personal. CHECK-constrained.
  scheduleHours    String?
```

The enum values live in `src/lib/scheduling/types.ts` (added by #104) — do **not** duplicate them into `src/lib/constants.ts`, and do not create a new constants file. The registry entry in Step 5 imports them from there.

- [x] **Step 4: Write the migration**

Create `prisma/migrations/<timestamp>_task_schedule_intent/migration.sql` — use a timestamp later than `20260727230000`:

```sql
-- #106 — the Schedule menu's three fields, persisted so re-opening the menu
-- prefills instead of asking again.
--
-- All three are nullable and default NULL: a task that has never been scheduled
-- through the menu has no intent, and `defaultIntentFor()` supplies the
-- fallback (3 days out, high, work). That is deliberately NOT a column default
-- — a column default would freeze "3 days from the migration", and it would
-- also make "the owner chose this" indistinguishable from "nobody has said".
--
-- The two pseudo-enum columns get CHECK constraints mirroring
-- src/lib/scheduling/types.ts, following the #38 pattern and registered in
-- src/lib/enum-constraint-sync.integration.test.ts so dropping one out of band
-- fails the suite. Behavioural proof lives in
-- src/lib/task-schedule-intent-check.integration.test.ts.
--
-- No repair statement is needed here, unlike the Step.estMinutes constraint:
-- these columns do not exist yet, so every existing row gets NULL, and NULL
-- satisfies both constraints. If you later widen the allowed values, THAT
-- migration needs a repair pass.

ALTER TABLE "Task" ADD COLUMN "scheduleDueAt" TIMESTAMP(3);
ALTER TABLE "Task" ADD COLUMN "schedulePriority" TEXT;
ALTER TABLE "Task" ADD COLUMN "scheduleHours" TEXT;

-- Task.schedulePriority ← SchedulePriority (critical | high | normal | low)
ALTER TABLE "Task"
  ADD CONSTRAINT "Task_schedulePriority_check"
  CHECK ("schedulePriority" IS NULL OR "schedulePriority" IN ('critical', 'high', 'normal', 'low'));

-- Task.scheduleHours ← ScheduleHours (work | personal)
ALTER TABLE "Task"
  ADD CONSTRAINT "Task_scheduleHours_check"
  CHECK ("scheduleHours" IS NULL OR "scheduleHours" IN ('work', 'personal'));
```

- [x] **Step 5: Register the constraints**

In `src/lib/enum-constraint-sync.integration.test.ts`, import the two const objects and append to `REGISTRY`:

```ts
import { SchedulePriority, ScheduleHours } from "@/lib/scheduling/types";

// … inside REGISTRY:
  {
    constraint: "Task_schedulePriority_check",
    table: "Task",
    column: "schedulePriority",
    values: SchedulePriority,
    nullable: true,
  },
  {
    constraint: "Task_scheduleHours_check",
    table: "Task",
    column: "scheduleHours",
    values: ScheduleHours,
    nullable: true,
  },
```

- [x] **Step 6: Apply and run both tests**

```bash
npx prisma migrate dev --name task_schedule_intent
npx vitest run src/lib/task-schedule-intent-check.integration.test.ts src/lib/enum-constraint-sync.integration.test.ts
```

Expected: PASS. If the sync test reports an unmanaged constraint, the name in the migration and the name in `REGISTRY` disagree — fix the registry, not the SQL, since the SQL name follows the convention.

- [x] **Step 7: Commit**

```bash
git add prisma/schema.prisma prisma/migrations src/lib/enum-constraint-sync.integration.test.ts src/lib/task-schedule-intent-check.integration.test.ts
git commit -m "feat(db): persist the schedule intent on Task (#106)

Three nullable columns so re-opening the Schedule menu prefills what the
owner said last time instead of asking again. Nullable and NULL-defaulted on
purpose: a column default would freeze '3 days from the migration date', and
it would make 'the owner chose this' indistinguishable from 'nobody has said
yet' - which is exactly the distinction prefill needs.

The two pseudo-enum columns are CHECK-constrained against
src/lib/scheduling/types.ts and registered in the sync test, so dropping one
out of band fails the suite rather than silently loosening the schema.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: The summary line — and the warning it becomes

**Files:**
- Create: `src/lib/scheduling/summary.ts`
- Test: `src/lib/scheduling/summary.test.ts`

**Interfaces:**
- Consumes: `WindowPlan` from `@/lib/scheduling/windows` (#104).
- Produces:
  - `formatBlockMinutes(total: number): string` — `"45m"`, `"3h30m"`, `"2h"`
  - `scheduleSummary(plan: WindowPlan, unitCount: number, dueAt: Date): { text: string; warning: boolean }`

- [x] **Step 1: Write the failing tests**

Create `src/lib/scheduling/summary.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { formatBlockMinutes, scheduleSummary } from "./summary";
import type { WindowPlan } from "./windows";

const bst = (iso: string) => new Date(`${iso}:00.000+01:00`);

function plan(over: Partial<WindowPlan> = {}): WindowPlan {
  return {
    windows: [],
    feasible: true,
    availableMin: 1710,
    requiredMin: 210,
    earliestFeasibleDue: null,
    ...over,
  };
}

describe("formatBlockMinutes", () => {
  it("renders minutes under an hour", () => {
    expect(formatBlockMinutes(45)).toBe("45m");
  });
  it("renders whole hours without a stray 0m", () => {
    expect(formatBlockMinutes(120)).toBe("2h");
  });
  it("renders hours and minutes together", () => {
    expect(formatBlockMinutes(210)).toBe("3h30m");
  });
  it("renders zero honestly rather than as an empty string", () => {
    expect(formatBlockMinutes(0)).toBe("0m");
  });
});

describe("scheduleSummary — the feasible case", () => {
  it("states the step count, the total block time and the deadline", () => {
    const s = scheduleSummary(plan(), 7, bst("2026-07-31T17:00"));
    expect(s.warning).toBe(false);
    expect(s.text).toContain("7 steps");
    expect(s.text).toContain("3h30m");
    expect(s.text).toMatch(/in order/i);
  });

  it("says 'step' not 'steps' for one", () => {
    const s = scheduleSummary(plan({ requiredMin: 30 }), 1, bst("2026-07-31T17:00"));
    expect(s.text).toContain("1 step");
    expect(s.text).not.toContain("1 steps");
  });

  it("drops the ordering clause for a single step — there is nothing to order", () => {
    const s = scheduleSummary(plan({ requiredMin: 30 }), 1, bst("2026-07-31T17:00"));
    expect(s.text).not.toMatch(/in order/i);
  });
});

describe("scheduleSummary — the warning case", () => {
  const infeasible = plan({
    feasible: false,
    availableMin: 240,
    requiredMin: 270,
    earliestFeasibleDue: bst("2026-08-03T11:00"),
  });

  it("flags itself as a warning", () => {
    expect(scheduleSummary(infeasible, 7, bst("2026-07-31T17:00")).warning).toBe(true);
  });

  it("says how much room there is, how much is needed, and what would fit", () => {
    const { text } = scheduleSummary(infeasible, 7, bst("2026-07-31T17:00"));
    expect(text).toContain("4h"); // available
    expect(text).toContain("4h30m"); // required
    expect(text).toMatch(/Mon|Monday|3 Aug/); // the earliest date that fits
  });

  it("does not suggest a date when there is none to suggest", () => {
    const { text } = scheduleSummary(
      plan({ feasible: false, availableMin: 0, requiredMin: 30, earliestFeasibleDue: null }),
      1,
      bst("2026-07-28T17:00"),
    );
    expect(text).toMatch(/no working time/i);
  });
});
```

- [x] **Step 2: Run to verify they fail**

Run: `npx vitest run src/lib/scheduling/summary.test.ts`
Expected: FAIL — module not found.

- [x] **Step 3: Implement**

Create `src/lib/scheduling/summary.ts`:

```ts
/**
 * The one line under the Schedule menu's fields (#106).
 *
 * Pure on purpose: it is the only logic in the menu worth testing, and keeping
 * it out of the component means the wording can be asserted exactly without a
 * DOM. It has two moods — a calm summary, and the same sentence turned into a
 * warning when the deadline cannot hold the work. It never blocks: a deliberate
 * over-commit is the owner's call, so the warning informs and the button stays
 * enabled.
 */
import { schedulingTimeZone } from "./hours";
import type { WindowPlan } from "./windows";

export function formatBlockMinutes(total: number): string {
  const m = Math.max(0, Math.round(total));
  const h = Math.floor(m / 60);
  const rest = m % 60;
  if (h === 0) return `${rest}m`;
  return rest === 0 ? `${h}h` : `${h}h${rest}m`;
}

function shortDay(d: Date): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: schedulingTimeZone(),
    weekday: "short",
    day: "numeric",
    month: "short",
  }).format(d);
}

export function scheduleSummary(
  plan: WindowPlan,
  unitCount: number,
  dueAt: Date,
): { text: string; warning: boolean } {
  const steps = `${unitCount} step${unitCount === 1 ? "" : "s"}`;
  const blocks = formatBlockMinutes(plan.requiredMin);

  if (plan.feasible) {
    const ordered = unitCount > 1 ? `, spread in order before ${shortDay(dueAt)}` : "";
    return { text: `${steps} · ${blocks} of blocks${ordered}`, warning: false };
  }

  if (plan.availableMin <= 0) {
    return {
      text: `${shortDay(dueAt)} leaves no working time before the deadline — ${steps} need ${blocks}.`,
      warning: true,
    };
  }

  const fits = plan.earliestFeasibleDue
    ? ` Earliest that fits: ${shortDay(plan.earliestFeasibleDue)}.`
    : "";
  return {
    text: `${shortDay(dueAt)} leaves ${formatBlockMinutes(plan.availableMin)} of working time; ${steps} need ${blocks}.${fits}`,
    warning: true,
  };
}
```

- [x] **Step 4: Run to verify they pass**

Run: `npx vitest run src/lib/scheduling/summary.test.ts`
Expected: PASS.

- [x] **Step 5: Commit**

```bash
git add src/lib/scheduling/summary.ts src/lib/scheduling/summary.test.ts
git commit -m "feat(scheduling): the menu's summary line, and the warning it becomes (#106)

Pure, so the exact wording can be asserted without a DOM - and because this
is the only logic in the menu worth testing. Two moods from one function: a
calm '7 steps, 3h30m of blocks, spread in order before Fri 31 Jul', or the
same facts turned into 'Friday leaves 4h; these need 4h30m. Earliest that
fits: Mon 3 Aug.'

It informs and never blocks - a deliberate over-commit is the owner's call.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: `loadScheduleIntent`

**Files:**
- Create: `src/app/actions/schedule-intent.ts`
- Test: `src/app/actions/schedule-intent.test.ts`

**Interfaces:**
- Consumes: `defaultIntentFor` from `@/lib/scheduling/intent` (#104 — NOT from the action file; see Global Constraints), `prisma`, `currentWorkspaceId`, `isOwnerRequest`.
- Produces: `loadScheduleIntent(taskId: string): Promise<ScheduleIntent | null>` — `null` when the task is not visible to the caller.

- [x] **Step 1: Write the failing tests**

Create `src/app/actions/schedule-intent.test.ts`. Follow the mocking style already used by the repo's action tests — read `src/app/actions/google-schedule.test.ts` (created by #104) first and mirror it:

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { SchedulePriority, ScheduleHours } from "@/lib/scheduling/types";

const findFirst = vi.fn();
vi.mock("@/lib/db", () => ({
  prisma: { task: { findFirst: (...a: unknown[]) => findFirst(...a) } },
  getSettings: vi.fn(async () => ({ voice: "plain" })),
}));
vi.mock("@/lib/workspace", () => ({
  currentWorkspaceId: vi.fn(async () => "ws_1"),
  isOwnerRequest: vi.fn(async () => true),
}));

import { loadScheduleIntent } from "./schedule-intent";

beforeEach(() => findFirst.mockReset());

describe("loadScheduleIntent", () => {
  const steps = [
    { id: "s1", order: 1, text: "a", subtaskEmoji: "🔗", estMinutes: 15 },
    { id: "s2", order: 2, text: "b", subtaskEmoji: null, estMinutes: 45 },
  ];

  it("returns the persisted intent when the task has one", async () => {
    const dueAt = new Date("2026-08-07T16:00:00.000Z");
    findFirst.mockResolvedValue({
      id: "t1",
      scheduleDueAt: dueAt,
      schedulePriority: "critical",
      scheduleHours: "personal",
      steps,
    });
    const intent = await loadScheduleIntent("t1");
    expect(intent!.dueAt.toISOString()).toBe(dueAt.toISOString());
    expect(intent!.priority).toBe(SchedulePriority.Critical);
    expect(intent!.hours).toBe(ScheduleHours.Personal);
  });

  it("falls back to A's defaults when nothing is persisted", async () => {
    findFirst.mockResolvedValue({
      id: "t1", scheduleDueAt: null, schedulePriority: null, scheduleHours: null, steps,
    });
    const intent = await loadScheduleIntent("t1");
    expect(intent!.priority).toBe(SchedulePriority.High);
    expect(intent!.hours).toBe(ScheduleHours.Work);
    expect(intent!.busy).toBe(true);
  });

  it("carries every step through as an ordered unit with its emoji and estimate", async () => {
    findFirst.mockResolvedValue({
      id: "t1", scheduleDueAt: null, schedulePriority: null, scheduleHours: null, steps,
    });
    const intent = await loadScheduleIntent("t1");
    expect(intent!.units).toEqual([
      { id: "s1", order: 1, total: 2, text: "a", emoji: "🔗", estMinutes: 15, dueAt: null },
      { id: "s2", order: 2, total: 2, text: "b", emoji: null, estMinutes: 45, dueAt: null },
    ]);
  });

  it("ignores a persisted priority the DB should never have held", async () => {
    findFirst.mockResolvedValue({
      id: "t1", scheduleDueAt: null, schedulePriority: "urgent", scheduleHours: null, steps,
    });
    // The CHECK constraint makes this unreachable, but a loader that trusts the
    // DB blindly would put "urgent" into a Reclaim parameter.
    expect((await loadScheduleIntent("t1"))!.priority).toBe(SchedulePriority.High);
  });

  it("returns null for a task outside the caller's workspace", async () => {
    findFirst.mockResolvedValue(null);
    expect(await loadScheduleIntent("t_other")).toBeNull();
  });

  it("scopes the query by workspace — not by id alone", async () => {
    findFirst.mockResolvedValue(null);
    await loadScheduleIntent("t1");
    expect(findFirst.mock.calls[0][0].where).toMatchObject({ id: "t1", workspaceId: "ws_1" });
  });
});
```

- [x] **Step 2: Run to verify they fail**

Run: `npx vitest run src/app/actions/schedule-intent.test.ts`
Expected: FAIL — module not found.

- [x] **Step 3: Implement**

Create `src/app/actions/schedule-intent.ts`:

```ts
"use server";

import { prisma } from "@/lib/db";
import { currentWorkspaceId, isOwnerRequest } from "@/lib/workspace";
import { defaultIntentFor } from "@/lib/scheduling/intent";
import { SchedulePriority, ScheduleHours } from "@/lib/scheduling/types";
import type { ScheduleIntent, ScheduleUnit } from "@/lib/scheduling/types";

const PRIORITIES = new Set<string>(Object.values(SchedulePriority));
const HOURS = new Set<string>(Object.values(ScheduleHours));

/**
 * The intent the Schedule menu opens with (#106): what the owner said last time,
 * or A's defaults if they have never said anything.
 *
 * Validates the two pseudo-enum columns on the way out even though a CHECK
 * constraint makes an illegal value unreachable — this loader's output goes
 * straight into a Reclaim parameter, and "trust the database" is how a bad row
 * becomes a malformed title.
 */
export async function loadScheduleIntent(
  taskId: string,
): Promise<ScheduleIntent | null> {
  const workspaceId = await currentWorkspaceId();
  // Google is still the owner's singleton connection until #35 Phase C.
  if (!(await isOwnerRequest())) return null;

  const task = await prisma.task.findFirst({
    where: { id: taskId, workspaceId },
    select: {
      id: true,
      scheduleDueAt: true,
      schedulePriority: true,
      scheduleHours: true,
      steps: {
        orderBy: { order: "asc" },
        select: { id: true, order: true, text: true, subtaskEmoji: true, estMinutes: true },
      },
    },
  });
  if (!task) return null;

  const units: ScheduleUnit[] = task.steps.map((s) => ({
    id: s.id,
    order: s.order,
    total: task.steps.length,
    text: s.text,
    emoji: s.subtaskEmoji,
    estMinutes: s.estMinutes,
    dueAt: null,
  }));

  const base = defaultIntentFor(units);
  return {
    ...base,
    dueAt: task.scheduleDueAt ?? base.dueAt,
    priority:
      task.schedulePriority && PRIORITIES.has(task.schedulePriority)
        ? (task.schedulePriority as ScheduleIntent["priority"])
        : base.priority,
    hours:
      task.scheduleHours && HOURS.has(task.scheduleHours)
        ? (task.scheduleHours as ScheduleIntent["hours"])
        : base.hours,
  };
}
```

- [x] **Step 4: Run to verify they pass**

Run: `npx vitest run src/app/actions/schedule-intent.test.ts`
Expected: PASS.

- [x] **Step 5: Commit**

```bash
git add src/app/actions/schedule-intent.ts src/app/actions/schedule-intent.test.ts
git commit -m "feat(scheduling): load the intent the menu prefills from (#106)

What the owner said last time, or A's defaults if they never have - built on
defaultIntentFor rather than restating the defaults, so the menu path and the
no-menu path cannot drift.

It re-validates the two pseudo-enum columns on the way out even though a
CHECK constraint makes an illegal value unreachable, because this output goes
straight into a Reclaim title parameter and 'trust the database' is how one
bad row becomes a malformed schedule.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: The menu component

**Files:**
- Create: `src/components/scheduling/schedule-menu.tsx`
- Test: `src/components/scheduling/schedule-menu.test.tsx`

**Interfaces:**
- Consumes: `ScheduleIntent` (#104), `deriveWindows` (#104), `scheduleSummary` (Task 2), `Popover` from `@base-ui/react/popover`, `ANCHORED_POSITIONER` and `popupSurface` from `@/components/ui/anchored-popup`, `touchTarget` and `cn` from `@/lib/utils`.
- Produces:
  ```ts
  export type ScheduleMenuProps = {
    taskTitle: string;
    intent: ScheduleIntent;
    /** Reclaim-specific fields are hidden when the active method is ICS-only. */
    showReclaimFields: boolean;
    pending?: boolean;
    onSchedule: (intent: ScheduleIntent) => void;
    trigger: ReactNode;
  };
  export function ScheduleMenu(props: ScheduleMenuProps): JSX.Element;
  ```

**Read first:** `src/components/inbox/row-actions.tsx:250–283`. That is the popover pattern this repo uses — `Popover.Root` with every close route funnelled through one `close()`, `Popover.Portal` with `container={rootRef}`, `ANCHORED_POSITIONER`, and `aria-label` on `Popover.Popup` because there is no visible heading for `aria-labelledby` to point at (axe's `aria-dialog-name`). Copy that structure; do not invent a second popover idiom.

- [x] **Step 1: Write the failing tests**

Create `src/components/scheduling/schedule-menu.test.tsx`:

```tsx
import { describe, it, expect, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { axe } from "vitest-axe";
import { ScheduleMenu } from "./schedule-menu";
import { SchedulePriority, ScheduleHours } from "@/lib/scheduling/types";
import type { ScheduleIntent } from "@/lib/scheduling/types";

const intent: ScheduleIntent = {
  dueAt: new Date("2026-07-31T16:00:00.000Z"),
  priority: SchedulePriority.High,
  hours: ScheduleHours.Work,
  busy: true,
  units: [1, 2, 3].map((n) => ({
    id: `s${n}`, order: n, total: 3, text: `step ${n}`, estMinutes: 30,
  })),
};

function setup(over: Partial<React.ComponentProps<typeof ScheduleMenu>> = {}) {
  const onSchedule = vi.fn();
  const utils = render(
    <ScheduleMenu
      taskTitle="do flex training"
      intent={intent}
      showReclaimFields
      onSchedule={onSchedule}
      trigger={<span>📅</span>}
      {...over}
    />,
  );
  return { onSchedule, ...utils };
}

async function open() {
  await userEvent.click(screen.getByRole("button", { name: /schedule/i }));
  return screen.getByRole("dialog");
}

describe("ScheduleMenu", () => {
  it("names the dialog for screen readers and for axe", async () => {
    setup();
    const dialog = await open();
    expect(dialog).toHaveAccessibleName(/schedule/i);
  });

  it("has no axe violations when open", async () => {
    const { container } = setup();
    await open();
    expect(await axe(container)).toHaveNoViolations();
  });

  it("prefills from the intent it was given", async () => {
    setup();
    const dialog = await open();
    expect(within(dialog).getByLabelText(/done by/i)).toHaveValue("2026-07-31");
    expect(within(dialog).getByLabelText(/priority/i)).toHaveValue("high");
    expect(within(dialog).getByRole("radio", { name: /work/i })).toBeChecked();
  });

  it("shows the summary line for the prefilled intent", async () => {
    setup();
    const dialog = await open();
    expect(within(dialog).getByText(/3 steps/)).toBeInTheDocument();
    expect(within(dialog).getByText(/1h30m/)).toBeInTheDocument();
  });

  it("hides priority and hours when only .ics is available — they do nothing there", async () => {
    setup({ showReclaimFields: false });
    const dialog = await open();
    expect(within(dialog).getByLabelText(/done by/i)).toBeInTheDocument();
    expect(within(dialog).queryByLabelText(/priority/i)).toBeNull();
    expect(within(dialog).queryByRole("radio", { name: /work/i })).toBeNull();
  });

  it("hands back the edited intent, not the original", async () => {
    const { onSchedule } = setup();
    const dialog = await open();
    await userEvent.clear(within(dialog).getByLabelText(/done by/i));
    await userEvent.type(within(dialog).getByLabelText(/done by/i), "2026-08-07");
    await userEvent.selectOptions(within(dialog).getByLabelText(/priority/i), "critical");
    await userEvent.click(within(dialog).getByRole("radio", { name: /personal/i }));
    await userEvent.click(within(dialog).getByRole("button", { name: /^schedule$/i }));

    expect(onSchedule).toHaveBeenCalledTimes(1);
    const sent = onSchedule.mock.calls[0][0] as ScheduleIntent;
    expect(sent.priority).toBe(SchedulePriority.Critical);
    expect(sent.hours).toBe(ScheduleHours.Personal);
    expect(sent.dueAt.toISOString().slice(0, 10)).toBe("2026-08-07");
    expect(sent.units).toHaveLength(3);
  });

  it("warns, but still lets you schedule, when the deadline cannot fit the work", async () => {
    setup({
      intent: {
        ...intent,
        dueAt: new Date(Date.now() + 30 * 60_000),
        units: [1, 2, 3, 4, 5, 6, 7].map((n) => ({
          id: `s${n}`, order: n, total: 7, text: `step ${n}`, estMinutes: 60,
        })),
      },
    });
    const dialog = await open();
    expect(within(dialog).getByRole("status")).toHaveTextContent(/need/i);
    expect(within(dialog).getByRole("button", { name: /^schedule$/i })).toBeEnabled();
  });

  it("closes on Escape without scheduling", async () => {
    const { onSchedule } = setup();
    await open();
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(onSchedule).not.toHaveBeenCalled();
  });

  it("is fully operable from the keyboard", async () => {
    const { onSchedule } = setup();
    await userEvent.tab();
    await userEvent.keyboard("{Enter}");
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    // Every control is reachable and the primary action can be triggered.
    await userEvent.click(screen.getByRole("button", { name: /^schedule$/i }));
    expect(onSchedule).toHaveBeenCalled();
  });

  it("disables the primary action while a push is in flight", async () => {
    setup({ pending: true });
    const dialog = await open();
    expect(within(dialog).getByRole("button", { name: /^schedule$/i })).toBeDisabled();
  });
});
```

- [x] **Step 2: Run to verify they fail**

Run: `npx vitest run src/components/scheduling/schedule-menu.test.tsx`
Expected: FAIL — module not found.

- [x] **Step 3: Implement the component**

Create `src/components/scheduling/schedule-menu.tsx`. It is presentational: it owns only the draft intent, computes the summary on every change, and calls back. No server actions, no fetching.

Requirements the tests above pin down, so build to them:

- `Popover.Root` / `Popover.Trigger` / `Popover.Portal container={rootRef}` / `Popover.Positioner {...ANCHORED_POSITIONER}` / `Popover.Popup` with `aria-label={`Schedule ${taskTitle}`}`, mirroring `row-actions.tsx:250–283`.
- A native `<input type="date">` labelled **Done by**, valued `YYYY-MM-DD` in the scheduling timezone. Keep the time-of-day from the incoming intent when the date changes — the deadline's *hour* is not something the menu asks about, and silently moving it to midnight would shrink the last window.
- A `<select>` labelled **Priority** with the four `SchedulePriority` values, option labels `Critical / High / Normal / Low`.
- A radiogroup labelled **Hours** with `Work` / `Personal`. Both radios carry `touchTarget`.
- The summary from `scheduleSummary(deriveWindows(draft), draft.units.length, draft.dueAt)`, recomputed on each render, in an element with `role="status"` so a screen reader hears the warning appear. `aria-live` is deliberately **polite**, not assertive: it updates on every keystroke in the date field.
- `Cancel` closes without calling back. `Schedule` calls `onSchedule(draft)` and closes.
- When `showReclaimFields` is false, the priority and hours controls are **not rendered** — not disabled, not hidden with CSS. A control that provably has no effect on the active method should not be in the tab order.

- [x] **Step 4: Run to verify they pass**

Run: `npx vitest run src/components/scheduling/schedule-menu.test.tsx`
Expected: PASS, including the axe assertion.

- [x] **Step 5: Commit**

```bash
git add src/components/scheduling/schedule-menu.tsx src/components/scheduling/schedule-menu.test.tsx
git commit -m "feat(scheduling): the Schedule menu (#106)

Deadline, priority, work-or-personal, and a live summary that turns into a
warning when the deadline cannot hold the work - informing without blocking,
because a deliberate over-commit is the owner's call.

Presentational: it owns a draft intent and calls back, so it tests with RTL
alone and the Prisma access stays in the action. Priority and hours are not
rendered at all on the .ics-only path rather than disabled, because a control
with no effect should not be in the tab order.

Follows the existing popover idiom from row-actions.tsx (#92) rather than
inventing a second one - including the aria-label on the popup, since there
is no visible heading for aria-labelledby to point at.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: Accept and persist the intent in the action

**Files:**
- Modify: `src/app/actions/google-schedule.ts` (`pushStepsToGoogleTasks` signature and the marker update)
- Test: `src/app/actions/google-schedule.test.ts` (extend the file #104 created)

**Interfaces:**
- Changes: `pushStepsToGoogleTasks(taskId: string, intent?: ScheduleIntent): Promise<GoogleScheduleResult>` — the parameter is optional so #104's call sites keep working unchanged.

- [x] **Step 1: Write the failing tests**

Append to `src/app/actions/google-schedule.test.ts`:

```ts
import { SchedulePriority, ScheduleHours } from "@/lib/scheduling/types";
import type { ScheduleIntent } from "@/lib/scheduling/types";

/**
 * These assert on the `prisma.task.update` argument. If #104's test file mocks
 * Prisma at the module boundary (`vi.mock("@/lib/db")`), reuse that mock and
 * read `taskUpdate.mock.calls`. If it uses a real test database instead, replace
 * each `expect(taskUpdate…)` with a `prisma.task.findUnique` read-back — the
 * behaviours below are the contract either way and none may be skipped.
 */
describe("pushStepsToGoogleTasks — persisting what the owner chose (#106)", () => {
  const chosen: ScheduleIntent = {
    dueAt: new Date("2026-08-07T16:00:00.000Z"),
    priority: SchedulePriority.Critical,
    hours: ScheduleHours.Personal,
    busy: true,
    units: [],
  };

  it("writes the chosen deadline, priority and hours onto the task", async () => {
    await pushStepsToGoogleTasks("t1", chosen);
    const data = taskUpdate.mock.calls.at(-1)![0].data;
    expect(data).toMatchObject({
      scheduleDueAt: chosen.dueAt,
      schedulePriority: "critical",
      scheduleHours: "personal",
    });
  });

  it("leaves the three columns untouched when no intent is supplied", async () => {
    await pushStepsToGoogleTasks("t1");
    const data = taskUpdate.mock.calls.at(-1)![0].data;
    expect(data).not.toHaveProperty("schedulePriority");
    expect(data).not.toHaveProperty("scheduleHours");
    expect(data).not.toHaveProperty("scheduleDueAt");
  });

  it("ignores units supplied by the caller and uses the task's real steps", async () => {
    // A client could otherwise smuggle in steps that do not exist, or drop ones
    // that do, and we would push a schedule for work the task does not contain.
    await pushStepsToGoogleTasks("t1", {
      ...chosen,
      units: [{ id: "not_a_real_step", order: 1, total: 1, text: "injected", estMinutes: 30 }],
    });
    const pushedTitles = createOrPatchCalls().map((c) => c.title);
    expect(pushedTitles.some((t) => t.includes("injected"))).toBe(false);
    expect(pushedTitles).toHaveLength(2); // the task's two real steps
  });

  it("still awards the first-schedule reward exactly once", async () => {
    await pushStepsToGoogleTasks("t1", chosen);
    await pushStepsToGoogleTasks("t1", chosen);
    expect(awardFirstSchedule).toHaveBeenCalledTimes(1);
  });
});
```

`taskUpdate`, `createOrPatchCalls` and `awardFirstSchedule` are whatever #104's harness names them — read that file and reuse its mocks rather than adding a second set.

- [x] **Step 2: Run to verify they fail**

Run: `npx vitest run src/app/actions/google-schedule.test.ts`
Expected: FAIL on all three.

- [x] **Step 3: Implement**

In `src/app/actions/google-schedule.ts`:

```ts
export async function pushStepsToGoogleTasks(
  taskId: string,
  suppliedIntent?: ScheduleIntent,
): Promise<GoogleScheduleResult> {
```

Replace the `const intent = defaultIntentFor(units);` line from #104 with:

```ts
    // The menu (#106) supplies an intent; the bare 📅 path does not and gets
    // A's defaults. `units` always comes from the database rather than the
    // client, so a supplied intent cannot smuggle in steps that do not exist.
    const intent: ScheduleIntent = suppliedIntent
      ? { ...suppliedIntent, units }
      : defaultIntentFor(units);
```

Then extend the existing marker update so a menu push records what was chosen:

```ts
    if (task.scheduledAt == null || suppliedIntent) {
      await prisma.task.update({
        where: { id: task.id },
        data: {
          ...(task.scheduledAt == null
            ? { scheduledAt: new Date(), scheduledVia: SchedulingMethod.GoogleTasks }
            : {}),
          // Only written when the owner actually chose — a defaults-only push
          // must not overwrite what they picked last time.
          ...(suppliedIntent
            ? {
                scheduleDueAt: suppliedIntent.dueAt,
                schedulePriority: suppliedIntent.priority,
                scheduleHours: suppliedIntent.hours,
              }
            : {}),
        },
      });
      if (task.scheduledAt == null) {
        await awardFirstSchedule(workspaceId, task.scheduledAt != null);
      }
    }
```

Keep the reward call's existing argument and comment — its idempotency reasoning is unchanged, and it must still fire only on a first schedule.

- [x] **Step 4: Run the tests, then the whole suite**

Run: `npx vitest run src/app/actions/google-schedule.test.ts && npm test`
Expected: PASS, and #104's existing action tests still green.

- [x] **Step 5: Commit**

```bash
git add src/app/actions/google-schedule.ts src/app/actions/google-schedule.test.ts
git commit -m "feat(scheduling): accept and remember the owner's intent (#106)

The intent parameter is optional, so every call site A wrote keeps working
and the bare 📅 path still gets A's defaults. Units are always re-read from
the database rather than taken from the supplied intent, so a client cannot
smuggle in steps that do not exist.

The three schedule columns are written ONLY when an intent was actually
supplied: a defaults-only push must not quietly overwrite what the owner
picked last time, which is the whole point of persisting them.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: Wire the menu into the schedule control

**Files:**
- Modify: `src/components/inbox/row-actions.tsx` (the `state === "ready_steps"` branch, ~line 231)
- Modify: whichever parent passes `onScheduleSteps` — find it with `grep -rn "onScheduleSteps" src/`
- Test: `src/components/inbox/row-actions.test.tsx` (extend)

**Interfaces:** no new exports. `ScheduleControlProps` gains `scheduleIntent?: ScheduleIntent | null` and `onScheduleSteps` widens to `(intent?: ScheduleIntent) => void`.

- [x] **Step 1: Write the failing test**

Add to `src/components/inbox/row-actions.test.tsx`:

```tsx
it("opens the Schedule menu instead of firing immediately when steps are ready (#106)", async () => {
  const onScheduleSteps = vi.fn();
  render(
    <ScheduleControl
      /* …the props this file's existing tests already use for ready_steps… */
      state="ready_steps"
      scheduleIntent={someIntent}
      onScheduleSteps={onScheduleSteps}
    />,
  );
  await userEvent.click(screen.getByRole("button", { name: "Schedule" }));
  expect(screen.getByRole("dialog")).toBeInTheDocument();
  expect(onScheduleSteps).not.toHaveBeenCalled();

  await userEvent.click(screen.getByRole("button", { name: /^schedule$/i }));
  expect(onScheduleSteps).toHaveBeenCalledWith(expect.objectContaining({ priority: "high" }));
});

it("still fires the .ics path immediately — no menu, no regression for guests", async () => {
  const onScheduleIcs = vi.fn();
  render(<ScheduleControl /* …ics_ready_steps… */ onScheduleIcs={onScheduleIcs} />);
  await userEvent.click(screen.getByRole("button", { name: "Add to calendar (.ics)" }));
  expect(onScheduleIcs).toHaveBeenCalled();
  expect(screen.queryByRole("dialog")).toBeNull();
});
```

Read the file's existing `ready_steps` tests for the exact prop set before writing this — do not guess the props.

- [x] **Step 2: Run to verify it fails**

Run: `npx vitest run src/components/inbox/row-actions.test.tsx`
Expected: FAIL — no dialog appears; the click fires the callback directly.

- [x] **Step 3: Implement**

In `row-actions.tsx`, the `!needsDuration` branch currently fires `onScheduleSteps?.()` on click for `ready_steps`. Wrap that branch's button in `ScheduleMenu` when `scheduleIntent` is present, passing the 📅 button as `trigger` and `showReclaimFields={!isIcs}`. Leave the `ics_ready_steps` path calling `onScheduleIcs?.()` directly — a guest with no Reclaim has nothing to choose that the menu could offer beyond a deadline, and changing their one-click download into a two-step dialog is a regression.

When `scheduleIntent` is null (not yet loaded), keep today's immediate behaviour so the control is never dead.

- [x] **Step 4: Run the tests**

Run: `npx vitest run src/components/inbox/row-actions.test.tsx && npm test`
Expected: PASS.

- [x] **Step 5: Commit**

```bash
git add src/components/inbox/row-actions.tsx src/components/inbox/row-actions.test.tsx
git commit -m "feat(scheduling): 📅 opens the menu for the Google path (#106)

The .ics path deliberately keeps its one-click behaviour: a guest with no
Reclaim has nothing to choose beyond a deadline, and turning their download
into a two-step dialog would be a regression, not a feature.

When no intent has loaded yet the control keeps firing immediately, so it is
never dead while data is in flight.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: Verify it in a production build

**Files:**
- Create: `e2e/smoke/schedule-menu.spec.ts`

- [x] **Step 1: Make the Google path reachable in e2e**

#104's plan said the Google path was unreachable in e2e. That was true for *pushing*, and it is **not** true for *opening the menu* — which is the part worth verifying in a real build, because `"rolling 30 dayswindow"` was exactly this class of bug: text assembled from JSX that vitest and `next build` disagree about.

`googleTasksProvider.isAvailable` gates on `ctx.google.configured`, and `googleConfigured()` (`src/lib/google.ts:29`) reads **only** `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`. No token, no DB row. So two dummy env vars flip the control from `"Add to calendar (.ics)"` to `"Schedule"` and the menu opens.

In `playwright.config.ts`, add to `bootGuardEnv` alongside the existing GitLab dummies:

```ts
  // #106: makes the Google Tasks method *offered* so the Schedule menu can be
  // opened in e2e. Deliberately not a working credential — the spec opens the
  // menu and asserts its contents, and never presses Schedule, so no token is
  // needed and no request leaves the machine.
  GOOGLE_CLIENT_ID: "e2e-google-client-id",
  GOOGLE_CLIENT_SECRET: "e2e-google-client-secret",
```

Then confirm nothing else changes behaviour on that flag: run the full e2e suite before writing the new spec. If a pre-existing spec starts failing because the 📅 control's label changed, that spec was asserting the `.ics` label — decide per spec whether it should pin `.ics` explicitly or follow the new default, and say which in the MR.

- [x] **Step 2: Write the spec**

Create `e2e/smoke/schedule-menu.spec.ts`:

```ts
import { test, expect } from "@playwright/test";
import { captureItem, needsReviewRow } from "../helpers";

/**
 * The Schedule menu in a production build (#106). Opens it and reads it; never
 * presses Schedule, because the e2e Google credential is a dummy and no request
 * should leave the machine.
 */
test("the Schedule menu opens, reads correctly, and closes on Escape", async ({ page }) => {
  const label = `E2E menu ${Date.now()}`;
  await page.goto("/");
  await captureItem(page, label);

  const row = needsReviewRow(page, label);
  await row.getByRole("button", { name: "Schedule" }).click();

  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog).toHaveAccessibleName(/schedule/i);

  // The summary line, assembled from JSX — the exact bug class this guards.
  const status = dialog.getByRole("status");
  await expect(status).toContainText(/\d+ step/);
  await expect(status).not.toContainText("  "); // no collapsed-whitespace seams

  await expect(dialog.getByLabel(/done by/i)).toBeVisible();
  await expect(dialog.getByLabel(/priority/i)).toBeVisible();

  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
});
```

- [x] **Step 3: Run the full gate set**

```bash
npm test
npx tsc --noEmit
npm run lint
npm run format:check
npm run build && npm run test:e2e
```

Expected: all green. `.next/` validator errors from a stale build are pre-existing.

- [x] **Step 4: Screenshot the menu in both themes, at 390px and desktop**

Save to `/Users/gitlab_dlectronique/workdev/106-menu-shots/` and attach to #106. The owner reviews visual work by eye; a green suite is not the same evidence.

- [x] **Step 5: Commit and open the MR**

```bash
git add e2e/smoke/schedule-menu.spec.ts
git commit -m "test(scheduling): guard the menu in a production build (#106)

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
git push -u origin HEAD
```

MR: `--reviewer GitLabDuo --milestone v0.5.0 --assignee gitlab_dlectronique`, description containing `Closes #106`, ending with `🤖 Generated with [Claude Code](https://claude.com/claude-code)`. **Not** `--fill`.

## Final verification

- [x] `npm test` green, count up
- [x] `npx tsc --noEmit` clean under `src/`
- [x] `npm run lint`, `npm run format:check` clean
- [x] `npm run build && npm run test:e2e` green
- [x] Migration applied cleanly **and** `enum-constraint-sync.integration.test.ts` passes — that test fails loudly if the constraints and the registry disagree
- [ ] Screenshots attached to #106 — captured to `/Users/gitlab_dlectronique/workdev/106-menu-shots/` (and `test-results/schedule-menu/`); attaching is the controller's step
- [x] axe clean on the open popover (asserted in the component test, not just eyeballed)
- [ ] #106 status set to Done; MR open, not merged — the controller's step (this branch stops at green, unpushed)

## Spec-coverage map (self-review)

| Spec §6 requirement | Task |
|---|---|
| Popover on the existing control, repo's popover pattern | Task 4, Task 6 |
| Deadline + priority + work/personal | Task 4 |
| Defaults: 3 days, High, Work | Task 3 (via `defaultIntentFor`) |
| Live summary → feasibility warning, warns not blocks | Task 2, Task 4 |
| Prefilled on re-open | Tasks 1, 3, 4 |
| Fields only where they do something | Task 4, Task 6 |
| `.ics` keeps its placement and its one click | Task 6 |
| Three persisted columns + CHECK constraints | Task 1 |
| Keyboard, focus, axe, 44×44 | Task 4 |
| Production-build verification | Task 7 |

**Deliberately not here:** `Step.scheduleDueAt` and the per-step expander — those are #107. The `▸ Set per step` disclosure is **not** rendered by this plan; adding a disclosure that expands to nothing would be worse than not having it yet.

---

## Deviations from this plan, as built (#106)

The plan held up; four things in it did not survive contact with the repo, and one
piece of wiring it left open needed a decision. Recorded here because the next
reader of this file should not re-derive them.

1. **`vitest-axe` is not a dependency**, and "no new npm dependencies" is one of
   this plan's own constraints. The repo's actual convention is that mechanical
   axe scanning lives in Playwright (`e2e/a11y/axe-helpers.ts`, `@axe-core/playwright`)
   while component tests assert accessible names, labels, roles and touch targets
   directly. So Task 4's axe assertion became explicit a11y assertions in
   `schedule-menu.test.tsx` (dialog name, labelled controls, tab order, focus
   restoration, 44px targets) plus a REAL `scanA11y` of the open popover in
   `e2e/smoke/schedule-menu.spec.ts` — a real accessibility tree rather than
   jsdom's approximation, which is the stronger gate.

2. **There is no `src/app/actions/google-schedule.test.ts`.** #104 split it three
   ways; Task 5's tests went into `google-schedule.push.test.ts` and reuse its
   hoisted mocks (`taskUpdateMock`, `upsertGoogleTaskMock`, `logRewardMock`,
   `awardBadgeMock` — there is no `awardFirstSchedule` mock).

3. **Task 7 Step 1 was wrong about the two env vars being enough.**
   `scheduleState` (inbox-view.tsx) returns `"connect"` unless Google is
   configured AND connected, and `getGoogleStatus().connected` is
   `Boolean(auth.accessToken)` — a database fact, not an env one. Adding
   `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET` alone changes nothing observable
   (verified: 166 e2e tests passed identically before and after). The new spec
   therefore seeds and tears down the `GoogleAuth` token row itself, which also
   keeps the blast radius to one file instead of the whole suite via
   `global-setup.ts`.

   The plan's spec body was also unreachable as written: it captured a fresh
   brain-dump item, which has no steps and so gets the `needs_duration` duration
   popover, not this menu. Only a **Multi-step** row (triaged, >1 step) reaches
   `ready_steps`, so the spec seeds one.

4. **Two extra source files, both in service of Task 6.**
   * `src/lib/scheduling/intent.ts` gained `mergePersistedIntent` — the pure
     persisted-or-default merge. The plan had it inline in the `"use server"`
     action, but the inbox needs the same merge without a per-row round trip (see
     below), and two copies of "what does the menu open with?" would agree only
     today.
   * `src/lib/scheduling/hours.ts` gained `toZonedDateInput` /
     `fromZonedDateInput`. An `<input type="date">` speaks `YYYY-MM-DD`, both
     directions have to go through the scheduling zone, and changing the DAY must
     keep the deadline's hour. The two-pass DST-safe `zonedTime` those need is
     already private to that file; a second hand-rolled copy in a component is how
     the same DST bug gets written twice.

5. **Task 6's "whichever parent passes `onScheduleSteps`" is two parents, and
   both resolve the prefill on the SERVER** so the menu never flashes the defaults
   before the persisted values arrive:
   * `tasks/[taskId]/page.tsx` awaits `loadScheduleIntent(taskId)` in its existing
     `Promise.all` and passes it to `<TaskSchedule>`.
   * `(app)/page.tsx` builds one intent per multi-step row from the task rows it
     has **already fetched** — the three columns and the steps are in that payload
     already — and passes them to `<InboxView>` as `scheduleIntents`. The
     alternative was one server-action round trip per multi-step row on every
     inbox load.

6. **Deliberately not wired: the ▾ dropdown's "Schedule" mirror.** It keeps
   firing immediately, for the same reason its duration presets expand inline
   rather than in a popup (#92) — nesting a floating popup inside the 🔽 popup is
   the shape that plan was written to avoid. Reversible; noted rather than done.

7. **`prisma format` was NOT run.** It reformats the whole checked-in schema
   (108 insertions / 93 deletions of pure alignment churn), which re-fingerprints
   unrelated SAST findings. The new columns are aligned by hand to match their
   neighbours instead.
