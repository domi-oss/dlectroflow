# Schedule intent C — per-step overrides Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the owner pin an individual step's deadline and correct its duration, inside the Schedule menu, without breaking the ordering that the whole feature exists to guarantee.

**Architecture:** This is the smallest of the three sub-projects because A already built its engine: `ScheduleUnit.dueAt` exists, and `deriveWindows` already clamps a pinned deadline so it cannot come before the previous step's window. C adds one nullable column, one expander inside B's popover, and the validation that explains a pin it had to move.

**Tech Stack:** TypeScript, Next.js 16.2, Prisma + Postgres, `@base-ui/react/popover`, vitest 4.1 + jsdom/RTL, `vitest-axe`, Playwright.

**Spec:** [`docs/design/specs/2026-07-29-schedule-intent-design.md`](../specs/2026-07-29-schedule-intent-design.md) §7
**Issue:** #107. **Depends on #106** (the popover this expands inside) and therefore on #104.

## Global Constraints

- **No new npm dependencies.**
- **`AGENTS.md` applies:** Next.js 16.2, APIs differ from training data.
- **Duration edits go through the existing action.** `updateStepEstimate(stepId, minutes)` (`src/app/actions/focus.ts:246`) already scopes by workspace and clamps to `[1, 480]`. Call it; do **not** add a second writer for `Step.estMinutes` — there are already four and the `Step_estMinutes_check` migration comment is a warning about exactly that.
- **The ordering guarantee is not negotiable.** A pin may narrow the plan; it may never produce a non-monotonic sequence. `deriveWindows` enforces this already — C's job is to *tell the owner* when it did.
- **No second way to reorder.** Steps already drag-and-drop in the task (#26). Adding reordering here is how two sources of truth drift apart.
- **Accessibility:** the expander is a real disclosure (`aria-expanded`, labelled), every field is labelled, rows are reachable and operable by keyboard, 44×44 targets via `touchTarget`. axe clean with the expander **open** — B only asserted it closed.
- **Verify in a production build**, not only jsdom.
- **Commit trailer** on every commit: `Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>`
- Gates: `npm test`, `npx tsc --noEmit`, `npm run lint`, `npm run format:check`, `npm run build && npm run test:e2e`.

## File Structure

| File | Responsibility |
|---|---|
| `prisma/schema.prisma` **(modify)** | `Step.scheduleDueAt DateTime?` |
| `prisma/migrations/<ts>_step_schedule_due/migration.sql` **(create)** | One nullable column. No CHECK — it is a timestamp, not a pseudo-enum. |
| `src/lib/scheduling/pins.ts` **(create)** | Pure: compares requested pins against the derived plan and reports which ones had to move, and why. |
| `src/components/scheduling/step-overrides.tsx` **(create)** | The expander's rows. Presentational; edits a draft, calls back. |
| `src/components/scheduling/schedule-menu.tsx` **(modify)** | Renders the expander; threads per-unit `dueAt` into the draft intent. |
| `src/app/actions/schedule-intent.ts` **(modify)** | `loadScheduleIntent` reads `Step.scheduleDueAt` into `ScheduleUnit.dueAt`. |
| `src/app/actions/google-schedule.ts` **(modify)** | Persists per-step pins alongside the whole-task intent. |

---

### Task 1: Persist a per-step pin

**Files:**
- Modify: `prisma/schema.prisma` (`model Step`)
- Create: `prisma/migrations/<timestamp>_step_schedule_due/migration.sql`
- Modify: `src/app/actions/schedule-intent.ts`
- Test: `src/app/actions/schedule-intent.test.ts` (extend #106's file)

**Interfaces:**
- Produces: `Step.scheduleDueAt: DateTime?`, surfaced as `ScheduleUnit.dueAt`.

- [ ] **Step 1: Write the failing test**

Append to `src/app/actions/schedule-intent.test.ts`:

```ts
describe("loadScheduleIntent — per-step pins (#107)", () => {
  it("surfaces a persisted per-step deadline as the unit's dueAt", async () => {
    const pinned = new Date("2026-07-30T11:00:00.000Z");
    findFirst.mockResolvedValue({
      id: "t1",
      scheduleDueAt: null,
      schedulePriority: null,
      scheduleHours: null,
      steps: [
        { id: "s1", order: 1, text: "a", subtaskEmoji: null, estMinutes: 30, scheduleDueAt: null },
        { id: "s2", order: 2, text: "b", subtaskEmoji: null, estMinutes: 30, scheduleDueAt: pinned },
      ],
    });
    const intent = await loadScheduleIntent("t1");
    expect(intent!.units[0].dueAt).toBeNull();
    expect(intent!.units[1].dueAt!.toISOString()).toBe(pinned.toISOString());
  });

  it("selects scheduleDueAt in the step query — an unselected column is silently null", async () => {
    findFirst.mockResolvedValue(null);
    await loadScheduleIntent("t1");
    expect(findFirst.mock.calls[0][0].select.steps.select).toHaveProperty("scheduleDueAt", true);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/app/actions/schedule-intent.test.ts`
Expected: FAIL — `dueAt` is hardcoded `null` by #106's loader, and `scheduleDueAt` is not selected.

- [ ] **Step 3: Add the column**

In `prisma/schema.prisma`, inside `model Step`:

```prisma
  /// A per-step deadline the owner pinned in the Schedule menu (#107). Null means
  /// "derive it" — the window model spreads unpinned steps around the pinned ones.
  scheduleDueAt DateTime?
```

Create `prisma/migrations/<timestamp>_step_schedule_due/migration.sql`:

```sql
-- #107 — a per-step deadline the owner pinned in the Schedule menu.
--
-- Nullable, and NULL means "derive it": deriveWindows() spreads the unpinned
-- steps around the pinned ones. That is why there is no default and no CHECK
-- constraint here, unlike Task.schedulePriority (#106) — this is a timestamp
-- with no closed set of legal values, and its only real invariant (a pin must
-- not break the sequence) is enforced by the window model, which can see the
-- other steps. A CHECK constraint cannot see sibling rows.

ALTER TABLE "Step" ADD COLUMN "scheduleDueAt" TIMESTAMP(3);
```

- [ ] **Step 4: Read it in the loader**

In `src/app/actions/schedule-intent.ts`, add `scheduleDueAt: true` to the step `select`, and change the unit mapping's `dueAt: null` to `dueAt: s.scheduleDueAt`.

- [ ] **Step 5: Apply and run**

```bash
npx prisma migrate dev --name step_schedule_due
npx vitest run src/app/actions/schedule-intent.test.ts && npm test
```

Expected: PASS. `enum-constraint-sync.integration.test.ts` must still pass unchanged — this migration adds no managed constraint, so it needs no registry entry.

- [ ] **Step 6: Commit**

```bash
git add prisma/schema.prisma prisma/migrations src/app/actions/schedule-intent.ts src/app/actions/schedule-intent.test.ts
git commit -m "feat(db): persist a per-step schedule pin (#107)

One nullable column. NULL means derive it, which is what lets the window
model spread unpinned steps around the pinned ones.

No CHECK constraint, deliberately: unlike the #106 pseudo-enum columns this
is a timestamp with no closed set of legal values, and its real invariant -
a pin must not break the sequence - needs to see sibling rows, which a CHECK
cannot. deriveWindows enforces it instead.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Explain a pin that had to move

**Files:**
- Create: `src/lib/scheduling/pins.ts`
- Test: `src/lib/scheduling/pins.test.ts`

**Interfaces:**
- Consumes: `ScheduleIntent`, `deriveWindows`, `ScheduleWindow` (#104).
- Produces:
  ```ts
  export type PinConflict = {
    unitId: string;
    requested: Date;
    applied: Date;
    /** Human-readable, already voiced for the UI. */
    reason: string;
  };
  export function pinConflicts(intent: ScheduleIntent, now?: Date): PinConflict[];
  ```

A pin the owner sets may be impossible — "step 6 by Tuesday" when steps 1–5 need until Thursday. `deriveWindows` already clamps it silently, which is right for the *data* and wrong for the *person*: they asked for Tuesday and got Thursday with no explanation. This module diffs requested against applied and produces the sentence.

- [ ] **Step 1: Write the failing tests**

Create `src/lib/scheduling/pins.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { pinConflicts } from "./pins";
import { ScheduleHours, SchedulePriority } from "./types";
import type { ScheduleIntent } from "./types";

const bst = (iso: string) => new Date(`${iso}:00.000+01:00`);
const now = bst("2026-07-29T09:00");

function intent(units: ScheduleIntent["units"]): ScheduleIntent {
  return {
    dueAt: bst("2026-08-07T17:00"),
    priority: SchedulePriority.High,
    hours: ScheduleHours.Work,
    busy: true,
    units,
  };
}
const u = (order: number, estMinutes: number, dueAt: Date | null = null) => ({
  id: `s${order}`, order, total: 3, text: `step ${order}`, estMinutes, dueAt,
});

describe("pinConflicts", () => {
  it("reports nothing when no step is pinned", () => {
    expect(pinConflicts(intent([u(1, 30), u(2, 30), u(3, 30)]), now)).toEqual([]);
  });

  it("reports nothing when a pin is honoured exactly", () => {
    const reachable = bst("2026-08-04T15:00");
    expect(pinConflicts(intent([u(1, 30), u(2, 30, reachable), u(3, 30)]), now)).toEqual([]);
  });

  it("reports a pin that had to move later, with both dates", () => {
    // Step 2 pinned before step 1 could possibly finish.
    const impossible = bst("2026-07-29T09:05");
    const [conflict] = pinConflicts(
      intent([u(1, 240), u(2, 60, impossible), u(3, 30)]),
      now,
    );
    expect(conflict.unitId).toBe("s2");
    expect(conflict.requested.toISOString()).toBe(impossible.toISOString());
    expect(conflict.applied.getTime()).toBeGreaterThan(impossible.getTime());
  });

  it("explains WHY in terms of the step that comes before it", () => {
    const [conflict] = pinConflicts(
      intent([u(1, 240), u(2, 60, bst("2026-07-29T09:05")), u(3, 30)]),
      now,
    );
    expect(conflict.reason).toMatch(/step 1/i);
    expect(conflict.reason).toMatch(/moved to/i);
  });

  it("reports every conflicting pin, not just the first", () => {
    const conflicts = pinConflicts(
      intent([
        u(1, 240),
        u(2, 60, bst("2026-07-29T09:05")),
        u(3, 60, bst("2026-07-29T09:10")),
      ]),
      now,
    );
    expect(conflicts.map((c) => c.unitId)).toEqual(["s2", "s3"]);
  });

  it("tolerates a pin on the first step — there is nothing before it to conflict with", () => {
    const soon = bst("2026-07-29T09:30");
    expect(pinConflicts(intent([u(1, 15, soon), u(2, 30), u(3, 30)]), now)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run src/lib/scheduling/pins.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `src/lib/scheduling/pins.ts`:

```ts
/**
 * Why a pinned deadline moved (#107).
 *
 * `deriveWindows` already clamps an impossible pin so the sequence stays
 * monotonic — step 6 can never be scheduled before step 5. That is right for the
 * data and wrong for the person: they asked for Tuesday, got Thursday, and were
 * told nothing. This diffs what was requested against what was applied so the
 * menu can say so, in terms of the step that caused it.
 *
 * Pure, and deliberately separate from the window model: the clamp is a
 * correctness rule, this is an explanation, and mixing the two would put UI
 * wording inside the scheduling engine.
 */
import { deriveWindows } from "./windows";
import type { ScheduleIntent } from "./types";

export type PinConflict = {
  unitId: string;
  requested: Date;
  applied: Date;
  reason: string;
};

/** Pins within this tolerance of the applied date count as honoured. */
const TOLERANCE_MS = 60_000;

export function pinConflicts(
  intent: ScheduleIntent,
  now: Date = new Date(),
): PinConflict[] {
  const { windows } = deriveWindows(intent, now);
  const byId = new Map(windows.map((w) => [w.unitId, w]));
  const units = [...intent.units].sort((a, b) => a.order - b.order);

  const out: PinConflict[] = [];
  for (const unit of units) {
    if (!unit.dueAt) continue;
    const applied = byId.get(unit.id)?.due;
    if (!applied) continue;
    if (applied.getTime() - unit.dueAt.getTime() <= TOLERANCE_MS) continue;

    const previous = units.find((u) => u.order === unit.order - 1);
    const because = previous
      ? `step ${previous.order} has to finish first`
      : `there is not enough time before it`;
    out.push({
      unitId: unit.id,
      requested: unit.dueAt,
      applied,
      reason: `${because}, so this was moved to ${applied.toLocaleString("en-GB", { weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" })}`,
    });
  }
  return out;
}
```

- [ ] **Step 4: Run to verify they pass**

Run: `npx vitest run src/lib/scheduling/pins.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/scheduling/pins.ts src/lib/scheduling/pins.test.ts
git commit -m "feat(scheduling): explain a pin that had to move (#107)

deriveWindows already clamps an impossible pin so the sequence stays
monotonic. That is right for the data and silent for the person: they asked
for Tuesday, got Thursday, and were told nothing.

This diffs requested against applied and names the step that caused it. Kept
out of the window model on purpose - the clamp is a correctness rule, this is
an explanation, and merging them would put UI wording inside the engine.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: The expander

**Files:**
- Create: `src/components/scheduling/step-overrides.tsx`
- Test: `src/components/scheduling/step-overrides.test.tsx`

**Interfaces:**
- Produces:
  ```ts
  export type StepOverridesProps = {
    units: ScheduleUnit[];
    conflicts: PinConflict[];
    onChange: (units: ScheduleUnit[]) => void;
  };
  export function StepOverrides(props: StepOverridesProps): JSX.Element;
  ```

- [ ] **Step 1: Write the failing tests**

Create `src/components/scheduling/step-overrides.test.tsx`:

```tsx
import { describe, it, expect, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { axe } from "vitest-axe";
import { StepOverrides } from "./step-overrides";
import type { ScheduleUnit } from "@/lib/scheduling/types";

const units: ScheduleUnit[] = [
  { id: "s1", order: 1, total: 3, text: "Find the training", emoji: "🔗", estMinutes: 15, dueAt: null },
  { id: "s2", order: 2, total: 3, text: "Read the overview", emoji: "📖", estMinutes: 30, dueAt: null },
  { id: "s3", order: 3, total: 3, text: "Do the quiz", emoji: "✅", estMinutes: 45, dueAt: null },
];

function setup(over: Partial<React.ComponentProps<typeof StepOverrides>> = {}) {
  const onChange = vi.fn();
  const utils = render(<StepOverrides units={units} conflicts={[]} onChange={onChange} {...over} />);
  return { onChange, ...utils };
}

async function expand() {
  await userEvent.click(screen.getByRole("button", { name: /set per step/i }));
}

describe("StepOverrides", () => {
  it("is collapsed initially and says so to assistive tech", () => {
    setup();
    expect(screen.getByRole("button", { name: /set per step/i })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
    expect(screen.queryByLabelText(/duration for step 1/i)).toBeNull();
  });

  it("reveals one row per step when expanded", async () => {
    setup();
    await expand();
    expect(screen.getByRole("button", { name: /set per step/i })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
    for (const u of units) {
      expect(screen.getByText(new RegExp(u.text))).toBeInTheDocument();
    }
  });

  it("has no axe violations when expanded", async () => {
    const { container } = setup();
    await expand();
    expect(await axe(container)).toHaveNoViolations();
  });

  it("reports a duration change for the right step", async () => {
    const { onChange } = setup();
    await expand();
    const field = screen.getByLabelText(/duration for step 2/i);
    await userEvent.clear(field);
    await userEvent.type(field, "60");
    const last = onChange.mock.calls.at(-1)![0] as ScheduleUnit[];
    expect(last.find((u) => u.id === "s2")!.estMinutes).toBe(60);
    expect(last.find((u) => u.id === "s1")!.estMinutes).toBe(15);
  });

  it("clamps a duration to the range the server enforces", async () => {
    const { onChange } = setup();
    await expand();
    const field = screen.getByLabelText(/duration for step 1/i);
    await userEvent.clear(field);
    await userEvent.type(field, "9999");
    const last = onChange.mock.calls.at(-1)![0] as ScheduleUnit[];
    expect(last.find((u) => u.id === "s1")!.estMinutes).toBe(480);
  });

  it("reports a pinned deadline, and 'derived' clears it", async () => {
    const { onChange } = setup();
    await expand();
    const field = screen.getByLabelText(/deadline for step 3/i);
    await userEvent.type(field, "2026-08-05");
    expect(
      (onChange.mock.calls.at(-1)![0] as ScheduleUnit[]).find((u) => u.id === "s3")!.dueAt,
    ).toBeInstanceOf(Date);

    await userEvent.clear(field);
    expect(
      (onChange.mock.calls.at(-1)![0] as ScheduleUnit[]).find((u) => u.id === "s3")!.dueAt,
    ).toBeNull();
  });

  it("shows the reason next to a pin that had to move", async () => {
    setup({
      conflicts: [
        {
          unitId: "s2",
          requested: new Date("2026-07-29T09:05:00.000Z"),
          applied: new Date("2026-07-30T10:00:00.000Z"),
          reason: "step 1 has to finish first, so this was moved to Thu 30 Jul, 10:00",
        },
      ],
    });
    await expand();
    const row = screen.getByTestId("step-override-s2");
    expect(within(row).getByRole("alert")).toHaveTextContent(/step 1 has to finish first/);
  });

  it("offers no way to reorder steps — that lives in the task, not here", async () => {
    setup();
    await expand();
    expect(screen.queryByRole("button", { name: /move up|move down|reorder/i })).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run src/components/scheduling/step-overrides.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `src/components/scheduling/step-overrides.tsx`. Presentational: it renders rows from `units`, calls `onChange` with a **new** array on every edit, and holds only the expanded flag.

Requirements the tests pin down:

- A disclosure button labelled `Set per step` carrying `aria-expanded`, with the rows rendered only when open (not hidden with CSS — a collapsed row's fields must not be in the tab order).
- Each row: the step's position, its emoji and text, a numeric **duration** field labelled `Duration for step N` clamped to `[1, 480]` (the same range `updateStepEstimate` enforces server-side — clamping in both places means the UI never shows a value the server would silently change), and a `<input type="date">` labelled `Deadline for step N` whose empty value means *derived*.
- Each row carries `data-testid={`step-override-${unit.id}`}`.
- A matching `conflicts` entry renders inside its row with `role="alert"`, showing `reason`.
- No reordering affordance of any kind.

- [ ] **Step 4: Run to verify they pass**

Run: `npx vitest run src/components/scheduling/step-overrides.test.tsx`
Expected: PASS, axe included.

- [ ] **Step 5: Commit**

```bash
git add src/components/scheduling/step-overrides.tsx src/components/scheduling/step-overrides.test.tsx
git commit -m "feat(scheduling): per-step duration and deadline rows (#107)

An opt-in disclosure inside the existing menu - no second dialog, and the
collapsed rows are not rendered at all so their fields stay out of the tab
order.

Duration clamps to [1, 480] client-side, matching what updateStepEstimate
already enforces, so the UI never shows a number the server would silently
change. An empty deadline means derived. A pin that had to move explains
itself in its own row.

No reordering affordance: steps already drag-and-drop in the task (#26), and
two ways to express order is how they drift apart.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Thread it through the menu and persist it

**Files:**
- Modify: `src/components/scheduling/schedule-menu.tsx`
- Modify: `src/app/actions/google-schedule.ts`
- Test: `src/components/scheduling/schedule-menu.test.tsx`, `src/app/actions/google-schedule.test.ts`

- [ ] **Step 1: Write the failing tests**

Add to `src/components/scheduling/schedule-menu.test.tsx`:

```tsx
it("renders the per-step expander and threads its edits into the scheduled intent (#107)", async () => {
  const { onSchedule } = setup();
  const dialog = await open();
  await userEvent.click(within(dialog).getByRole("button", { name: /set per step/i }));

  const field = within(dialog).getByLabelText(/duration for step 2/i);
  await userEvent.clear(field);
  await userEvent.type(field, "90");
  await userEvent.click(within(dialog).getByRole("button", { name: /^schedule$/i }));

  const sent = onSchedule.mock.calls[0][0];
  expect(sent.units.find((u: { id: string }) => u.id === "s2").estMinutes).toBe(90);
});

it("recomputes the summary when a per-step duration changes", async () => {
  setup();
  const dialog = await open();
  const before = within(dialog).getByRole("status").textContent;
  await userEvent.click(within(dialog).getByRole("button", { name: /set per step/i }));
  const field = within(dialog).getByLabelText(/duration for step 1/i);
  await userEvent.clear(field);
  await userEvent.type(field, "120");
  expect(within(dialog).getByRole("status").textContent).not.toBe(before);
});
```

Add to `src/app/actions/google-schedule.test.ts`:

```ts
it("persists each pinned step deadline, and clears the ones set back to derived (#107)", async () => {
  const pinned = new Date("2026-08-05T15:00:00.000Z");
  await pushStepsToGoogleTasks("t1", {
    ...chosen,
    units: [
      { id: "s1", order: 1, total: 2, text: "a", estMinutes: 30, dueAt: pinned },
      { id: "s2", order: 2, total: 2, text: "b", estMinutes: 30, dueAt: null },
    ],
  });
  const writes = stepUpdate.mock.calls.map((c) => c[0]);
  expect(writes.find((w) => w.where.id === "s1").data.scheduleDueAt).toEqual(pinned);
  expect(writes.find((w) => w.where.id === "s2").data.scheduleDueAt).toBeNull();
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run src/components/scheduling/schedule-menu.test.tsx src/app/actions/google-schedule.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

In `schedule-menu.tsx`: render `<StepOverrides units={draft.units} conflicts={pinConflicts(draft)} onChange={(units) => setDraft({ ...draft, units })} />` below the summary, only when `draft.units.length > 1`. The summary already recomputes from `draft` on every render, so nothing extra is needed for the second test — verify that rather than adding a listener.

In `google-schedule.ts`: in the per-step loop, extend the existing `prisma.step.update` to write the pin alongside the Google ids:

```ts
        data: {
          googleTaskId: id,
          googleTaskListId: list.id,
          // #107: write the pin through on every push, including null, so a
          // step set back to "derived" actually forgets its old pin.
          scheduleDueAt: unit.dueAt ?? null,
        },
```

Duration edits are **not** persisted here — the menu calls `updateStepEstimate` when a duration field commits, so `Step.estMinutes` keeps its single writer path and the focus timer sees the same number.

- [ ] **Step 4: Run the tests, then everything**

Run: `npm test && npx tsc --noEmit`
Expected: PASS, clean.

- [ ] **Step 5: Commit**

```bash
git add src/components/scheduling/schedule-menu.tsx src/app/actions/google-schedule.ts src/components/scheduling/schedule-menu.test.tsx src/app/actions/google-schedule.test.ts
git commit -m "feat(scheduling): thread per-step overrides through the menu (#107)

The expander edits the same draft intent the summary reads, so changing a
step's duration updates the total and the feasibility warning with no extra
wiring - asserted rather than assumed.

Pins are written on every push including null, so a step set back to derived
actually forgets its old pin. Durations deliberately do not persist here:
they go through updateStepEstimate, keeping Step.estMinutes' existing writer
path and the focus timer on the same number.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: Verify, screenshot, ship

- [ ] **Step 1: Extend the e2e spec**

Add to `e2e/smoke/schedule-menu.spec.ts` (created by #106, which also added the dummy `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET` to `bootGuardEnv` that makes the menu reachable):

```ts
test("the per-step expander opens and its fields are usable", async ({ page }) => {
  // …open the menu as the #106 spec does…
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: /set per step/i }).click();
  await expect(dialog.getByLabel(/duration for step 1/i)).toBeVisible();
  // The collapsed state must not leave fields in the tab order.
  await dialog.getByRole("button", { name: /set per step/i }).click();
  await expect(dialog.getByLabel(/duration for step 1/i)).toBeHidden();
});
```

A single-step task shows no expander, so this needs a task with ≥2 steps. If `e2e/global-setup.ts` cannot seed one, assert the expander's absence for a single-step task instead and say so in the MR — an honest narrower test beats a skipped one.

- [ ] **Step 2: Run the full gate set**

```bash
npm test
npx tsc --noEmit
npm run lint
npm run format:check
npm run build && npm run test:e2e
```

- [ ] **Step 3: Screenshot the expander**

Both themes, 390px and desktop, expanded and collapsed, plus one with a conflict message visible. Save to `/Users/gitlab_dlectronique/workdev/107-per-step-shots/` and attach to #107. The 390px expanded case is the one to look at hardest — three fields per row in a popover is where a narrow viewport breaks.

- [ ] **Step 4: Push and open the MR**

`--reviewer GitLabDuo --milestone v0.5.0 --assignee gitlab_dlectronique`, description containing `Closes #107`, ending with `🤖 Generated with [Claude Code](https://claude.com/claude-code)`. **Not** `--fill`.

## Final verification

- [ ] `npm test` green, count up
- [ ] `npx tsc --noEmit` clean under `src/`
- [ ] `npm run lint`, `npm run format:check` clean
- [ ] `npm run build && npm run test:e2e` green
- [ ] Migration applied; `enum-constraint-sync.integration.test.ts` still green with **no** new registry entry (this migration adds no managed constraint)
- [ ] axe clean with the expander **open**
- [ ] Editing a duration here is reflected in the focus timer — proven by a test, not assumed
- [ ] Screenshots attached to #107, including 390px expanded
- [ ] #107 status Done; MR open, not merged

## Spec-coverage map (self-review)

| Spec §7 requirement | Task |
|---|---|
| Expander inside the same popover, no second dialog | Task 3 |
| Duration edits `Step.estMinutes` directly, one source of truth | Tasks 3, 4 |
| Deadline defaults to `derived`; setting one pins it | Tasks 1, 3 |
| Unpinned steps re-flow around a pin, monotonic | Already in `deriveWindows` (#104); asserted in Task 2 |
| An impossible pin is rejected inline **with the reason** | Tasks 2, 3 |
| No reordering here | Task 3 (asserted by absence) |
| `Step.scheduleDueAt` persisted | Tasks 1, 4 |
| Keyboard, axe, 390px | Tasks 3, 5 |
