# Task-Row Redesign + Scheduling Entry Points Implementation Plan (#25)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every task row (inbox + to-do board) becomes the approved stacked layout — title line with meta at the end, action line `[contextual primary] [📅] [⋯]` — and 📅 schedules from any row (steps push for multi-step; duration popover + single Google Task for single tasks).

**Architecture:** Extract two small Google-Tasks helpers out of `pushStepsToGoogleTasks` so a new `scheduleSingleTask` action reuses them; add task-level `googleTaskId` columns; build a `RowActions` frame (primary + 📅 + ⋯ overflow) used by all three row kinds in `inbox-view.tsx`; scheduling states (not configured / connect / reconnect) come from the owner-fetched `getGoogleStatus()` passed down from the inbox page.

**Tech Stack:** Next 16 App Router, Prisma 6, dnd-kit (rows keep DragGrip), vitest + RTL (jsdom), existing voice/i18n helper `t(key, voice)`.

## Global Constraints

- Next 16: check `node_modules/next/dist/docs/` before unfamiliar APIs; Prisma 6 pinned — after `prisma migrate dev` remind the owner to restart the dev server.
- Copy rule (#22): user-facing scheduling copy says **Google Tasks**; Reclaim only as "a Reclaim-synced list is scheduled automatically".
- All user-visible row copy goes through the voice helper `t(key, voice)` (`src/lib/voice.ts`) when a key exists; raw strings only for copy that has no voice key yet (add keys only if the file's pattern makes it trivial).
- Owner-only: 📅 renders only when the row's `google` prop is non-null (guests get null — same gating as settings page).
- Failure-reason union (from `google-schedule.ts`): `"not_configured" | "not_connected" | "no_reclaim_list" | "no_steps" | "reconnect_required" | "error"` — `scheduleSingleTask` reuses it verbatim (minus `no_steps`).
- Gate before MR: `npx tsc --noEmit && npm run lint && npx vitest run && npm run build`.
- Branch: `feat/task-row-redesign` (exists — holds the spec). Commit per task + trailer `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.
- The mobile-DnD fix (MR !66, sensor split + `touch-none` grip) may or may not be merged when you start — if `inbox-view.tsx` conflicts on the sensors block when rebasing, keep BOTH changes (sensors from !66, row changes from this plan).

---

### Task 1: Schema — task-level Google Task columns

**Files:**
- Modify: `prisma/schema.prisma` (model `Task` — find it; Step already has `googleTaskId`/`googleTaskListId`, mirror those two nullable String columns)

**Interfaces:**
- Produces: `Task.googleTaskId: String?`, `Task.googleTaskListId: String?` — written by Task 3.

- [ ] **Step 1:** Add to `model Task`:

```prisma
  googleTaskId     String?
  googleTaskListId String?
```

- [ ] **Step 2:** Run `npx prisma migrate dev --name task_google_task_columns` (needs `docker compose up -d db`). Expected: one additive `ALTER TABLE "Task" ADD COLUMN …` ×2 migration.
- [ ] **Step 3:** Commit:

```bash
git add prisma/
git commit -m "feat(schema): task-level googleTaskId columns for single-task scheduling"
```

---

### Task 2: Extract reusable Google-Tasks helpers (pure refactor)

**Files:**
- Modify: `src/app/actions/google-schedule.ts` (inside `pushStepsToGoogleTasks`)

**Interfaces:**
- Produces (module-private, same file): `findReclaimListId(token: string): Promise<string | null>` (the existing tasklists fetch + case-insensitive "reclaim" title match, extracted verbatim) and `insertGoogleTask(token: string, listId: string, title: string): Promise<{ id: string } | null>` (the existing tasks-insert fetch, extracted verbatim). `buildTaskTitle(text: string, estMinutes: number)` already exists — do not duplicate it.

- [ ] **Step 1:** READ `pushStepsToGoogleTasks` end to end. Extract the two fetch blocks into the two named helpers above with EXACTLY the same request/response handling (URLs, headers, error paths). `pushStepsToGoogleTasks` must call the helpers and behave identically.
- [ ] **Step 2:** Run `npx vitest run src/app/actions/google-schedule.disconnect.test.ts && npx vitest run && npx tsc --noEmit` — everything stays green (pure refactor; the full suite is the safety net since the push path has no direct unit test).
- [ ] **Step 3:** Commit:

```bash
git add src/app/actions/google-schedule.ts
git commit -m "refactor(google-schedule): extract findReclaimListId + insertGoogleTask helpers"
```

---

### Task 3: `scheduleSingleTask` server action (TDD)

**Files:**
- Modify: `src/app/actions/google-schedule.ts`
- Test: `src/app/actions/google-schedule.single.test.ts` (new)

**Interfaces:**
- Consumes: helpers from Task 2, `buildTaskTitle`, `getValidAccessToken`/`getGoogleStatus`/`googleConfigured` (already imported in the file), owner-gate idiom `if (workspaceId !== OWNER_WORKSPACE_ID) throw new Error("owner only")`, `prisma`.
- Produces: `scheduleSingleTask(itemId: string, estMinutes: number): Promise<{ ok: true } | { ok: false; reason: "not_configured" | "not_connected" | "no_reclaim_list" | "reconnect_required" | "error"; message?: string }>` — consumed by Task 5's popover wiring. `itemId` is the BrainDumpItem id shown in the row (the same id the row's other actions use); the action resolves the linked Task via the item (READ how `completeItem`/`focusOnItem`-related actions resolve item→task in `src/app/actions/braindump.ts` and mirror that lookup; if the single-task item has no Task row yet, follow whatever `keepAsTask`/`completeItem` treats as the task linkage — the action must work for exactly the items the Single-task bucket shows).

- [ ] **Step 1: Failing tests** (mock idiom: mirror `google-schedule.disconnect.test.ts` — it already mocks `@/lib/google`, `@/lib/workspace`, `next/cache`, and whatever the module graph needs):

```ts
// src/app/actions/google-schedule.single.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";
// Copy the vi.hoisted + vi.mock block from google-schedule.disconnect.test.ts,
// adding googleAuth-independent mocks: getValidAccessToken, getGoogleStatus,
// googleConfigured from "@/lib/db"-adjacent modules per that file, plus a
// prisma mock exposing the models the item→task lookup uses and
// task.update (assert googleTaskId/googleTaskListId written).

import { OWNER_WORKSPACE_ID } from "@/lib/constants";
import { scheduleSingleTask } from "./google-schedule";

describe("scheduleSingleTask", () => {
  it("rejects non-owner", async () => {
    workspaceMock.mockResolvedValue("guest-ws");
    await expect(scheduleSingleTask("item-1", 30)).rejects.toThrow("owner only");
  });

  it("returns reconnect_required when tokens are dead", async () => {
    workspaceMock.mockResolvedValue(OWNER_WORKSPACE_ID);
    configuredMock.mockReturnValue(true);
    tokenMock.mockResolvedValue(null);
    statusMock.mockResolvedValue({ configured: true, connected: false, needsReconnect: true });
    expect(await scheduleSingleTask("item-1", 30)).toEqual({ ok: false, reason: "reconnect_required" });
  });

  it("creates one Google task titled with the duration convention and stores ids", async () => {
    workspaceMock.mockResolvedValue(OWNER_WORKSPACE_ID);
    configuredMock.mockReturnValue(true);
    tokenMock.mockResolvedValue("tok");
    // fetch mock: first call = tasklists (one list titled "🗓 Reclaim"),
    // second call = insert -> { id: "gtask-9" }
    // prisma mocks: item lookup resolves a task { id: "task-1", ... }
    const res = await scheduleSingleTask("item-1", 45);
    expect(res).toEqual({ ok: true });
    const insertBody = JSON.parse(fetchMock.mock.calls[1][1].body);
    expect(insertBody.title).toContain("(duration:45m)");
    expect(taskUpdateMock).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ googleTaskId: "gtask-9" }) }),
    );
  });
});
```

Adapt mock names to the idiom you copy; the three behaviors asserted are the requirements.

- [ ] **Step 2:** Run — FAIL (function missing).
- [ ] **Step 3: Implement** in `google-schedule.ts` (shape — adapt the item→task lookup per the Interfaces note):

```ts
export async function scheduleSingleTask(
  itemId: string,
  estMinutes: number,
): Promise<GoogleScheduleSingleResult> {
  const workspaceId = await currentWorkspaceId();
  if (workspaceId !== OWNER_WORKSPACE_ID) throw new Error("owner only");
  if (!googleConfigured()) return { ok: false, reason: "not_configured" };
  const token = await getValidAccessToken();
  if (!token) {
    const status = await getGoogleStatus();
    return { ok: false, reason: status.needsReconnect ? "reconnect_required" : "not_connected" };
  }
  // item -> task lookup (workspace-scoped, mirrors braindump action idiom)
  const item = await prisma.brainDumpItem.findFirst({
    where: { id: itemId, workspaceId },
    include: { task: true },
  });
  const task = item?.task;
  if (!task) return { ok: false, reason: "error", message: "No task for item" };
  const listId = await findReclaimListId(token);
  if (!listId) return { ok: false, reason: "no_reclaim_list" };
  const created = await insertGoogleTask(token, listId, buildTaskTitle(item.text, estMinutes));
  if (!created) return { ok: false, reason: "error" };
  await prisma.task.update({
    where: { id: task.id },
    data: { googleTaskId: created.id, googleTaskListId: listId },
  });
  return { ok: true };
}
```

Define `GoogleScheduleSingleResult` as the union in Interfaces. If the schema's item↔task relation differs (verify in `prisma/schema.prisma`), adjust the lookup but keep the workspace scoping.

- [ ] **Step 4:** Run new file + FULL suite + tsc — green/clean.
- [ ] **Step 5:** Commit:

```bash
git add src/app/actions/google-schedule.ts src/app/actions/google-schedule.single.test.ts
git commit -m "feat(actions): scheduleSingleTask — one Google Task with duration convention"
```

---

### Task 4: `RowActions` frame + `SchedulePopover` (TDD)

**Files:**
- Create: `src/components/inbox/row-actions.tsx`
- Test: `src/components/inbox/row-actions.test.tsx`

**Interfaces:**
- Produces:
  - `RowActions({ primary, schedule, overflow, meta }: { primary?: ReactNode; schedule?: ScheduleControlProps | null; overflow: ReactNode[]; meta?: string })` — renders the action line: primary slot, 📅 control (omitted when `schedule` is null), ⋯ menu containing `overflow` entries, and right-aligned quiet `meta` text. (NOTE: per the approved design, meta lives on the TITLE line; `meta` here is optional support for rows whose title line is too crowded — default unused.)
  - `ScheduleControlProps = { state: "ready_steps" | "needs_duration" | "connect" | "reconnect"; onScheduleSteps?: () => void; onScheduleSingle?: (minutes: number) => void }` — `ready_steps` fires `onScheduleSteps` directly; `needs_duration` opens the popover (15/30/60/custom number input) then fires `onScheduleSingle(minutes)`; `connect`/`reconnect` render an `<a href="/api/google/oauth/start">` with matching label.
- Consumes: nothing from other tasks (pure component).

- [ ] **Step 1: Failing tests** (jsdom pragma + `afterEach(cleanup)` — copy the idiom from `src/components/settings/integrations-panel.test.tsx`):

```tsx
it("ready_steps: 📅 fires onScheduleSteps immediately", () => {
  const fn = vi.fn();
  render(<RowActions overflow={[]} schedule={{ state: "ready_steps", onScheduleSteps: fn }} />);
  fireEvent.click(screen.getByRole("button", { name: /schedule/i }));
  expect(fn).toHaveBeenCalledOnce();
});

it("needs_duration: 📅 opens the popover; picking 30 fires onScheduleSingle(30)", () => {
  const fn = vi.fn();
  render(<RowActions overflow={[]} schedule={{ state: "needs_duration", onScheduleSingle: fn }} />);
  fireEvent.click(screen.getByRole("button", { name: /schedule/i }));
  fireEvent.click(screen.getByRole("button", { name: /^30 min$/i }));
  expect(fn).toHaveBeenCalledWith(30);
});

it("custom duration input schedules with the typed minutes", () => {
  const fn = vi.fn();
  render(<RowActions overflow={[]} schedule={{ state: "needs_duration", onScheduleSingle: fn }} />);
  fireEvent.click(screen.getByRole("button", { name: /schedule/i }));
  fireEvent.change(screen.getByRole("spinbutton"), { target: { value: "25" } });
  fireEvent.click(screen.getByRole("button", { name: /go/i }));
  expect(fn).toHaveBeenCalledWith(25);
});

it("reconnect state renders the OAuth link, not a button", () => {
  render(<RowActions overflow={[]} schedule={{ state: "reconnect" }} />);
  expect(screen.getByRole("link", { name: /reconnect google/i })).toHaveAttribute(
    "href", "/api/google/oauth/start",
  );
});

it("no schedule prop → no 📅 control (guest rows)", () => {
  render(<RowActions overflow={[<span key="a">Edit</span>]} schedule={null} />);
  expect(screen.queryByRole("button", { name: /schedule/i })).toBeNull();
});

it("overflow entries render inside the ⋯ menu after opening it", () => {
  render(<RowActions overflow={[<button key="d">Delete</button>]} schedule={null} />);
  fireEvent.click(screen.getByRole("button", { name: /more actions/i }));
  expect(screen.getByRole("button", { name: /delete/i })).toBeInTheDocument();
});
```

- [ ] **Step 2:** Run — FAIL (module missing).
- [ ] **Step 3: Implement** `row-actions.tsx`: client component; ⋯ button (`aria-label="More actions"`) toggling a small absolute-positioned menu (match `MoveToMenu`'s open/close + Escape/outside-click idiom — read `src/components/inbox/move-to-menu.tsx` and reuse its pattern); 📅 button `aria-label="Schedule"` `title="Schedule"` with the four states; popover = inline div with 15/30/60 buttons + `<input type="number">` + Go. Buttons: `rounded-md px-2.5 py-1 font-medium` idiom, primary slot rendered as-is.
- [ ] **Step 4:** Run file + full suite + tsc + lint — green.
- [ ] **Step 5:** Commit:

```bash
git add src/components/inbox/row-actions.*
git commit -m "feat(inbox): RowActions frame — primary + schedule control + overflow menu"
```

---

### Task 5: Wire the to-do board rows (multi-step + single-task)

**Files:**
- Modify: `src/components/inbox/inbox-view.tsx` (multiStep rows ~392-463, singleTask rows ~477-505; prop plumbing at the component top)
- Modify: `src/app/(app)/inbox/page.tsx` (fetch + pass `google` status for the owner; find the page that renders `InboxView` — verify path with `grep -rn "InboxView" src/app`)
- Test: extend `src/components/inbox/inbox-view.test.tsx` with the cases below

**Interfaces:**
- Consumes: `RowActions`/`ScheduleControlProps` (Task 4), `scheduleSingleTask` (Task 3), `pushStepsToGoogleTasks` (existing), `getGoogleStatus` (existing).
- Produces: `InboxView` gains prop `google: { configured: boolean; connected: boolean; needsReconnect: boolean } | null` (null = guest → no 📅 anywhere).

- [ ] **Step 1: Failing tests** (in the existing inbox-view test file, using its established render helper):
  - multi-step row with steps: 📅 present; clicking it calls the (mocked) `pushStepsToGoogleTasks` with the row's `taskId`.
  - single-task row: 📅 opens popover; "30 min" calls mocked `scheduleSingleTask(itemId, 30)`.
  - `google={null}` (guest): no Schedule control on any row.
  - `google={{configured:true,connected:false,needsReconnect:true}}`: rows show the Reconnect link instead of 📅 button.
- [ ] **Step 2:** Run — FAIL.
- [ ] **Step 3: Implement.**
  - Both board row kinds: replace the bare `mt-2 flex flex-wrap gap-2` action rows with `RowActions`:
    - multiStep: `primary` = the existing red break-now button when `awaitingBreakdown`, else the existing `CompleteButton`; `schedule` = `google ? { state: scheduleState(google), onScheduleSteps: () => run(() => pushStepsToGoogleTasks(item.taskId!)) } : null` where rows WITH steps use `ready_steps`; `overflow` = [MoveToMenu entry, pencil/edit entry, delete entry if the row kind has one].
    - singleTask: `primary` = existing ▶ Focus button; `schedule` uses `needs_duration` with `onScheduleSingle: (m) => run(() => scheduleSingleTask(item.id, m))`; same overflow treatment.
    - Shared helper in the file: `const scheduleState = (g) => !g.configured ? "connect" : g.needsReconnect ? "reconnect" : /* per-row */;` — rows pass their own `ready_steps`/`needs_duration` when connected.
  - Title lines: move the step-count/meta text (`{item.stepsTotal} steps · …`) to the END of the title line styled `text-muted-foreground text-xs` (multiStep already has it there — keep), and for singleTask add captured-age meta at title-line end if the item exposes it (check the item shape; if no age field is available on board items, skip — do NOT invent data).
  - MoveToMenu inside overflow: render as a menu entry that opens the existing component (acceptable: keep `MoveToMenu` as a sibling control inside the ⋯ menu list).
  - `page.tsx`: `const google = owner ? await getGoogleStatus() : null;` → `<InboxView … google={google} />` (mirror the settings page's owner gating from the integrations MR).
- [ ] **Step 4:** Run full suite + tsc + lint — green. Also `npm run build`.
- [ ] **Step 5:** Commit:

```bash
git add src/components/inbox/ "src/app/(app)/inbox/page.tsx"
git commit -m "feat(inbox): board rows get [primary][schedule][overflow] frame + row scheduling"
```

---

### Task 6: Needs-review rows join the frame

**Files:**
- Modify: `src/components/inbox/inbox-view.tsx` (the `InboxItemRow` component and its call site ~340-373)
- Test: extend `src/components/inbox/inbox-view.test.tsx`

**Interfaces:**
- Consumes: `RowActions` (Task 4). No scheduling on needs-review rows (they're unclarified — primary IS "Break down"): `schedule` = null unless `google` is present AND the design decision holds: per the approved spec, 📅 is ALWAYS in the same slot — for unclarified rows use `schedule={{ state: "needs_duration", onScheduleSingle }}` only if the item already has a task linkage; otherwise omit 📅 (spec: primary = next right thing; scheduling an unclarified capture is not offered).

- [ ] **Step 1: Failing test:** needs-review row renders `RowActions` with primary = Break-down CTA and its former inline buttons (keep/snooze/freshen/delete/dismiss variants) inside the ⋯ overflow; assert one representative: after opening "More actions", the Snooze entry is visible and fires its handler.
- [ ] **Step 2:** Run — FAIL.
- [ ] **Step 3: Implement:** READ `InboxItemRow` fully first (it takes `onBreakdown/onKeep/onSnooze/onComplete/…` — see call site at lines 352-372). Rework its action area to `RowActions`: `primary` = Break-down CTA (existing styling/voice key), `overflow` = [Keep as task, Snooze 1h, Complete, Move to… (the passed `moveMenu`), Edit (passed `editButton`), Delete (existing confirm flow — the confirm step stays inline in the menu entry)]. Preserve every existing handler and the freshness/prompt sub-UI untouched.
- [ ] **Step 4:** Full suite + tsc + lint + build — green.
- [ ] **Step 5:** Commit:

```bash
git add src/components/inbox/
git commit -m "feat(inbox): needs-review rows adopt the shared action frame"
```

---

### Task 7: Gate, runtime verify, MR

- [ ] **Step 1:** Full gate: `npx tsc --noEmit && npm run lint && npx vitest run && npm run build` — all clean; test count strictly above the pre-plan 440.
- [ ] **Step 2:** Runtime verify (prod build, boot-guard env, dev DB — recipe in `.superpowers/sdd/task-9-report.md` from the integrations plan): anonymous `/inbox` renders rows with NO Schedule control; kill servers after.
- [ ] **Step 3:** Push + MR: title `feat(inbox): task-row redesign + row scheduling — #25`, description covering the approved mockup (link the #25 issue images), the three row kinds, 📅 behaviors and failure states, reviewers dlectronique + GitLabDuo, milestone v0.0.2, label none-beyond-defaults. Do NOT merge — owner merges after Duo. Update #25: status stays In progress, tick delivered checkboxes, comment with MR link. Owner phone-verifies drag+schedule on the review app.
