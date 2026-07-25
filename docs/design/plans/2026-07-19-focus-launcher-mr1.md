# Focus Launcher Redesign — MR ① Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn `/focus` from a flat step-picker into a richer launcher — a dashboard meta line, a resume hero, and two labelled lanes (Single-task / Multi-step) using the exact inbox `SubHeader` + "see all →", with inline ✓ quick-complete and friendly empty / all-cleared states.

**Architecture:** Extend the existing pure `src/lib/focus-launcher.ts` into a richer, DB-free selector (`focusLauncherData`) that computes `{ resumeHero, singleTasks, multiStep, meta:{minutesToClear} }` so all selection/ordering is unit-tested without a database. The server page (`focus/page.tsx`) feeds it the workspace's tasks + the `singleTask` bucket from `libraryBuckets` + `getDashboardData`, and renders the read-only shell (`FocusLauncher`) plus a small client island (`focus-lanes.tsx`) for optimistic quick-complete. **Single-task focus reuses `ensureFocusStep` read-only — there are NO schema changes in MR ①, so it is independent of #38/!92 and #36/!94** (which touch `Settings`, CHECK constraints, and `googleSynced`; those belong to MRs ②/③, not here).

**Tech Stack:** Next.js (modified fork — see Global Constraints), React (Server Components + one `"use client"` island), Prisma/Postgres (read-only), TypeScript, Vitest + Testing Library (jsdom for component tests).

## Global Constraints

*(Cross-cutting rules copied verbatim from the spec + repo conventions. Every task's requirements implicitly include this section.)*

- **This is a modified Next.js fork.** Before writing any Next-specific code, read the relevant guide in `node_modules/next/dist/docs/`. Heed deprecation notices.
- **Voice-aware strings:** all user-facing text resolves via `t(key, voice)`. `t()` returns a **static** string — there is **no `{n}` interpolation**; compose numbers in JSX around static unit strings. Plain voice = no decorative emoji (functional glyphs only: status dots, ✅, ▶/⏸/✓, 🔥, 🗑️); the **emoji anchor is playful-voice only**.
- **Inbox-label reuse:** the two lanes use the **exact inbox `SubHeader`** (label + count pill + `link.seeAll` "see all →"), the existing labels `section.singleTask` / `section.multiStep`, and the existing `SEE_ALL` deep-link hrefs `/library?tab=plated` (single) and `/library?tab=sorted` (multi). Reuse them; do not fork new copies.
- **a11y — the 4-item sweep** (applies to every element this MR adds):
  1. **prefers-reduced-motion:** any transition/ambient motion (the hero progress bar) collapses to instant via `motion-safe:` / `motion-reduce:` utilities.
  2. **WCAG-AA contrast** in light **and** dark for all new text/badges/tiles (amber hero, streak, paused badge, "see all →", meta line).
  3. **≥44px** hit targets for every control (hero CTA, lane Start/Open/✓, see-all links).
  4. **Status not colour-only:** paused = `⏸` glyph + "paused" text; the ✓ quick-complete carries a text accessible name; the progress bar carries `role="progressbar"` + `aria-valuenow/min/max`, never colour alone.
- **Read-only / reuse `ensureFocusStep`:** the launcher never writes on load. Single-task ▶ Start reuses `ensureFocusStep(itemId)` (lazily creates the one-step task, returns a `stepId`) then routes; quick-complete reuses `completeItem` (single) / `completeStep` (multi). **No `prisma/schema.prisma`, `Settings`, or `constants.ts` changes in MR ①.**
- **Workspace isolation:** the page resolves `currentWorkspaceId()` and every query filters by it (IDOR-safe). Reused server actions are already workspace-scoped.
- **Per-worktree Postgres schema for gating:** vitest imports `@/lib/db` in some suites, so DB-touching runs use this worktree's own Postgres schema and are migrated with `prisma migrate deploy` (never `migrate dev`) before running. MR ① adds **no** integration/DB tests (no schema changes); its new suites are pure-node + RTL/jsdom.
- **Worktree deps:** seed a new worktree's `node_modules` with a `cp -Rc` CoW clone (not `npm ci`); **do not regenerate `package-lock.json` locally** (the local npm is allow-scripts-wrapped — lockfiles are regenerated only in the CI `node:22-alpine` image).
- **Branch / MR:** work in `feat/focus-page` → !86 (milestone v0.2.0). Add **@GitLabDuo as reviewer** (code MR). **Do NOT merge, do NOT push to main**; owner sign-off + GitLabDuo re-review gate the merge.
- **Gates before every push:** `npx tsc --noEmit` clean · `npm run lint` 0 new errors · `npm test` all green · `npx next build` compiles (`/focus` renders).
- **Run all commands from the worktree root:** `/Users/gitlab_dlectronique/workdev/dlectroflow/.claude/worktrees/focus-page`.

---

## File Structure

**Modify:**
- `src/lib/focus-launcher.ts` — enrich `FocusStep` (add `resumeAt`) + `FocusableStep` (add `resumeAt`, `stepIndex`, `stepsDone`, `stepsTotal`, `nextStepText`, `nextStepEmoji`); add the pure `focusLauncherData` selector + `SingleFocusable` / `LauncherData` types. **One responsibility:** pure launcher selection/ordering, no React/DOM/DB.
- `src/lib/focus-launcher.test.ts` — update the enriched-`focusableSteps` expectations; add `focusLauncherData` unit tests.
- `src/components/inbox/sub-header.tsx` — **(create)** the shared `SubHeader` + `SEE_ALL` hrefs, extracted verbatim from `inbox-view.tsx`. **One responsibility:** the label+count+see-all heading, reused by Inbox and the launcher.
- `src/components/inbox/inbox-view.tsx` — import `SubHeader` + `SEE_ALL` from the new module; delete the local copies (behaviour identical).
- `src/components/focus/focus-lanes.tsx` — **(create, `"use client"`)** `SingleTaskLane` + `MultiStepLane`: the interactive rows with ▶ Start/Open + inline ✓ optimistic quick-complete. **One responsibility:** launcher row interactivity.
- `src/components/focus/focus-lanes.test.tsx` — **(create)** RTL tests for Start/Open + quick-complete (mocked actions + router).
- `src/components/focus/focus-launcher.tsx` — becomes the read-only shell: ← Back, title, meta line, resume hero, both lanes (delegating rows to `focus-lanes`), empty + all-cleared states. **One responsibility:** launcher layout/presentation.
- `src/components/focus/focus-launcher.test.tsx` — rewrite RTL for the new shell (hero, lanes, inbox labels, see-all hrefs, both empty states, voice, a11y).
- `src/app/(app)/focus/page.tsx` — expanded query (tasks with session `startedAt` + single-task `BrainDumpItem`s via `libraryBuckets`) + `getDashboardData`; map to `focusLauncherData`; render the shell.
- `src/lib/strings.ts` — new voice-aware launcher keys.

**No files are created under `prisma/`, `src/lib/constants.ts`, or `src/app/(app)/settings/` — MR ① has no schema/settings surface.**

---

## Task 1: Enrich the pure `FocusStep` / `FocusableStep` types + `focusableSteps`

Add the progress + resume-recency fields the hero and lane rows need, keeping `focusableSteps` the single next-incomplete-step deriver.

**Files:**
- Modify: `src/lib/focus-launcher.ts:10-81`
- Test: `src/lib/focus-launcher.test.ts` (existing suite)

**Interfaces:**
- Consumes: nothing (leaf module).
- Produces:
  - `type FocusStep = { id: string; order: number; text: string; done: boolean; estMinutes: number; subtaskEmoji: string | null; resumable: boolean; resumeAt: number | null }`
  - `type FocusableStep = { stepId: string; stepText: string; subtaskEmoji: string | null; estMinutes: number; taskId: string; taskTitle: string; resumable: boolean; resumeAt: number | null; stepIndex: number; stepsDone: number; stepsTotal: number; nextStepText: string | null; nextStepEmoji: string | null }`
  - `function focusableSteps(tasks: FocusTask[]): FocusableStep[]`

- [ ] **Step 1: Update the existing test factory + the exact-shape assertion**

In `src/lib/focus-launcher.test.ts`, extend the `step` factory default with `resumeAt` and update the exact-object assertion to the enriched shape:

```ts
function step(overrides: Partial<FocusTask["steps"][number]> & { id: string }) {
  return {
    order: 1,
    text: overrides.id,
    done: false,
    estMinutes: 10,
    subtaskEmoji: null,
    resumable: false,
    resumeAt: null,
    ...overrides,
  };
}
```

Replace the `toEqual` block in the first test ("derives one entry …") with the enriched shape:

```ts
    const entries = focusableSteps(tasks);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toEqual({
      stepId: "s2",
      stepText: "Draft intro",
      subtaskEmoji: "✍️",
      estMinutes: 25,
      taskId: "t1",
      taskTitle: "Write report",
      resumable: false,
      resumeAt: null,
      stepIndex: 2,
      stepsDone: 1,
      stepsTotal: 3,
      nextStepText: "Later",
      nextStepEmoji: null,
    });
```

Add one new test for the ordering-by-`resumeAt` field being carried through (used by the hero in Task 2):

```ts
  it("carries resumeAt through from the next incomplete step", () => {
    const tasks = [
      task({
        id: "t1",
        steps: [
          step({ id: "s1", order: 1, done: true, resumable: true, resumeAt: 111 }),
          step({ id: "s2", order: 2, done: false, resumable: true, resumeAt: 222 }),
        ],
      }),
    ];
    expect(focusableSteps(tasks)[0]).toMatchObject({ stepId: "s2", resumable: true, resumeAt: 222 });
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- src/lib/focus-launcher.test.ts`
Expected: FAIL — object does not match (`stepIndex`/`stepsDone`/`stepsTotal`/`nextStepText`/`nextStepEmoji`/`resumeAt` missing).

- [ ] **Step 3: Enrich the types + `focusableSteps`**

In `src/lib/focus-launcher.ts`, add `resumeAt` to `FocusStep` (after `resumable`):

```ts
export type FocusStep = {
  id: string;
  order: number;
  text: string;
  done: boolean;
  estMinutes: number;
  subtaskEmoji: string | null;
  resumable: boolean;
  /** ms of the open FocusSession's startedAt; null when not resumable. Orders the resume hero. */
  resumeAt: number | null;
};
```

Extend `FocusableStep` (after `resumable`):

```ts
export type FocusableStep = {
  stepId: string;
  stepText: string;
  subtaskEmoji: string | null;
  estMinutes: number;
  taskId: string;
  taskTitle: string;
  resumable: boolean;
  /** Carried from the next incomplete step's open session; null when not paused. */
  resumeAt: number | null;
  /** 1-based position of this (next-incomplete) step among the task's ordered steps. */
  stepIndex: number;
  stepsDone: number;
  stepsTotal: number;
  /** The step AFTER this one (hero "next → …" peek); null when this is the last step. */
  nextStepText: string | null;
  nextStepEmoji: string | null;
};
```

Rewrite the `.map()` body of `focusableSteps` to compute the new fields from the sorted steps:

```ts
  const entries = tasks
    .map((task) => {
      const sorted = [...task.steps].sort((a, b) => a.order - b.order);
      const nextPos = sorted.findIndex((s) => !s.done);
      if (nextPos === -1) return null;
      const next = sorted[nextPos];
      const peek = sorted[nextPos + 1] ?? null;
      const entry: FocusableStep = {
        stepId: next.id,
        stepText: next.text,
        subtaskEmoji: next.subtaskEmoji,
        estMinutes: next.estMinutes,
        taskId: task.id,
        taskTitle: task.title,
        resumable: next.resumable,
        resumeAt: next.resumeAt,
        stepIndex: nextPos + 1,
        stepsDone: sorted.filter((s) => s.done).length,
        stepsTotal: sorted.length,
        nextStepText: peek ? peek.text : null,
        nextStepEmoji: peek ? peek.subtaskEmoji : null,
      };
      return { entry, createdAt: toMs(task.createdAt) };
    })
    .filter((e): e is { entry: FocusableStep; createdAt: number } => e !== null);
```

Leave the existing `entries.sort(...)` (resumable-first, then newest task) and `return entries.map((e) => e.entry)` unchanged.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- src/lib/focus-launcher.test.ts`
Expected: PASS (all `focusableSteps` cases, incl. the new `resumeAt` one).

- [ ] **Step 5: Commit**

```bash
git add src/lib/focus-launcher.ts src/lib/focus-launcher.test.ts
git commit -m "feat(#8): enrich FocusableStep with progress + resumeAt for the launcher redesign

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Pure `focusLauncherData` selector (hero + lanes + meta)

The DB-free heart of the launcher: from tasks + the single-task items, produce the hero, the two lane lists, and `minutesToClear`.

**Files:**
- Modify: `src/lib/focus-launcher.ts` (append after `focusableSteps`)
- Test: `src/lib/focus-launcher.test.ts` (add a new `describe`)

**Interfaces:**
- Consumes: `focusableSteps(tasks): FocusableStep[]` (Task 1).
- Produces:
  - `type SingleFocusable = { itemId: string; text: string; estMinutes: number }`
  - `type LauncherData = { resumeHero: FocusableStep | null; singleTasks: SingleFocusable[]; multiStep: FocusableStep[]; meta: { minutesToClear: number } }`
  - `function focusLauncherData(tasks: FocusTask[], singleTasks: SingleFocusable[]): LauncherData`

> **Decision (spec-faithful):** the hero is the most-recently-active paused step **among multi-step tasks** (`stepsTotal >= 2`). The spec only requires excluding the hero from the *multi-step* lane, and the hero UI ("step X of Y", progress bar, next-step peek) is multi-step-shaped. A paused single-task to-do still appears in the single lane and resumes via ▶ Start (`ensureFocusStep` returns the existing step). This keeps `SingleFocusable` free of step/session fields and needs no cross-lane de-dup.

- [ ] **Step 1: Write the failing tests**

Append to `src/lib/focus-launcher.test.ts`:

```ts
import { focusLauncherData, type SingleFocusable } from "@/lib/focus-launcher";

const single = (o: Partial<SingleFocusable> & { itemId: string }): SingleFocusable => ({
  text: o.itemId,
  estMinutes: 5,
  ...o,
});

describe("focusLauncherData", () => {
  it("passes single-task items straight through and keeps one-step tasks OUT of the multi-step lane", () => {
    const tasks = [
      task({ id: "single-task", steps: [step({ id: "st1" })] }), // one step → NOT multi
      task({ id: "multi", steps: [step({ id: "m1", done: true }), step({ id: "m2" })] }),
    ];
    const items = [single({ itemId: "i1", text: "Buy milk", estMinutes: 8 })];
    const data = focusLauncherData(tasks, items);
    expect(data.singleTasks).toEqual(items);
    expect(data.multiStep.map((e) => e.taskId)).toEqual(["multi"]);
  });

  it("picks the resume hero = the most-recently-active paused MULTI-step step (highest resumeAt)", () => {
    const tasks = [
      task({ id: "a", steps: [step({ id: "a1" }), step({ id: "a2", resumable: true, resumeAt: 100 })] }),
      task({ id: "b", steps: [step({ id: "b1" }), step({ id: "b2", resumable: true, resumeAt: 300 })] }),
      task({ id: "c", steps: [step({ id: "c1" }), step({ id: "c2", resumable: true, resumeAt: 200 })] }),
    ];
    const data = focusLauncherData(tasks, []);
    expect(data.resumeHero?.stepId).toBe("b2");
  });

  it("excludes the hero from the multi-step lane (no duplication)", () => {
    const tasks = [
      task({ id: "a", steps: [step({ id: "a1" }), step({ id: "a2", resumable: true, resumeAt: 100 })] }),
      task({ id: "b", steps: [step({ id: "b1" }), step({ id: "b2" })] }),
    ];
    const data = focusLauncherData(tasks, []);
    expect(data.resumeHero?.taskId).toBe("a");
    expect(data.multiStep.map((e) => e.taskId)).toEqual(["b"]);
  });

  it("has no hero when no multi-step step is paused", () => {
    const tasks = [task({ id: "b", steps: [step({ id: "b1" }), step({ id: "b2" })] })];
    expect(focusLauncherData(tasks, []).resumeHero).toBeNull();
  });

  it("computes minutesToClear = Σ next multi-step est + Σ single-task est (hero included)", () => {
    const tasks = [
      task({ id: "a", steps: [step({ id: "a1", done: true }), step({ id: "a2", estMinutes: 20, resumable: true, resumeAt: 5 })] }),
      task({ id: "b", steps: [step({ id: "b1", estMinutes: 15 }), step({ id: "b2" })] }),
    ];
    const items = [single({ itemId: "i1", estMinutes: 8 }), single({ itemId: "i2", estMinutes: 12 })];
    // 20 (hero a2) + 15 (b1) + 8 + 12 = 55
    expect(focusLauncherData(tasks, items).meta.minutesToClear).toBe(55);
  });

  it("returns empty lanes + null hero + 0 minutes for the empty/all-cleared case", () => {
    expect(focusLauncherData([], [])).toEqual({
      resumeHero: null,
      singleTasks: [],
      multiStep: [],
      meta: { minutesToClear: 0 },
    });
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- src/lib/focus-launcher.test.ts`
Expected: FAIL — `focusLauncherData` / `SingleFocusable` not exported.

- [ ] **Step 3: Implement `focusLauncherData`**

Append to `src/lib/focus-launcher.ts`:

```ts
/** A single-task to-do row on the launcher — a BrainDumpItem, focus-launched via
 * ensureFocusStep(itemId). No step/session fields: the resume hero is drawn from
 * multi-step tasks only (see plan Task 2 decision). */
export type SingleFocusable = {
  itemId: string;
  text: string;
  estMinutes: number;
};

/** Everything the /focus launcher renders, derived purely (no React/DB). */
export type LauncherData = {
  /** Most-recently-active paused multi-step step, or null. */
  resumeHero: FocusableStep | null;
  singleTasks: SingleFocusable[];
  /** Multi-step next steps, hero excluded, resumable-first then newest task. */
  multiStep: FocusableStep[];
  meta: { minutesToClear: number };
};

/**
 * Derive the launcher view-model from the workspace's tasks + its single-task
 * to-dos (already bucketed by the caller). Multi-step lane = next incomplete
 * step of every 2+-step task; the resume hero is the most-recently-active paused
 * one of those, removed from the lane. minutesToClear is a rough "clear
 * everything" figure: Σ of each multi-step next step's estimate (hero included)
 * + Σ of the single-task estimates.
 */
export function focusLauncherData(
  tasks: FocusTask[],
  singleTasks: SingleFocusable[],
): LauncherData {
  const multiFull = focusableSteps(tasks).filter((e) => e.stepsTotal >= 2);

  const resumeHero =
    [...multiFull]
      .filter((e) => e.resumable)
      .sort((a, b) => (b.resumeAt ?? 0) - (a.resumeAt ?? 0))[0] ?? null;

  const multiStep = resumeHero
    ? multiFull.filter((e) => e.stepId !== resumeHero.stepId)
    : multiFull;

  const minutesToClear =
    multiFull.reduce((n, e) => n + e.estMinutes, 0) +
    singleTasks.reduce((n, s) => n + s.estMinutes, 0);

  return { resumeHero, singleTasks, multiStep, meta: { minutesToClear } };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -- src/lib/focus-launcher.test.ts`
Expected: PASS (all `focusableSteps` + all `focusLauncherData` cases).

- [ ] **Step 5: Commit**

```bash
git add src/lib/focus-launcher.ts src/lib/focus-launcher.test.ts
git commit -m "feat(#8): pure focusLauncherData selector (hero + lanes + minutesToClear)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: New voice-aware launcher strings

Add every new key the shell + hero + meta line need; reuse existing keys everywhere possible (`section.singleTask`, `section.multiStep`, `link.seeAll`, `action.back`, `nav.inbox`, `nav.focusTimer`, `action.complete`, `focus.paused`, `step.counter`).

**Files:**
- Modify: `src/lib/strings.ts` (in the "Focus launcher" block, ~line 128-135)

**Interfaces:**
- Consumes: `t(key, voice)`.
- Produces (new `StringKey`s): `focus.meta.focusedToday`, `focus.meta.dayStreak`, `focus.meta.toClear`, `focus.hero.left`, `focus.hero.next`, `focus.hero.resume`, `focus.lane.start`, `focus.lane.open`, `focus.launcher.allClear`.

- [ ] **Step 1: Write the failing test**

Create `src/lib/strings.launcher.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { t } from "@/lib/strings";

describe("launcher strings", () => {
  it("meta-line units resolve in both voices", () => {
    expect(t("focus.meta.focusedToday", "plain")).toBe("focused today");
    expect(t("focus.meta.dayStreak", "plain")).toBe("-day streak");
    expect(t("focus.meta.toClear", "plain")).toBe("to clear");
  });

  it("hero + lane CTAs resolve, plain voice stays emoji-free of decoration", () => {
    expect(t("focus.hero.resume", "plain")).toBe("▶ Resume focus");
    expect(t("focus.hero.resume", "playful")).toBe("▶ Resume focusing");
    expect(t("focus.hero.left", "plain")).toBe("left");
    expect(t("focus.hero.next", "plain")).toBe("next →");
    expect(t("focus.lane.start", "plain")).toBe("▶ Start");
    expect(t("focus.lane.open", "plain")).toBe("▶ Open");
  });

  it("all-cleared copy differs by voice", () => {
    expect(t("focus.launcher.allClear", "plain")).not.toBe(
      t("focus.launcher.allClear", "playful"),
    );
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- src/lib/strings.launcher.test.ts`
Expected: FAIL — TypeScript/lookup error: keys not in `STRINGS`.

- [ ] **Step 3: Add the keys**

In `src/lib/strings.ts`, inside the "Focus launcher" block (right after `"focus.paused": …`), add:

```ts
  // ── Focus launcher redesign (MR ①) — meta line, resume hero, lanes ──────────
  // 🔥 / ▶ / ✓ / ⏸ are functional glyphs (allowed in plain). Numbers are
  // composed in JSX around these static units (t() has no interpolation).
  "focus.meta.focusedToday": { plain: "focused today", playful: "focused today" },
  "focus.meta.dayStreak":    { plain: "-day streak",   playful: "-day streak" },
  "focus.meta.toClear":      { plain: "to clear",      playful: "to clear" },
  "focus.hero.left":         { plain: "left",          playful: "left" },
  "focus.hero.next":         { plain: "next →",        playful: "next →" },
  "focus.hero.resume":       { plain: "▶ Resume focus", playful: "▶ Resume focusing" },
  "focus.lane.start":        { plain: "▶ Start",       playful: "▶ Start" },
  "focus.lane.open":         { plain: "▶ Open",        playful: "▶ Open" },
  "focus.launcher.allClear": {
    plain: "All caught up — nothing left to focus right now. ✅",
    playful: "🎉 Plates cleared! Nothing left to focus right now.",
  },
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- src/lib/strings.launcher.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/strings.ts src/lib/strings.launcher.test.ts
git commit -m "feat(#8): voice-aware strings for the /focus launcher redesign

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: Extract the shared inbox `SubHeader` + `SEE_ALL`

Reuse the *exact* inbox heading in the launcher without duplicating it: lift `SubHeader` + `SEE_ALL` into their own module and re-import them in `inbox-view.tsx` (zero behaviour change).

**Files:**
- Create: `src/components/inbox/sub-header.tsx`
- Modify: `src/components/inbox/inbox-view.tsx:77-81` (delete local `SEE_ALL`), `:1392-1418` (delete local `SubHeader`), imports block (~`:49-55`)
- Test: `src/components/inbox/sub-header.test.tsx`

**Interfaces:**
- Consumes: `t(key, voice)`, `type Voice`.
- Produces:
  - `function SubHeader({ label, count, seeAllHref, voice }: { label: string; count: number; seeAllHref: string; voice: Voice }): JSX.Element`
  - `const SEE_ALL: { singleTask: "/library?tab=plated"; multiStep: "/library?tab=sorted"; savedLater: "/library?tab=pantry" }`

- [ ] **Step 1: Write the failing test**

Create `src/components/inbox/sub-header.test.tsx`:

```tsx
// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup, within } from "@testing-library/react";
import { SubHeader, SEE_ALL } from "@/components/inbox/sub-header";

afterEach(cleanup);

describe("SubHeader", () => {
  it("renders label, count pill, and a see-all link to the given href", () => {
    render(<SubHeader label="Single-task to-dos" count={3} seeAllHref={SEE_ALL.singleTask} voice="plain" />);
    expect(screen.getByText("Single-task to-dos")).toBeInTheDocument();
    expect(screen.getByText("3")).toBeInTheDocument();
    const link = screen.getByRole("link", { name: /see all/i });
    expect(link).toHaveAttribute("href", "/library?tab=plated");
  });

  it("exposes the canonical deep-link hrefs", () => {
    expect(SEE_ALL.singleTask).toBe("/library?tab=plated");
    expect(SEE_ALL.multiStep).toBe("/library?tab=sorted");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- src/components/inbox/sub-header.test.tsx`
Expected: FAIL — cannot find module `@/components/inbox/sub-header`.

- [ ] **Step 3: Create the shared module (verbatim from inbox-view)**

Create `src/components/inbox/sub-header.tsx`:

```tsx
import { t } from "@/lib/strings";
import type { Voice } from "@/lib/strings";

// Deep-link targets for each section's "see all →" link (Library).
export const SEE_ALL = {
  singleTask: "/library?tab=plated",
  multiStep: "/library?tab=sorted",
  savedLater: "/library?tab=pantry",
} as const;

/** Sub-bucket heading: label + count badge + a "see all →" deep-link. */
export function SubHeader({
  label,
  count,
  seeAllHref,
  voice,
}: {
  label: string;
  count: number;
  seeAllHref: string;
  voice: Voice;
}) {
  return (
    <div className="mb-2 flex items-center gap-2 text-sm font-semibold">
      <span>{label}</span>
      <span className="bg-secondary text-secondary-foreground rounded-full px-2 py-0.5 text-xs">
        {count}
      </span>
      <a
        href={seeAllHref}
        className="text-muted-foreground hover:text-foreground ml-auto text-xs font-normal"
      >
        {t("link.seeAll", voice)}
      </a>
    </div>
  );
}
```

- [ ] **Step 4: Point `inbox-view.tsx` at the shared module**

In `src/components/inbox/inbox-view.tsx`:
1. Add to the import block near the top: `import { SubHeader, SEE_ALL } from "@/components/inbox/sub-header";`
2. **Delete** the local `const SEE_ALL = { … } as const;` (lines ~77-81).
3. **Delete** the local `function SubHeader({ … }) { … }` (lines ~1392-1418).

Leave every `<SubHeader … />` call site and `SEE_ALL.*` reference unchanged.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm test -- src/components/inbox/sub-header.test.tsx`
Expected: PASS.
Run: `npx tsc --noEmit`
Expected: clean (no duplicate/undefined `SubHeader`/`SEE_ALL` in `inbox-view.tsx`).

- [ ] **Step 6: Commit**

```bash
git add src/components/inbox/sub-header.tsx src/components/inbox/sub-header.test.tsx src/components/inbox/inbox-view.tsx
git commit -m "refactor(#8): extract shared inbox SubHeader + SEE_ALL for launcher reuse

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: Interactive lanes (`focus-lanes.tsx`) — Start/Open + optimistic ✓

The one `"use client"` island: rows that launch the timer and quick-complete optimistically, reusing the existing workspace-scoped server actions.

**Files:**
- Create: `src/components/focus/focus-lanes.tsx`
- Test: `src/components/focus/focus-lanes.test.tsx`

**Interfaces:**
- Consumes: `ensureFocusStep(id): Promise<string|null>` + `completeItem(id)` from `@/app/actions/braindump`; `completeStep(stepId)` from `@/app/actions/focus`; `useRouter().push/refresh`; `SingleFocusable` / `FocusableStep` (Tasks 1–2); `t`, `Voice`.
- Produces:
  - `function SingleTaskLane({ items, voice }: { items: SingleFocusable[]; voice: Voice }): JSX.Element`
  - `function MultiStepLane({ items, voice }: { items: FocusableStep[]; voice: Voice }): JSX.Element`

- [ ] **Step 1: Write the failing tests**

Create `src/components/focus/focus-lanes.test.tsx`:

```tsx
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SingleTaskLane, MultiStepLane } from "@/components/focus/focus-lanes";
import type { FocusableStep } from "@/lib/focus-launcher";

const push = vi.fn();
const refresh = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ push, refresh }) }));

vi.mock("@/app/actions/braindump", () => ({
  ensureFocusStep: vi.fn().mockResolvedValue("step-77"),
  completeItem: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/app/actions/focus", () => ({
  completeStep: vi.fn().mockResolvedValue(undefined),
}));

import { ensureFocusStep, completeItem } from "@/app/actions/braindump";
import { completeStep } from "@/app/actions/focus";

const multi = (o: Partial<FocusableStep> & { stepId: string }): FocusableStep => ({
  stepText: o.stepId,
  subtaskEmoji: null,
  estMinutes: 15,
  taskId: "task-" + o.stepId,
  taskTitle: "Task " + o.stepId,
  resumable: false,
  resumeAt: null,
  stepIndex: 1,
  stepsDone: 0,
  stepsTotal: 2,
  nextStepText: null,
  nextStepEmoji: null,
  ...o,
});

beforeEach(() => vi.clearAllMocks());
afterEach(cleanup);

describe("SingleTaskLane", () => {
  it("▶ Start ensures the focus step then routes to the timer", async () => {
    const user = userEvent.setup();
    render(<SingleTaskLane voice="plain" items={[{ itemId: "i1", text: "Buy milk", estMinutes: 8 }]} />);
    await user.click(screen.getByRole("button", { name: /start/i }));
    expect(ensureFocusStep).toHaveBeenCalledWith("i1");
    expect(push).toHaveBeenCalledWith("/focus/step-77");
  });

  it("inline ✓ optimistically removes the row, completeItem + refresh", async () => {
    const user = userEvent.setup();
    render(<SingleTaskLane voice="plain" items={[{ itemId: "i1", text: "Buy milk", estMinutes: 8 }]} />);
    await user.click(screen.getByRole("button", { name: /complete/i }));
    expect(screen.queryByText("Buy milk")).not.toBeInTheDocument(); // optimistic
    expect(completeItem).toHaveBeenCalledWith("i1");
    expect(refresh).toHaveBeenCalled();
  });
});

describe("MultiStepLane", () => {
  it("row links task title + step text + k/n progress + estimate", () => {
    render(
      <MultiStepLane
        voice="plain"
        items={[multi({ stepId: "m1", stepText: "Draft intro", taskTitle: "Report", stepsDone: 1, stepsTotal: 3, estMinutes: 20 })]}
      />,
    );
    expect(screen.getByText("Report")).toBeInTheDocument();
    expect(screen.getByText(/Draft intro/)).toBeInTheDocument();
    expect(screen.getByText(/1\/3/)).toBeInTheDocument();
    expect(screen.getByText(/20m/)).toBeInTheDocument();
  });

  it("▶ Open routes straight to the timer (no ensureFocusStep)", async () => {
    const user = userEvent.setup();
    render(<MultiStepLane voice="plain" items={[multi({ stepId: "m1" })]} />);
    await user.click(screen.getByRole("button", { name: /open/i }));
    expect(push).toHaveBeenCalledWith("/focus/m1");
    expect(ensureFocusStep).not.toHaveBeenCalled();
  });

  it("inline ✓ completes the shown next step (completeStep) + refresh, optimistic remove", async () => {
    const user = userEvent.setup();
    render(<MultiStepLane voice="plain" items={[multi({ stepId: "m1", stepText: "Draft intro" })]} />);
    await user.click(screen.getByRole("button", { name: /complete/i }));
    expect(screen.queryByText(/Draft intro/)).not.toBeInTheDocument();
    expect(completeStep).toHaveBeenCalledWith("m1");
    expect(refresh).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- src/components/focus/focus-lanes.test.tsx`
Expected: FAIL — cannot find module `@/components/focus/focus-lanes`.

- [ ] **Step 3: Implement the lanes**

Create `src/components/focus/focus-lanes.tsx`:

```tsx
"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { cn } from "@/lib/utils";
import { ensureFocusStep, completeItem } from "@/app/actions/braindump";
import { completeStep } from "@/app/actions/focus";
import { t, type Voice } from "@/lib/strings";
import type { SingleFocusable, FocusableStep } from "@/lib/focus-launcher";

/** ≥44px inline ✓ quick-complete — glyph + text accessible name (a11y: status
 * not colour-only). */
function QuickComplete({ voice, onClick }: { voice: Voice; onClick: () => void }) {
  return (
    <button
      type="button"
      aria-label={t("action.complete", voice)}
      title={t("action.complete", voice)}
      onClick={onClick}
      className="hover:bg-accent inline-flex min-h-[44px] min-w-[44px] shrink-0 items-center justify-center rounded-md border"
    >
      ✓
    </button>
  );
}

/** Single-task to-dos lane: ▶ Start (ensureFocusStep → route) + optimistic ✓. */
export function SingleTaskLane({ items, voice }: { items: SingleFocusable[]; voice: Voice }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [done, setDone] = useState<Set<string>>(new Set());
  const visible = items.filter((i) => !done.has(i.itemId));

  const start = (itemId: string) =>
    startTransition(async () => {
      const stepId = await ensureFocusStep(itemId);
      if (stepId) router.push(`/focus/${stepId}`);
    });

  const complete = (itemId: string) => {
    setDone((prev) => new Set(prev).add(itemId)); // optimistic: row leaves the lane
    startTransition(async () => {
      await completeItem(itemId);
      router.refresh();
    });
  };

  return (
    <ul className={cn("space-y-2", pending && "opacity-70")}>
      {visible.map((s) => (
        <li key={s.itemId} className="flex items-center gap-2 rounded-lg border px-3 py-2.5 text-sm">
          <span className="min-w-0 flex-1 break-words">{s.text}</span>
          <span className="text-muted-foreground shrink-0 text-xs tabular-nums">{s.estMinutes}m</span>
          <button
            type="button"
            onClick={() => start(s.itemId)}
            className="bg-primary text-primary-foreground inline-flex min-h-[44px] shrink-0 items-center rounded-md px-3 font-medium hover:opacity-90"
          >
            {t("focus.lane.start", voice)}
          </button>
          <QuickComplete voice={voice} onClick={() => complete(s.itemId)} />
        </li>
      ))}
    </ul>
  );
}

/** Multi-step to-dos lane: ▶ Open (route straight to the shown step) + optimistic
 * ✓ that completes that step (completeStep). */
export function MultiStepLane({ items, voice }: { items: FocusableStep[]; voice: Voice }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [done, setDone] = useState<Set<string>>(new Set());
  const visible = items.filter((e) => !done.has(e.stepId));

  const complete = (stepId: string) => {
    setDone((prev) => new Set(prev).add(stepId)); // optimistic
    startTransition(async () => {
      await completeStep(stepId);
      router.refresh();
    });
  };

  return (
    <ul className={cn("space-y-2", pending && "opacity-70")}>
      {visible.map((e) => (
        <li key={e.stepId} className="flex flex-col gap-1 rounded-lg border px-3 py-2.5 text-sm">
          <span className="text-muted-foreground text-xs">{e.taskTitle}</span>
          <div className="flex items-center gap-2">
            <span className="min-w-0 flex-1 break-words font-medium">
              {e.subtaskEmoji ? `${e.subtaskEmoji} ` : ""}
              {e.stepText}
            </span>
            <span className="text-muted-foreground shrink-0 text-xs tabular-nums">
              {e.stepsDone}/{e.stepsTotal}
            </span>
            <span className="text-muted-foreground shrink-0 text-xs tabular-nums">{e.estMinutes}m</span>
            <button
              type="button"
              onClick={() => router.push(`/focus/${e.stepId}`)}
              className="bg-primary text-primary-foreground inline-flex min-h-[44px] shrink-0 items-center rounded-md px-3 font-medium hover:opacity-90"
            >
              {t("focus.lane.open", voice)}
            </button>
            <QuickComplete voice={voice} onClick={() => complete(e.stepId)} />
          </div>
        </li>
      ))}
    </ul>
  );
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -- src/components/focus/focus-lanes.test.tsx`
Expected: PASS (all 5 cases).

- [ ] **Step 5: Commit**

```bash
git add src/components/focus/focus-lanes.tsx src/components/focus/focus-lanes.test.tsx
git commit -m "feat(#8): interactive /focus lanes — Start/Open + optimistic quick-complete

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: Rewrite the `FocusLauncher` shell (back, title, meta, hero, lanes, empties)

Replace the flat list with the full launcher layout. The shell is read-only presentational (Server-Component-safe) and delegates row interactivity to the Task 5 lanes.

**Files:**
- Modify: `src/components/focus/focus-launcher.tsx` (full rewrite)
- Test: `src/components/focus/focus-launcher.test.tsx` (full rewrite)

**Interfaces:**
- Consumes: `LauncherData`, `FocusableStep`, `SingleFocusable` (Tasks 1–2); `SingleTaskLane`, `MultiStepLane` (Task 5); `SubHeader`, `SEE_ALL` (Task 4); `t`, `Voice`; `next/link`.
- Produces:
  - `function FocusLauncher({ data, focusMinToday, currentStreak, clearedToday, voice }: { data: LauncherData; focusMinToday: number; currentStreak: number; clearedToday: boolean; voice: Voice }): JSX.Element`

> `clearedToday` distinguishes the two empty states: `true` (the user did work today, now nothing focusable) → inbox-zero-tone all-clear moment; `false` (brand-new, nothing ever) → friendly Inbox card. The page derives it from `stepsDoneToday > 0` (Task 7).

- [ ] **Step 1: Write the failing tests**

Replace `src/components/focus/focus-launcher.test.tsx` with:

```tsx
// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, within } from "@testing-library/react";
import { FocusLauncher } from "@/components/focus/focus-launcher";
import type { LauncherData, FocusableStep } from "@/lib/focus-launcher";

vi.mock("next/link", () => ({
  default: ({ children, href }: { children: React.ReactNode; href: string }) => (
    <a href={href}>{children}</a>
  ),
}));
// Render the lanes as light stand-ins — their interactivity is covered by
// focus-lanes.test.tsx; here we assert the shell's own structure.
vi.mock("@/components/focus/focus-lanes", () => ({
  SingleTaskLane: ({ items }: { items: { itemId: string; text: string }[] }) => (
    <ul data-testid="single-lane">{items.map((i) => <li key={i.itemId}>{i.text}</li>)}</ul>
  ),
  MultiStepLane: ({ items }: { items: FocusableStep[] }) => (
    <ul data-testid="multi-lane">{items.map((e) => <li key={e.stepId}>{e.stepText}</li>)}</ul>
  ),
}));

const hero = (o: Partial<FocusableStep> & { stepId: string }): FocusableStep => ({
  stepText: o.stepId,
  subtaskEmoji: null,
  estMinutes: 12,
  taskId: "task-" + o.stepId,
  taskTitle: "Task " + o.stepId,
  resumable: true,
  resumeAt: 1,
  stepIndex: 2,
  stepsDone: 1,
  stepsTotal: 4,
  nextStepText: null,
  nextStepEmoji: null,
  ...o,
});

const data = (over: Partial<LauncherData> = {}): LauncherData => ({
  resumeHero: null,
  singleTasks: [],
  multiStep: [],
  meta: { minutesToClear: 0 },
  ...over,
});

afterEach(cleanup);

describe("FocusLauncher shell", () => {
  it("renders ← Back to /inbox, the title, and a meta line linking to /dashboard", () => {
    render(
      <FocusLauncher
        voice="plain"
        focusMinToday={30}
        currentStreak={4}
        clearedToday={false}
        data={data({ singleTasks: [{ itemId: "i1", text: "Buy milk", estMinutes: 8 }], meta: { minutesToClear: 42 } })}
      />,
    );
    expect(screen.getByRole("link", { name: /back/i })).toHaveAttribute("href", "/inbox");
    expect(screen.getByRole("heading", { name: /focus timer/i })).toBeInTheDocument();
    const meta = screen.getByRole("link", { name: /focused today/i });
    expect(meta).toHaveAttribute("href", "/dashboard");
    expect(within(meta).getByText(/30m/)).toBeInTheDocument();
    expect(within(meta).getByText(/4/)).toBeInTheDocument();
    expect(within(meta).getByText(/42m/)).toBeInTheDocument();
  });

  it("renders both lanes with the exact inbox SubHeader labels, counts + see-all hrefs", () => {
    render(
      <FocusLauncher
        voice="plain"
        focusMinToday={0}
        currentStreak={0}
        clearedToday={false}
        data={data({
          singleTasks: [{ itemId: "i1", text: "Buy milk", estMinutes: 8 }],
          multiStep: [hero({ stepId: "m1", stepText: "Draft intro", resumable: false })],
        })}
      />,
    );
    expect(screen.getByText("Single-task to-dos")).toBeInTheDocument();
    expect(screen.getByText("Multi-step to-dos")).toBeInTheDocument();
    const seeAll = screen.getAllByRole("link", { name: /see all/i });
    const hrefs = seeAll.map((a) => a.getAttribute("href"));
    expect(hrefs).toContain("/library?tab=plated");
    expect(hrefs).toContain("/library?tab=sorted");
    expect(within(screen.getByTestId("single-lane")).getByText("Buy milk")).toBeInTheDocument();
    expect(within(screen.getByTestId("multi-lane")).getByText("Draft intro")).toBeInTheDocument();
  });

  it("renders the resume hero with step X/Y, ~Nm left, a progressbar, and ▶ Resume → /focus/[stepId]", () => {
    render(
      <FocusLauncher
        voice="plain"
        focusMinToday={0}
        currentStreak={0}
        clearedToday={false}
        data={data({ resumeHero: hero({ stepId: "h1", stepText: "Wire the API", stepIndex: 2, stepsTotal: 4, estMinutes: 12 }) })}
      />,
    );
    expect(screen.getByText(/Wire the API/)).toBeInTheDocument();
    expect(screen.getByText(/2\/4/)).toBeInTheDocument();
    expect(screen.getByText(/12m/)).toBeInTheDocument();
    expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "1");
    expect(screen.getByRole("link", { name: /resume focus/i })).toHaveAttribute("href", "/focus/h1");
  });

  it("shows the new-user empty state (Inbox card) when nothing is focusable and nothing was cleared", () => {
    render(<FocusLauncher voice="plain" focusMinToday={0} currentStreak={0} clearedToday={false} data={data()} />);
    expect(screen.getByText(/Nothing to focus yet/i)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /inbox/i })).toHaveAttribute("href", "/inbox");
    expect(screen.queryByText("Single-task to-dos")).not.toBeInTheDocument();
  });

  it("shows the all-cleared moment when nothing is focusable but work was done today", () => {
    render(<FocusLauncher voice="plain" focusMinToday={45} currentStreak={3} clearedToday data={data()} />);
    expect(screen.getByText(/All caught up/i)).toBeInTheDocument();
    expect(screen.queryByText(/Nothing to focus yet/i)).not.toBeInTheDocument();
  });

  it("is voice-aware (playful all-clear differs from plain)", () => {
    render(<FocusLauncher voice="playful" focusMinToday={45} currentStreak={3} clearedToday data={data()} />);
    expect(screen.getByText(/Plates cleared/i)).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- src/components/focus/focus-launcher.test.tsx`
Expected: FAIL — `FocusLauncher` still has the old `entries`/`voice` signature.

- [ ] **Step 3: Rewrite the shell**

Replace `src/components/focus/focus-launcher.tsx` with:

```tsx
import Link from "next/link";
import { t, type Voice } from "@/lib/strings";
import type { LauncherData } from "@/lib/focus-launcher";
import { SubHeader, SEE_ALL } from "@/components/inbox/sub-header";
import { SingleTaskLane, MultiStepLane } from "@/components/focus/focus-lanes";

/**
 * The /focus launcher shell: ← Back, title, a glanceable meta line into the
 * dashboard, an optional amber resume hero (most-recently-active paused
 * multi-step step), and the Single-task / Multi-step lanes using the exact
 * inbox SubHeader + "see all →". Read-only + Server-Component-safe; the lanes
 * (focus-lanes.tsx) are the only interactive island (optimistic quick-complete).
 */
export function FocusLauncher({
  data,
  focusMinToday,
  currentStreak,
  clearedToday,
  voice,
}: {
  data: LauncherData;
  focusMinToday: number;
  currentStreak: number;
  /** true → show the all-cleared moment; false → the brand-new Inbox card. */
  clearedToday: boolean;
  voice: Voice;
}) {
  const { resumeHero, singleTasks, multiStep, meta } = data;
  const isEmpty = !resumeHero && singleTasks.length === 0 && multiStep.length === 0;

  return (
    <div className="space-y-4">
      {/* 1. ← Back → /inbox (matches the Library page exactly). */}
      <Link
        href="/inbox"
        className="text-muted-foreground hover:text-foreground inline-flex min-h-[44px] items-center text-sm"
      >
        {t("action.back", voice)}
      </Link>

      {/* 2. Title. */}
      <h1 className="text-xl font-semibold">{t("nav.focusTimer", voice)}</h1>

      {/* 3. Meta line → /dashboard. Numbers composed around static units. */}
      <Link
        href="/dashboard"
        className="text-muted-foreground hover:text-foreground inline-flex min-h-[44px] flex-wrap items-center gap-x-1.5 text-sm"
      >
        <span className="tabular-nums">{focusMinToday}m {t("focus.meta.focusedToday", voice)}</span>
        <span aria-hidden="true">·</span>
        <span className="tabular-nums">🔥 {currentStreak}{t("focus.meta.dayStreak", voice)}</span>
        <span aria-hidden="true">·</span>
        <span className="tabular-nums">~{meta.minutesToClear}m {t("focus.meta.toClear", voice)}</span>
      </Link>

      {/* 4. Resume hero (amber) — only when a paused multi-step step exists. */}
      {resumeHero && (
        <div className="space-y-2 rounded-lg border border-amber-500/40 bg-amber-50 p-4 dark:bg-amber-950/20">
          <div className="flex items-center gap-2 text-xs">
            {/* Status glyph + text, not colour-only. */}
            <span className="font-medium text-amber-800 dark:text-amber-300">{t("focus.paused", voice)}</span>
            <span className="text-muted-foreground">{resumeHero.taskTitle}</span>
          </div>
          <p className="text-base font-semibold">
            {resumeHero.subtaskEmoji ? `${resumeHero.subtaskEmoji} ` : ""}
            {resumeHero.stepText}
          </p>
          <p className="text-muted-foreground text-xs tabular-nums">
            {t("step.counter", voice)} {resumeHero.stepIndex}/{resumeHero.stepsTotal} · ~{resumeHero.estMinutes}m {t("focus.hero.left", voice)}
          </p>
          <div
            className="h-1.5 w-full overflow-hidden rounded-full bg-amber-200 dark:bg-amber-900"
            role="progressbar"
            aria-valuenow={resumeHero.stepsDone}
            aria-valuemin={0}
            aria-valuemax={resumeHero.stepsTotal}
          >
            {/* motion-safe → reduced-motion users get an instant fill. */}
            <div
              className="h-full rounded-full bg-amber-500 motion-safe:transition-[width]"
              style={{ width: `${(resumeHero.stepsDone / resumeHero.stepsTotal) * 100}%` }}
            />
          </div>
          {resumeHero.nextStepText && (
            <p className="text-muted-foreground text-xs">
              {t("focus.hero.next", voice)} {resumeHero.nextStepEmoji ? `${resumeHero.nextStepEmoji} ` : ""}
              {resumeHero.nextStepText}
            </p>
          )}
          <Link
            href={`/focus/${resumeHero.stepId}`}
            className="inline-flex min-h-[44px] items-center rounded-md bg-amber-500 px-4 font-medium text-amber-950 hover:opacity-90"
          >
            {t("focus.hero.resume", voice)}
          </Link>
        </div>
      )}

      {/* 5 + 6. Lanes (hidden entirely in the empty/all-cleared case). */}
      {!isEmpty && (
        <div className="space-y-4">
          <div>
            <SubHeader label={t("section.singleTask", voice)} count={singleTasks.length} seeAllHref={SEE_ALL.singleTask} voice={voice} />
            {singleTasks.length === 0 ? (
              <p className="text-muted-foreground rounded-lg border border-dashed px-4 py-4 text-center text-xs">
                {t("bucket.empty", voice)}
              </p>
            ) : (
              <SingleTaskLane items={singleTasks} voice={voice} />
            )}
          </div>
          <div>
            <SubHeader label={t("section.multiStep", voice)} count={multiStep.length} seeAllHref={SEE_ALL.multiStep} voice={voice} />
            {multiStep.length === 0 ? (
              <p className="text-muted-foreground rounded-lg border border-dashed px-4 py-4 text-center text-xs">
                {t("bucket.empty", voice)}
              </p>
            ) : (
              <MultiStepLane items={multiStep} voice={voice} />
            )}
          </div>
        </div>
      )}

      {/* 7. Empty states. */}
      {isEmpty && clearedToday && (
        <div className="rounded-lg border border-dashed p-6 text-center">
          <p className="text-sm">{t("focus.launcher.allClear", voice)}</p>
        </div>
      )}
      {isEmpty && !clearedToday && (
        <div className="space-y-3 rounded-lg border border-dashed p-6 text-center">
          <p className="text-muted-foreground text-sm">{t("focus.launcher.empty", voice)}</p>
          <Link href="/inbox" className="inline-flex min-h-[44px] items-center justify-center text-sm underline">
            {t("nav.inbox", voice)}
          </Link>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -- src/components/focus/focus-launcher.test.tsx`
Expected: PASS (all 6 cases).

- [ ] **Step 5: Commit**

```bash
git add src/components/focus/focus-launcher.tsx src/components/focus/focus-launcher.test.tsx
git commit -m "feat(#8): /focus launcher shell — meta line, resume hero, lanes, empty states

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 7: Wire the page — expanded query + dashboard + selector

Feed the pure selector real data: tasks (with the open-session `startedAt` for `resumeAt`), the single-task bucket from `libraryBuckets`, and `getDashboardData` for the meta line + `clearedToday`.

**Files:**
- Modify: `src/app/(app)/focus/page.tsx` (full rewrite of the component body)

**Interfaces:**
- Consumes: `prisma`, `getSettings` (`@/lib/db`); `currentWorkspaceId` (`@/lib/workspace`); `TaskStatus`, `BrainDumpStatus` (`@/lib/constants`); `libraryBuckets`, `type Item` (`@/components/inbox/bucket`); `focusLauncherData`, `type SingleFocusable` (`@/lib/focus-launcher`); `getDashboardData` (`@/lib/rewards`); `FocusLauncher` (Task 6); `t`, `Voice`.
- Produces: the default `/focus` route component (no exported symbols other than `default` + `dynamic`).

- [ ] **Step 1: Rewrite the page**

Replace `src/app/(app)/focus/page.tsx` with:

```tsx
import { prisma, getSettings } from "@/lib/db";
import { currentWorkspaceId } from "@/lib/workspace";
import { TaskStatus, BrainDumpStatus } from "@/lib/constants";
import { libraryBuckets, type Item } from "@/components/inbox/bucket";
import { focusLauncherData, type FocusTask, type SingleFocusable } from "@/lib/focus-launcher";
import { getDashboardData } from "@/lib/rewards";
import { FocusLauncher } from "@/components/focus/focus-launcher";
import { type Voice } from "@/lib/strings";

// DB-backed, always fresh.
export const dynamic = "force-dynamic";

/**
 * /focus — the Focus launcher. A dashboard meta line, a resume hero
 * (most-recently-active paused multi-step step), and Single-task / Multi-step
 * lanes using the exact inbox SubHeader + "see all →", with inline ✓
 * quick-complete. Read-only: single-task ▶ Start lazily creates its one-step
 * task via ensureFocusStep at click time. Selection is the pure
 * focusLauncherData; this page only loads + maps.
 */
export default async function FocusLauncherPage() {
  const workspaceId = await currentWorkspaceId();
  const now = Date.now();

  const [rawTasks, rawItems, settings, dashboard] = await Promise.all([
    prisma.task.findMany({
      where: { workspaceId, status: { not: TaskStatus.Archived } },
      orderBy: { createdAt: "desc" },
      include: {
        steps: {
          orderBy: { order: "asc" },
          include: {
            // Most-recent open session → drives resumable + resumeAt ordering.
            focusSessions: {
              where: { endedAt: null },
              orderBy: { startedAt: "desc" },
              take: 1,
              select: { startedAt: true },
            },
          },
        },
      },
    }),
    // Single-task to-dos come from the SAME BrainDumpItem query + libraryBuckets
    // the Inbox/Library use, so the lanes can never disagree with those surfaces.
    prisma.brainDumpItem.findMany({
      where: { workspaceId, status: { not: BrainDumpStatus.Archived } },
      orderBy: { createdAt: "desc" },
      include: {
        task: {
          include: {
            steps: {
              orderBy: { order: "asc" },
              include: {
                focusSessions: { where: { endedAt: null }, select: { id: true }, take: 1 },
              },
            },
          },
        },
      },
    }),
    getSettings(workspaceId),
    getDashboardData(workspaceId),
  ]);

  const voice: Voice = settings.voice === "playful" ? "playful" : "plain";

  const tasks: FocusTask[] = rawTasks.map((task) => ({
    id: task.id,
    title: task.title,
    createdAt: task.createdAt,
    steps: task.steps.map((s) => ({
      id: s.id,
      order: s.order,
      text: s.text,
      done: s.done,
      estMinutes: s.estMinutes,
      subtaskEmoji: s.subtaskEmoji,
      resumable: s.focusSessions.length > 0,
      resumeAt: s.focusSessions[0]?.startedAt.getTime() ?? null,
    })),
  }));

  const items: Item[] = rawItems.map(({ task, ...item }) => ({
    ...item,
    stepsTotal: task?.steps.length ?? 0,
    stepsDone: task?.steps.filter((s) => s.done).length ?? 0,
    taskStatus: task?.status ?? null,
    scheduledAt: task?.scheduledAt ?? null,
    estMinutes: item.estMinutes,
    steps:
      task?.steps.map((s) => ({
        id: s.id,
        order: s.order,
        text: s.text,
        done: s.done,
        estMinutes: s.estMinutes,
        subtaskEmoji: s.subtaskEmoji,
        resumable: s.focusSessions.length > 0,
      })) ?? [],
  }));

  // The single-task ("plated") bucket → SingleFocusable rows. `?? 5` mirrors
  // library-row-meta's singleTaskEstimate (null estimate → a 5-min default).
  const singleTasks: SingleFocusable[] = libraryBuckets(items, now).singleTask.map((i) => ({
    itemId: i.id,
    text: i.text,
    estMinutes: i.estMinutes ?? 5,
  }));

  const data = focusLauncherData(tasks, singleTasks);

  return (
    <FocusLauncher
      data={data}
      focusMinToday={dashboard.focusMinToday}
      currentStreak={dashboard.currentStreak}
      // Proxy for "had focusable work today, now cleared" — a step got done today.
      clearedToday={dashboard.stepsDoneToday > 0}
      voice={voice}
    />
  );
}
```

- [ ] **Step 2: Typecheck + build the route**

Run: `npx tsc --noEmit`
Expected: clean.
Run: `npx next build`
Expected: compiles; `/focus` appears in the route list with no render error.

> No DB unit test is added here (MR ① has no schema change). The page's mapping is exercised by the pure `focusLauncherData` tests (Task 2) + the shell RTL tests (Task 6); the live query is covered by `tsc` + `next build` + the manual sweep in Task 9. If a DB-touching suite is ever added, run it against this worktree's Postgres schema after `npx prisma migrate deploy`.

- [ ] **Step 3: Commit**

```bash
git add "src/app/(app)/focus/page.tsx"
git commit -m "feat(#8): wire /focus page — expanded query, dashboard meta, launcher selector

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 8: a11y 4-item sweep for the launcher

Lock in (and prove where testable) the four a11y items across the new elements. Most are already wired in Tasks 5–6 (`min-h-[44px]`, `motion-safe:`, `role="progressbar"`, glyph+text); this task adds explicit regression assertions + fixes any gaps `tsc`/manual review surfaces.

**Files:**
- Modify: `src/components/focus/focus-launcher.tsx` / `src/components/focus/focus-lanes.tsx` (only if a gap is found)
- Test: `src/components/focus/focus-a11y.test.tsx` (create)

**Interfaces:**
- Consumes: `FocusLauncher` (Task 6), `SingleTaskLane`/`MultiStepLane` (Task 5).
- Produces: no new exports (test-only + any inline class fixes).

- [ ] **Step 1: Write the failing a11y assertions**

Create `src/components/focus/focus-a11y.test.tsx`:

```tsx
// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { FocusLauncher } from "@/components/focus/focus-launcher";
import { SingleTaskLane } from "@/components/focus/focus-lanes";
import type { LauncherData, FocusableStep } from "@/lib/focus-launcher";

vi.mock("next/link", () => ({
  default: ({ children, href }: { children: React.ReactNode; href: string }) => <a href={href}>{children}</a>,
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));
vi.mock("@/app/actions/braindump", () => ({ ensureFocusStep: vi.fn(), completeItem: vi.fn() }));
vi.mock("@/app/actions/focus", () => ({ completeStep: vi.fn() }));

const hero: FocusableStep = {
  stepId: "h1", stepText: "Wire the API", subtaskEmoji: null, estMinutes: 12,
  taskId: "t1", taskTitle: "Ship", resumable: true, resumeAt: 1,
  stepIndex: 2, stepsDone: 1, stepsTotal: 4, nextStepText: null, nextStepEmoji: null,
};
const data: LauncherData = { resumeHero: hero, singleTasks: [], multiStep: [], meta: { minutesToClear: 12 } };

afterEach(cleanup);

describe("launcher a11y sweep", () => {
  it("status is glyph + text, not colour-only: the paused hero shows the ⏸ 'paused' label", () => {
    render(<FocusLauncher voice="plain" focusMinToday={0} currentStreak={0} clearedToday={false} data={data} />);
    expect(screen.getByText(/paused/i)).toBeInTheDocument(); // '⏸ paused'
  });

  it("the hero progress uses role=progressbar with numeric min/now/max (not colour alone)", () => {
    render(<FocusLauncher voice="plain" focusMinToday={0} currentStreak={0} clearedToday={false} data={data} />);
    const bar = screen.getByRole("progressbar");
    expect(bar).toHaveAttribute("aria-valuemin", "0");
    expect(bar).toHaveAttribute("aria-valuenow", "1");
    expect(bar).toHaveAttribute("aria-valuemax", "4");
  });

  it("the resume CTA is a ≥44px target", () => {
    render(<FocusLauncher voice="plain" focusMinToday={0} currentStreak={0} clearedToday={false} data={data} />);
    expect(screen.getByRole("link", { name: /resume focus/i }).className).toMatch(/min-h-\[44px\]/);
  });

  it("lane Start + ✓ are ≥44px and the ✓ carries a text accessible name", () => {
    render(<SingleTaskLane voice="plain" items={[{ itemId: "i1", text: "Buy milk", estMinutes: 8 }]} />);
    expect(screen.getByRole("button", { name: /start/i }).className).toMatch(/min-h-\[44px\]/);
    const done = screen.getByRole("button", { name: /complete/i }); // aria-label, not colour
    expect(done.className).toMatch(/min-h-\[44px\]/);
    expect(done.className).toMatch(/min-w-\[44px\]/);
  });
});
```

- [ ] **Step 2: Run the tests**

Run: `npm test -- src/components/focus/focus-a11y.test.tsx`
Expected: PASS if Tasks 5–6 landed the classes/roles as written. If any assertion FAILS, add the missing class/role in the corresponding file (e.g. a stray control missing `min-h-[44px]`, or the progressbar missing an `aria-value*`), then re-run until green. **Do not** weaken the assertions.

- [ ] **Step 3: Manual contrast + reduced-motion check (both themes)**

Reduced motion: only the hero progress fill animates (`motion-safe:transition-[width]`) — confirm the class is present (grep `motion-safe` in `focus-launcher.tsx`); reduced-motion users get an instant fill, no other launcher motion exists. WCAG-AA: eyeball the amber hero text (`text-amber-800` / dark `text-amber-300`), the meta line (`text-muted-foreground`), the count pill, and "see all →" against light + dark backgrounds in the running app (Task 9); adjust the amber shade if any pair fails AA. Record the check.

- [ ] **Step 4: Commit**

```bash
git add src/components/focus/focus-a11y.test.tsx src/components/focus/focus-launcher.tsx src/components/focus/focus-lanes.tsx
git commit -m "test(#8): a11y sweep for the /focus launcher (44px, progressbar, glyph+text, reduced-motion)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 9: E2E selectors, full gates, manual sweep, refresh !86

**Files:**
- Modify: any Playwright spec that references the old launcher (see Step 1 — none exist on this branch)

**Interfaces:** none.

- [ ] **Step 1: Update / confirm Playwright e2e selectors**

The redesign changes the launcher's DOM (old: a flat `/focus/[stepId]` link list; new: hero + lanes + Start/Open/✓ buttons). Per the "update specs when touching focus UI" process, find any e2e spec that drives `/focus`:

Run: `grep -rEl "/focus|FocusLauncher|Start focusing" e2e tests 2>/dev/null; ls playwright.config.* 2>/dev/null`
Expected on this branch: **no matches / no config — there is no Playwright e2e infrastructure in this worktree yet.** So there are no launcher selectors to update in MR ①. Record this finding in the !86 description. (If a spec is later found, update its `/focus` selectors to the new roles: `link name:/back/`, `link name:/resume focus/`, `button name:/start|open/`, `button name:/complete/`, and the `SubHeader` labels — then re-run `npm run test:e2e`.)

- [ ] **Step 2: Full gates**

Run: `npx tsc --noEmit && npm run lint && npm test`
Expected: `tsc` clean · lint 0 new errors · all vitest suites green (note the passed count — includes the enriched `focus-launcher.test.ts`, `focus-lanes.test.tsx`, the rewritten `focus-launcher.test.tsx`, `sub-header.test.tsx`, `strings.launcher.test.tsx`, `focus-a11y.test.tsx`, and the untouched inbox suite).
Run: `npx next build`
Expected: compiles; `/focus` renders.

- [ ] **Step 3: Manual verification (use the `run` / `verify` project skill)**

On `/focus`:
- ← Back → `/inbox`; title reads Focus Timer / ⏱️ Focus Timer.
- Meta line shows `{focusMinToday}m focused today · 🔥 {streak}-day streak · ~{minutesToClear}m to clear` and links to `/dashboard`.
- With a paused multi-step step: the amber hero shows task title, step N/Y, ~Nm left, a progress bar, an optional `next →` peek, and ▶ Resume focus → the timer.
- Single-task lane: inbox label + count + see-all → `/library?tab=plated`; ▶ Start opens the timer (creates the one-step task); ✓ removes the row + updates counts.
- Multi-step lane: inbox label + count + see-all → `/library?tab=sorted`; the hero's task is NOT duplicated here; ▶ Open opens the shown step; ✓ completes that step.
- Empty (new workspace) → Inbox card; clear everything after doing a step today → the all-cleared moment.
- Toggle voice → playful adds emoji anchors; plain stays emoji-free (bar functional glyphs).

- [ ] **Step 4: Push to !86 (do NOT merge)**

```bash
git push origin feat/focus-page
```
Then: ensure **@GitLabDuo** is a reviewer on !86; note in the description that MR ① is launcher-only, has **no schema changes**, and is independent of !92/!94 (the timer/settings MRs ②/③ carry those). Request GitLabDuo re-review; hand to the owner for merge sign-off (wait for Duo's review + apply sensible suggestions before any merge).

---

## Self-Review (author checklist — completed)

**1. Spec coverage (Design A + Goals/a11y/Testing/Files/Plan):**
- ← Back → /inbox (matching Library) → Task 6 (shell). ✅
- Title `nav.focusTimer` → Task 6. ✅
- Meta line (`focusMinToday`m · 🔥`streak`-day · ~`minutesToClear`m) → /dashboard, data from `getDashboardData`; `minutesToClear` = Σ multi-step next-step est + Σ single-task est → Task 2 (compute) + Task 6 (render) + Task 7 (wire). ✅
- Resume hero (most-recently-active paused step, task/step X of Y/progress/~Nm left/next-peek/▶ Resume, amber) → Task 2 (select by `resumeAt`) + Task 6 (render). ✅
- Single-task lane (inbox `SubHeader` `section.singleTask` + count + see-all → `/library?tab=plated`; rows = `libraryBuckets().singleTask`; ▶ Start via `ensureFocusStep`; inline ✓ `completeItem`) → Task 4 (SubHeader) + Task 5 (rows/actions) + Task 6 (heading) + Task 7 (bucket). ✅
- Multi-step lane (inbox `SubHeader` `section.multiStep` + see-all → `/library?tab=sorted`; rows = `focusableSteps` next step, hero excluded; progress k/n; ▶ open; inline ✓ `completeStep`) → Tasks 2/4/5/6. ✅
- Quick-complete optimistic + `router.refresh()` → Task 5. ✅
- Empty (new-user → Inbox) + all-cleared (inbox-zero tone) states → Task 6 (`clearedToday`) + Task 3 (`focus.launcher.allClear`). ✅
- Pure, unit-tested selection module returning `{ resumeHero, singleTasks, multiStep, meta:{minutesToClear} }` → Tasks 1–2. ✅
- New voice-aware strings → Task 3. ✅
- a11y 4-item sweep for these elements → Task 8 (+ classes/roles wired in 5–6). ✅
- Updated launcher RTL tests → Tasks 5–6 (+ 8); Playwright e2e → Task 9 (documented: none exist on this branch). ✅
- **Out of scope confirmed absent:** no timer page / 4 styles / settings / audio / keep-awake / app-wide completion / `schema.prisma` / `Settings` / `googleSynced` changes; stated no-schema + independent-of-!92/!94 in Architecture, Global Constraints, and Task 9 Step 4. ✅

**2. Placeholder scan:** No "TBD"/"similar to Task N"/"add error handling"/"handle edge cases". Every code step carries real code; every test step carries real assertions; every run step carries an exact command + expected output. ✅

**3. Type consistency:**
- `FocusStep.resumeAt: number | null` (Task 1) is produced by the page mapping `s.focusSessions[0]?.startedAt.getTime() ?? null` (Task 7) and consumed by `focusableSteps` → `FocusableStep.resumeAt` (Task 1) → hero ordering in `focusLauncherData` (Task 2). ✅
- `FocusableStep` fields `stepIndex`/`stepsDone`/`stepsTotal`/`nextStepText`/`nextStepEmoji` defined in Task 1, produced by `focusableSteps`, consumed by `MultiStepLane` (Task 5) + the hero (Task 6). ✅
- `SingleFocusable = { itemId; text; estMinutes }` (Task 2) built by the page from `libraryBuckets().singleTask` (Task 7), consumed by `SingleTaskLane` (Task 5) + shell counts (Task 6). ✅
- `LauncherData` (Task 2) is the exact prop `FocusLauncher` consumes (Task 6) and the page produces via `focusLauncherData(tasks, singleTasks)` (Task 7). ✅
- `SubHeader({label,count,seeAllHref,voice})` + `SEE_ALL.{singleTask,multiStep}` (Task 4) consumed unchanged by `inbox-view.tsx` and the shell (Task 6). ✅
- Server actions reused with their real signatures: `ensureFocusStep(id): Promise<string|null>`, `completeItem(id)`, `completeStep(stepId)` (Task 5). ✅

**Known deviations (documented, spec-faithful):**
- Resume hero drawn from **multi-step tasks only** (Task 2 decision) — the spec only requires hero-exclusion from the multi-step lane and the hero UI is multi-step-shaped; a paused single-task still resumes via ▶ Start. 
- `clearedToday` uses `stepsDoneToday > 0` as the "did work today, now cleared" proxy (Task 6/7) — a pragmatic runtime signal since the pure selector can't know history.
- `SubHeader` is **extracted** (Task 4) rather than duplicated, to honour "the exact inbox SubHeader" (DRY); `inbox-view.tsx` behaviour is unchanged (import swap only).
</content>
</invoke>
