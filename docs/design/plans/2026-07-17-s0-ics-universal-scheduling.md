# S0 — ICS Universal Scheduling Method Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make ICS "Add to calendar" a first-class per-task scheduling method available to everyone (guests + owner), earning the `Scheduled` reward + `FirstSchedule` badge once per task via a provider-agnostic `Task.scheduledAt`/`scheduledVia` marker that also drives a "Scheduled ✓" row indicator.

**Architecture:** A new workspace-scoped `scheduleViaIcs` server action (no owner gate) loads the IDOR-scoped task, builds the `.ics` (per-step events, or one synthesized event for a stepless task), stamps `scheduledAt`/`scheduledVia="ics"` and awards once (idempotent, best-effort reward), and returns `{ ok, ics, icsFilename }` for a client-side Blob download. The Google scheduling paths set the same provider-agnostic marker (`scheduledVia="google"`), and the inbox rows render the guest 📅 as an actionable ICS control (owners get it in the ▾ menu) plus a "Scheduled ✓" badge from `scheduledAt`.

**Tech Stack:** Next.js 16, TypeScript, Prisma/Postgres, Vitest (+ jsdom/RTL)

## Global Constraints
- Workspace-scoped: `scheduleViaIcs` uses `currentWorkspaceId()` with NO `OWNER_WORKSPACE_ID` gate (guests allowed); IDOR-safe via `findFirst({ where: { id, workspaceId } })`.
- Reuse the existing reward helpers (`logReward`, `awardBadge` — already P2002-safe) — do not reimplement them.
- Award once per task, idempotent on `scheduledAt` (skip marker + award when `scheduledAt != null`).
- Reward is best-effort: wrap `logReward`/`awardBadge` in an INNER `try/catch` so a reward failure NEVER fails scheduling (same lesson applied to the Google paths).
- Forward-only migration (repo policy) — no back-fill of existing Google-scheduled tasks.
- `.ics` build is pure + cheap (no AI, no external call) → no guest quota needed.
- Gates must stay green after every task: `npx tsc --noEmit`, `npx eslint .`, `npx vitest run`.

---

## File Structure

**Create**
- `prisma/migrations/20260717120000_task_scheduled_marker/migration.sql` — adds `Task.scheduledAt` + `Task.scheduledVia`.
- `src/app/actions/ics-schedule.ts` — the `scheduleViaIcs` server action (build `.ics` + mark + award once).
- `src/app/actions/ics-schedule.test.ts` — action unit tests (awards once, guest earns, idempotent, no-steps durationMin, IDOR not-found, reward-failure-safe).
- `src/lib/download-ics.ts` — client Blob-download helper `downloadIcs(ics, filename)`.
- `src/lib/download-ics.test.tsx` — jsdom test for the download helper.
- `src/app/actions/google-schedule.push.test.ts` — tests the Google multi-step path's new marker + reward-once.

**Modify**
- `prisma/schema.prisma` (`model Task` ~line 108) — add the two marker columns.
- `src/lib/ics.ts` — add `fallbackDurationMin` (single-event for stepless tasks) to `buildTaskIcs`; add exported `icsFilename(title)` helper.
- `src/lib/ics.test.ts` — cover the no-steps single-event case + `icsFilename`.
- `src/app/api/ics/[taskId]/route.ts` — use the shared `icsFilename` helper (identical output; DRY).
- `src/app/actions/google-schedule.ts` — both Google paths set the provider-agnostic marker; multi-step path gates reward on `scheduledAt` + inner try/catch.
- `src/app/actions/google-schedule.single.test.ts` — assert the single-task path sets `scheduledVia="google"`.
- `src/components/inbox/row-actions.tsx` — replace the disabled `guest` state with actionable ICS states (`ics_ready_steps`/`ics_needs_duration`) + `onScheduleIcs`; add a `scheduled` "Scheduled ✓" indicator to `RowActions`.
- `src/components/inbox/row-actions.test.tsx` — RTL for the ICS states + the indicator slot.
- `src/lib/strings.ts` — add `action.addToCalendar` voice string.
- `src/components/inbox/bucket.ts` — add `scheduledAt: Date | null` to the `Item` type.
- `src/app/(app)/inbox/page.tsx` — thread `task.scheduledAt` into the mapped `Item`.
- `src/components/inbox/inbox-view.tsx` — wire guest ICS primary + owner ▾ ICS entry + Blob download; pass `scheduled` to rows.
- `src/components/inbox/inbox-view.test.tsx` — RTL for guest ICS flow + owner ▾ entry + "Scheduled ✓" indicator; extend `makeItem`/mocks.
- `src/components/breakdown/breakdown-chat.tsx` — re-route the "Download calendar (.ics)" link through `scheduleViaIcs` + `downloadIcs`.
- `src/components/breakdown/breakdown-chat.test.tsx` + `src/components/breakdown/breakdown-chat.schedule.test.tsx` — add mocks for the new imports (`@/app/actions/ics-schedule`, `@/lib/download-ics`); one new test for the ICS re-route.

---

### Task 1: Prisma migration — add `Task.scheduledAt` + `Task.scheduledVia`

**Files:**
- Modify: `prisma/schema.prisma` (`model Task`, ~line 108–123)
- Create: `prisma/migrations/20260717120000_task_scheduled_marker/migration.sql`

**Interfaces:**
- Produces: Prisma `Task` model gains `scheduledAt: DateTime | null` and `scheduledVia: string | null` (regenerated client types consumed by Tasks 3, 4, 6).

Steps:
- [ ] Add the two columns to `model Task` in `prisma/schema.prisma`, immediately after the `googleTaskListId` line:
  ```prisma
  googleTaskId     String?
  googleTaskListId String?
  scheduledAt      DateTime?  // when the task was first scheduled (any method)
  scheduledVia     String?    // "ics" | "google" (method-agnostic marker)
  ```
- [ ] Create the migration SQL file `prisma/migrations/20260717120000_task_scheduled_marker/migration.sql` (hand-authored, mirrors `20260716170652_task_google_task_columns` style; `TIMESTAMP(3)` per `20260711144424_add_breakdown_requested_at`):
  ```sql
  -- AlterTable: provider-agnostic "scheduled" marker (S0, epic #29)
  ALTER TABLE "Task" ADD COLUMN     "scheduledAt" TIMESTAMP(3),
  ADD COLUMN     "scheduledVia" TEXT;
  ```
- [ ] Regenerate the Prisma client (works offline): `npx prisma generate` — expect "Generated Prisma Client" success.
- [ ] Validate the schema: `npx prisma validate` — expect "The schema at prisma/schema.prisma is valid".
- [ ] Typecheck (client now exposes the fields, no consumer yet): `npx tsc --noEmit` — expect PASS.
- [ ] Commit: `git add prisma && git commit -m "feat(scheduling): add provider-agnostic Task.scheduledAt/scheduledVia (#29)"`
- [ ] (If a dev DB is available — `docker compose up -d db`) apply with `npm run db:migrate -- --name task_scheduled_marker` instead of hand-authoring, then reconcile the generated folder name. Otherwise the hand-authored file above is applied by `prisma migrate deploy` in CI/prod.

---

### Task 2: `buildTaskIcs` single-event support + shared `icsFilename` helper

**Files:**
- Modify: `src/lib/ics.ts`
- Test: `src/lib/ics.test.ts`
- Modify: `src/app/api/ics/[taskId]/route.ts` (lines 3, 28, 32)

**Interfaces:**
- Produces:
  - `buildTaskIcs(input: { title: string; parentEmoji?: string | null; steps: IcsStep[]; start?: Date; fallbackDurationMin?: number }): string` — when `steps` is empty AND `fallbackDurationMin` is set, emits exactly one `VEVENT` of that length titled with the task title alone (no `"title: step"` suffix). Steps present → unchanged. Empty + no fallback → unchanged (zero events).
  - `icsFilename(title: string): string` — returns `dlectroflow-<slug>.ics` (slug = `title.replace(/[^a-z0-9]+/gi, "-").slice(0, 40) || "task"`).
- Consumed by: Task 3 (`scheduleViaIcs`), the ICS route.

Steps:
- [ ] Add failing tests to `src/lib/ics.test.ts` (append inside the file):
  ```ts
  it("no-steps task with fallbackDurationMin emits exactly one VEVENT titled with the task title", () => {
    const s = buildTaskIcs({
      title: "Call dentist",
      parentEmoji: "📞",
      steps: [],
      fallbackDurationMin: 45,
      start: new Date(2026, 6, 8, 9, 0, 0),
    });
    expect((s.match(/BEGIN:VEVENT/g) ?? []).length).toBe(1);
    expect(s).toContain("SUMMARY:📞 Call dentist");
    expect(s).toContain("DTSTART:20260708T090000");
    expect(s).toContain("DTEND:20260708T094500"); // +45 min
  });
  it("empty steps and no fallbackDurationMin emits zero VEVENTs (unchanged)", () => {
    const s = buildTaskIcs({ title: "x", steps: [] });
    expect((s.match(/BEGIN:VEVENT/g) ?? []).length).toBe(0);
  });
  ```
  and a new describe block:
  ```ts
  describe("icsFilename", () => {
    it("slugifies the title and prefixes dlectroflow-", () => {
      expect(icsFilename("Ship the thing")).toBe("dlectroflow-Ship-the-thing.ics");
    });
    it("falls back to 'task' for an empty title", () => {
      expect(icsFilename("")).toBe("dlectroflow-task.ics");
    });
  });
  ```
  Update the import line at the top of the test to: `import { buildTaskIcs, icsFilename } from "./ics";`
- [ ] Run: `npx vitest run src/lib/ics.test.ts` — expect FAIL (`icsFilename` is not exported; no-steps case emits 0 events).
- [ ] Implement in `src/lib/ics.ts`. Extend the `buildTaskIcs` input type with `fallbackDurationMin?: number;` and, after the `input.steps.forEach(...)` loop closes and before `lines.push("END:VCALENDAR")`, add the stepless single-event branch:
  ```ts
  if (input.steps.length === 0 && input.fallbackDurationMin != null) {
    const dur = Math.max(1, Math.round(input.fallbackDurationMin));
    const end = new Date(start.getTime() + dur * 60_000);
    const summary = `${input.parentEmoji ? input.parentEmoji + " " : ""}${input.title}`;
    lines.push(
      "BEGIN:VEVENT",
      `UID:${floating(start)}-0@dlectroflow`,
      `DTSTAMP:${new Date().toISOString().replace(/[-:]/g, "").slice(0, 15)}Z`,
      `DTSTART:${floating(start)}`,
      `DTEND:${floating(end)}`,
      `SUMMARY:${esc(summary)}`,
      "END:VEVENT",
    );
  }
  ```
  Then append the helper at the end of the file:
  ```ts
  /** Download filename for a task's .ics — shared by the ICS route and the
   *  scheduleViaIcs action so the name is defined in exactly one place. */
  export function icsFilename(title: string): string {
    const safe = title.replace(/[^a-z0-9]+/gi, "-").slice(0, 40) || "task";
    return `dlectroflow-${safe}.ics`;
  }
  ```
- [ ] Run: `npx vitest run src/lib/ics.test.ts` — expect PASS.
- [ ] Refactor the route to reuse the helper (identical output, DRY). In `src/app/api/ics/[taskId]/route.ts`: change the import to `import { buildTaskIcs, icsFilename } from "@/lib/ics";`, delete the local `const safe = ...` line, and change the header to `"Content-Disposition": \`attachment; filename="${icsFilename(task.title)}"\`,`.
- [ ] Run: `npx tsc --noEmit && npx vitest run src/lib/ics.test.ts` — expect PASS.
- [ ] Commit: `git add src/lib/ics.ts src/lib/ics.test.ts "src/app/api/ics/[taskId]/route.ts" && git commit -m "feat(ics): single-event builder for stepless tasks + shared icsFilename (#29)"`

---

### Task 3: `scheduleViaIcs` server action

**Files:**
- Create: `src/app/actions/ics-schedule.ts`
- Test: `src/app/actions/ics-schedule.test.ts`

**Interfaces:**
- Consumes: `currentWorkspaceId()`, `prisma.task.findFirst`/`prisma.task.update`, `buildTaskIcs`, `icsFilename`, `logReward`, `awardBadge`, `RewardType.Scheduled`, `BadgeKey.FirstSchedule`, `revalidatePath`.
- Produces:
  ```ts
  type IcsScheduleResult =
    | { ok: true; ics: string; icsFilename: string }
    | { ok: false; reason: "not_found" | "error"; message?: string };

  scheduleViaIcs(taskId: string, opts?: { durationMin?: number }): Promise<IcsScheduleResult>
  ```
  Consumed by Task 5 (inbox rows) + Task 7 (breakdown chat).

Steps:
- [ ] Write the failing test file `src/app/actions/ics-schedule.test.ts` (mirrors `google-schedule.single.test.ts` mocking style):
  ```ts
  import { describe, it, expect, vi, beforeEach } from "vitest";

  const {
    workspaceMock,
    revalidatePathMock,
    taskFindFirstMock,
    taskUpdateMock,
    logRewardMock,
    awardBadgeMock,
  } = vi.hoisted(() => ({
    workspaceMock: vi.fn(),
    revalidatePathMock: vi.fn(),
    taskFindFirstMock: vi.fn(),
    taskUpdateMock: vi.fn(),
    logRewardMock: vi.fn(),
    awardBadgeMock: vi.fn(),
  }));

  vi.mock("next/cache", () => ({ revalidatePath: revalidatePathMock }));
  vi.mock("@/lib/db", () => ({
    prisma: { task: { findFirst: taskFindFirstMock, update: taskUpdateMock } },
  }));
  vi.mock("@/lib/rewards", () => ({ logReward: logRewardMock, awardBadge: awardBadgeMock }));
  vi.mock("@/lib/workspace", () => ({ currentWorkspaceId: workspaceMock }));

  import { scheduleViaIcs } from "./ics-schedule";
  import { RewardType, BadgeKey } from "@/lib/constants";

  beforeEach(() => {
    vi.clearAllMocks();
    logRewardMock.mockResolvedValue(undefined);
    awardBadgeMock.mockResolvedValue(undefined);
    taskUpdateMock.mockResolvedValue({});
  });

  const stepTask = (over: Record<string, unknown> = {}) => ({
    id: "task-1",
    title: "Ship the thing",
    parentEmoji: "🚀",
    scheduledAt: null,
    steps: [{ text: "Plan", estMinutes: 15, subtaskEmoji: "📝" }],
    ...over,
  });

  describe("scheduleViaIcs", () => {
    it("awards Scheduled + FirstSchedule once on first schedule and marks the task", async () => {
      workspaceMock.mockResolvedValue("owner");
      taskFindFirstMock.mockResolvedValue(stepTask());
      const res = await scheduleViaIcs("task-1");
      expect(res.ok).toBe(true);
      if (res.ok) {
        expect(res.ics).toContain("BEGIN:VCALENDAR");
        expect(res.icsFilename).toBe("dlectroflow-Ship-the-thing.ics");
      }
      expect(taskUpdateMock).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: "task-1" },
          data: expect.objectContaining({ scheduledVia: "ics" }),
        }),
      );
      expect(logRewardMock).toHaveBeenCalledWith("owner", RewardType.Scheduled);
      expect(awardBadgeMock).toHaveBeenCalledWith("owner", BadgeKey.FirstSchedule);
    });

    it("guest workspace earns the reward (no owner gate)", async () => {
      workspaceMock.mockResolvedValue("guest-ws");
      taskFindFirstMock.mockResolvedValue(stepTask());
      const res = await scheduleViaIcs("task-1");
      expect(res.ok).toBe(true);
      expect(logRewardMock).toHaveBeenCalledWith("guest-ws", RewardType.Scheduled);
    });

    it("is idempotent: an already-scheduled task returns the .ics but does NOT re-award", async () => {
      workspaceMock.mockResolvedValue("owner");
      taskFindFirstMock.mockResolvedValue(stepTask({ scheduledAt: new Date("2026-07-17T10:00:00Z") }));
      const res = await scheduleViaIcs("task-1");
      expect(res.ok).toBe(true);
      expect(taskUpdateMock).not.toHaveBeenCalled();
      expect(logRewardMock).not.toHaveBeenCalled();
      expect(awardBadgeMock).not.toHaveBeenCalled();
    });

    it("no-steps task synthesizes one event from durationMin", async () => {
      workspaceMock.mockResolvedValue("owner");
      taskFindFirstMock.mockResolvedValue(stepTask({ steps: [] }));
      const res = await scheduleViaIcs("task-1", { durationMin: 45 });
      expect(res.ok).toBe(true);
      if (res.ok) {
        expect((res.ics.match(/BEGIN:VEVENT/g) ?? []).length).toBe(1);
        expect(res.ics).toContain("SUMMARY:🚀 Ship the thing");
      }
    });

    it("wrong-workspace taskId is not found (IDOR-safe) — no award, no marker", async () => {
      workspaceMock.mockResolvedValue("guest-ws");
      taskFindFirstMock.mockResolvedValue(null);
      const res = await scheduleViaIcs("task-owned-by-someone-else");
      expect(res).toEqual({ ok: false, reason: "not_found" });
      expect(taskFindFirstMock).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: "task-owned-by-someone-else", workspaceId: "guest-ws" },
        }),
      );
      expect(logRewardMock).not.toHaveBeenCalled();
      expect(taskUpdateMock).not.toHaveBeenCalled();
    });

    it("a reward failure does not fail scheduling (returns the .ics anyway)", async () => {
      workspaceMock.mockResolvedValue("owner");
      taskFindFirstMock.mockResolvedValue(stepTask());
      logRewardMock.mockRejectedValue(new Error("db down"));
      const res = await scheduleViaIcs("task-1");
      expect(res.ok).toBe(true);
      if (res.ok) expect(res.ics).toContain("BEGIN:VCALENDAR");
    });
  });
  ```
- [ ] Run: `npx vitest run src/app/actions/ics-schedule.test.ts` — expect FAIL (module `./ics-schedule` does not exist).
- [ ] Implement `src/app/actions/ics-schedule.ts`:
  ```ts
  "use server";

  import { revalidatePath } from "next/cache";
  import { prisma } from "@/lib/db";
  import { buildTaskIcs, icsFilename } from "@/lib/ics";
  import { RewardType, BadgeKey } from "@/lib/constants";
  import { logReward, awardBadge } from "@/lib/rewards";
  import { currentWorkspaceId } from "@/lib/workspace";

  const DEFAULT_ICS_DURATION_MIN = 25;

  export type IcsScheduleResult =
    | { ok: true; ics: string; icsFilename: string }
    | { ok: false; reason: "not_found" | "error"; message?: string };

  /**
   * Build a task's .ics and schedule it via download — workspace-scoped and
   * guest-allowed (NO owner gate). First schedule (any method) stamps the
   * provider-agnostic marker and awards Scheduled + FirstSchedule once;
   * re-downloads return the file without re-awarding. The reward is best-effort:
   * a logging failure must never fail scheduling.
   */
  export async function scheduleViaIcs(
    taskId: string,
    opts?: { durationMin?: number },
  ): Promise<IcsScheduleResult> {
    const workspaceId = await currentWorkspaceId();

    const task = await prisma.task.findFirst({
      where: { id: taskId, workspaceId },
      include: { steps: { orderBy: { order: "asc" } } },
    });
    if (!task) return { ok: false, reason: "not_found" };

    // Stepless tasks synthesize one event of this length; clamp to the same
    // 1..480 bound the Google single-task path enforces.
    const raw = Math.round(opts?.durationMin ?? DEFAULT_ICS_DURATION_MIN);
    const durationMin =
      Number.isFinite(raw) ? Math.min(480, Math.max(1, raw)) : DEFAULT_ICS_DURATION_MIN;

    const ics = buildTaskIcs({
      title: task.title,
      parentEmoji: task.parentEmoji,
      steps: task.steps.map((s) => ({
        text: s.text,
        estMinutes: s.estMinutes,
        subtaskEmoji: s.subtaskEmoji,
      })),
      fallbackDurationMin: durationMin,
    });

    // Mark + reward once (idempotent on scheduledAt). Re-downloads skip both.
    if (task.scheduledAt == null) {
      await prisma.task.update({
        where: { id: task.id },
        data: { scheduledAt: new Date(), scheduledVia: "ics" },
      });
      try {
        await logReward(workspaceId, RewardType.Scheduled);
        await awardBadge(workspaceId, BadgeKey.FirstSchedule);
      } catch {
        // Reward is a bonus; the .ics is the product. Never fail scheduling.
      }
      revalidatePath("/inbox");
      revalidatePath(`/tasks/${taskId}`);
    }

    return { ok: true, ics, icsFilename: icsFilename(task.title) };
  }
  ```
- [ ] Run: `npx vitest run src/app/actions/ics-schedule.test.ts` — expect PASS (all 6).
- [ ] Run: `npx tsc --noEmit` — expect PASS.
- [ ] Commit: `git add src/app/actions/ics-schedule.ts src/app/actions/ics-schedule.test.ts && git commit -m "feat(scheduling): scheduleViaIcs action — guest-allowed, mark + award once (#29)"`

---

### Task 4: Google paths set the provider-agnostic marker

**Files:**
- Modify: `src/app/actions/google-schedule.ts` (`pushStepsToGoogleTasks` ~lines 117–118; `scheduleSingleTask` update ~lines 210–213)
- Test: `src/app/actions/google-schedule.single.test.ts` (add one case)
- Test: Create `src/app/actions/google-schedule.push.test.ts`

**Interfaces:**
- Consumes: existing `pushStepsToGoogleTasks(taskId)` + `scheduleSingleTask(itemId, estMinutes)`; the loaded `task`/`item.task` now carry `scheduledAt`.
- Produces: on success, both paths set `Task.scheduledVia="google"` + `scheduledAt` (once, idempotent). `pushStepsToGoogleTasks` gates its reward on `scheduledAt == null` with an inner try/catch.

Steps:
- [ ] Add a failing case to `src/app/actions/google-schedule.single.test.ts` (inside the `describe("scheduleSingleTask")` block):
  ```ts
  it("sets the provider-agnostic scheduled marker (scheduledVia='google') on success", async () => {
    workspaceMock.mockResolvedValue(OWNER_WORKSPACE_ID);
    configuredMock.mockReturnValue(true);
    tokenMock.mockResolvedValue("tok");
    itemFindFirstMock.mockResolvedValue({
      id: "item-1",
      text: "Call the dentist",
      taskId: "task-1",
      task: { id: "task-1", scheduledAt: null },
    });
    findReclaimListMock.mockResolvedValue({ id: "list-9", title: "🗓 Reclaim" });
    createGoogleTaskMock.mockResolvedValue({ id: "gtask-9" });

    await scheduleSingleTask("item-1", 30);

    expect(taskUpdateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "task-1" },
        data: expect.objectContaining({ scheduledVia: "google", googleTaskId: "gtask-9" }),
      }),
    );
  });
  ```
- [ ] Create the failing test file `src/app/actions/google-schedule.push.test.ts`:
  ```ts
  import { describe, it, expect, vi, beforeEach } from "vitest";

  const {
    workspaceMock,
    revalidatePathMock,
    configuredMock,
    tokenMock,
    statusMock,
    findReclaimListMock,
    listTaskListsMock,
    createGoogleTaskMock,
    taskFindFirstMock,
    taskUpdateMock,
    stepFindFirstMock,
    stepUpdateMock,
    logRewardMock,
    awardBadgeMock,
  } = vi.hoisted(() => ({
    workspaceMock: vi.fn(),
    revalidatePathMock: vi.fn(),
    configuredMock: vi.fn(),
    tokenMock: vi.fn(),
    statusMock: vi.fn(),
    findReclaimListMock: vi.fn(),
    listTaskListsMock: vi.fn(),
    createGoogleTaskMock: vi.fn(),
    taskFindFirstMock: vi.fn(),
    taskUpdateMock: vi.fn(),
    stepFindFirstMock: vi.fn(),
    stepUpdateMock: vi.fn(),
    logRewardMock: vi.fn(),
    awardBadgeMock: vi.fn(),
  }));

  vi.mock("next/cache", () => ({ revalidatePath: revalidatePathMock }));
  vi.mock("@/lib/db", () => ({
    prisma: {
      task: { findFirst: taskFindFirstMock, update: taskUpdateMock },
      step: { findFirst: stepFindFirstMock, update: stepUpdateMock },
    },
  }));
  vi.mock("@/lib/rewards", () => ({ logReward: logRewardMock, awardBadge: awardBadgeMock }));
  vi.mock("@/lib/google", () => ({
    getValidAccessToken: tokenMock,
    googleConfigured: configuredMock,
    findReclaimList: findReclaimListMock,
    listTaskLists: listTaskListsMock,
    createGoogleTask: createGoogleTaskMock,
    getGoogleStatus: statusMock,
    disconnectGoogle: vi.fn(),
  }));
  vi.mock("@/lib/workspace", () => ({ currentWorkspaceId: workspaceMock }));

  import { OWNER_WORKSPACE_ID, RewardType, BadgeKey } from "@/lib/constants";
  import { pushStepsToGoogleTasks } from "./google-schedule";

  const baseTask = (over: Record<string, unknown> = {}) => ({
    id: "task-1",
    title: "T",
    parentEmoji: "🚀",
    scheduledAt: null,
    steps: [{ id: "s1", order: 1, text: "a", estMinutes: 10, subtaskEmoji: null }],
    ...over,
  });

  beforeEach(() => {
    vi.clearAllMocks();
    logRewardMock.mockResolvedValue(undefined);
    awardBadgeMock.mockResolvedValue(undefined);
    taskUpdateMock.mockResolvedValue({});
    stepUpdateMock.mockResolvedValue({});
    stepFindFirstMock.mockResolvedValue({ id: "s1" });
    configuredMock.mockReturnValue(true);
    tokenMock.mockResolvedValue("tok");
    findReclaimListMock.mockResolvedValue({ id: "list-9", title: "🗓 Reclaim" });
    createGoogleTaskMock.mockResolvedValue({ id: "g1" });
    workspaceMock.mockResolvedValue(OWNER_WORKSPACE_ID);
  });

  describe("pushStepsToGoogleTasks — provider-agnostic marker + reward-once", () => {
    it("marks the task scheduled + awards once on first push", async () => {
      taskFindFirstMock.mockResolvedValue(baseTask());
      const res = await pushStepsToGoogleTasks("task-1");
      expect(res.ok).toBe(true);
      expect(taskUpdateMock).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: "task-1" },
          data: expect.objectContaining({ scheduledVia: "google" }),
        }),
      );
      expect(logRewardMock).toHaveBeenCalledWith(OWNER_WORKSPACE_ID, RewardType.Scheduled);
      expect(awardBadgeMock).toHaveBeenCalledWith(OWNER_WORKSPACE_ID, BadgeKey.FirstSchedule);
    });

    it("does not re-award when the task is already scheduled (idempotent)", async () => {
      taskFindFirstMock.mockResolvedValue(baseTask({ scheduledAt: new Date() }));
      await pushStepsToGoogleTasks("task-1");
      expect(logRewardMock).not.toHaveBeenCalled();
      expect(awardBadgeMock).not.toHaveBeenCalled();
    });
  });
  ```
- [ ] Run: `npx vitest run src/app/actions/google-schedule.single.test.ts src/app/actions/google-schedule.push.test.ts` — expect FAIL (marker not set; reward not gated).
- [ ] Implement in `src/app/actions/google-schedule.ts`. In `pushStepsToGoogleTasks`, replace the two award lines:
  ```ts
      await logReward(workspaceId, RewardType.Scheduled);
      await awardBadge(workspaceId, BadgeKey.FirstSchedule);
  ```
  with the guarded marker + best-effort reward:
  ```ts
      // Provider-agnostic marker + reward once (mirrors scheduleViaIcs).
      if (task.scheduledAt == null) {
        await prisma.task.update({
          where: { id: task.id },
          data: { scheduledAt: new Date(), scheduledVia: "google" },
        });
        try {
          await logReward(workspaceId, RewardType.Scheduled);
          await awardBadge(workspaceId, BadgeKey.FirstSchedule);
        } catch {
          // Reward is best-effort; the Google push already succeeded.
        }
      }
  ```
- [ ] In `scheduleSingleTask`, fold the marker into the existing success update (~lines 210–213):
  ```ts
      await prisma.task.update({
        where: { id: taskId },
        data: {
          googleTaskId: created.id,
          googleTaskListId: list.id,
          ...(item.task?.scheduledAt == null
            ? { scheduledAt: new Date(), scheduledVia: "google" }
            : {}),
        },
      });
  ```
- [ ] Run: `npx vitest run src/app/actions/google-schedule.single.test.ts src/app/actions/google-schedule.push.test.ts` — expect PASS.
- [ ] Run: `npx tsc --noEmit` — expect PASS.
- [ ] Commit: `git add src/app/actions/google-schedule.ts src/app/actions/google-schedule.single.test.ts src/app/actions/google-schedule.push.test.ts && git commit -m "feat(scheduling): Google paths set provider-agnostic scheduled marker + award once (#29)"`

---

### Task 5: UI — actionable ICS control + Blob download

**Files:**
- Create: `src/lib/download-ics.ts`
- Test: `src/lib/download-ics.test.tsx`
- Modify: `src/lib/strings.ts` (after the `action.schedule` line ~44)
- Modify: `src/components/inbox/row-actions.tsx`
- Test: `src/components/inbox/row-actions.test.tsx`
- Modify: `src/components/inbox/inbox-view.tsx`
- Test: `src/components/inbox/inbox-view.test.tsx`

**Interfaces:**
- Produces:
  - `downloadIcs(ics: string, filename: string): void` — Blob download of an `.ics`.
  - `ScheduleControlProps.state` gains `"ics_ready_steps" | "ics_needs_duration"` and loses `"guest"`; new prop `onScheduleIcs?: (minutes?: number) => void`.
  - `RowActions` gains `scheduled?: boolean` (renders "Scheduled ✓"; wired fully in Task 6).
- Consumes: `scheduleViaIcs` (Task 3), `t("action.addToCalendar", voice)`.

Steps:
- [ ] Write failing test `src/lib/download-ics.test.tsx`:
  ```tsx
  // @vitest-environment jsdom
  import { describe, it, expect, vi, afterEach } from "vitest";
  import { downloadIcs } from "./download-ics";

  afterEach(() => vi.restoreAllMocks());

  describe("downloadIcs", () => {
    it("creates a blob URL and clicks an anchor with the given filename, then revokes", () => {
      const createURL = vi.fn(() => "blob:xyz");
      const revokeURL = vi.fn();
      (URL as unknown as { createObjectURL: unknown }).createObjectURL = createURL;
      (URL as unknown as { revokeObjectURL: unknown }).revokeObjectURL = revokeURL;
      let downloadedName = "";
      const clickSpy = vi
        .spyOn(HTMLAnchorElement.prototype, "click")
        .mockImplementation(function (this: HTMLAnchorElement) {
          downloadedName = this.download;
        });

      downloadIcs("BEGIN:VCALENDAR", "dlectroflow-plan.ics");

      expect(createURL).toHaveBeenCalledOnce();
      expect(clickSpy).toHaveBeenCalledOnce();
      expect(downloadedName).toBe("dlectroflow-plan.ics");
      expect(revokeURL).toHaveBeenCalledWith("blob:xyz");
    });
  });
  ```
- [ ] Run: `npx vitest run src/lib/download-ics.test.tsx` — expect FAIL (module missing).
- [ ] Implement `src/lib/download-ics.ts`:
  ```ts
  /** Trigger a client-side .ics download from raw calendar text. Imported only
   *  by client components (touches the DOM). */
  export function downloadIcs(ics: string, filename: string): void {
    const blob = new Blob([ics], { type: "text/calendar;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }
  ```
- [ ] Run: `npx vitest run src/lib/download-ics.test.tsx` — expect PASS.
- [ ] Add the voice string to `src/lib/strings.ts` immediately after the `"action.schedule"` line:
  ```ts
    "action.addToCalendar": { plain: "Add to calendar (.ics)", playful: "📅 Add to calendar (.ics)" },
  ```
- [ ] Add failing RTL tests to `src/components/inbox/row-actions.test.tsx` (append a new describe):
  ```tsx
  describe("ScheduleControl — ICS states", () => {
    it("ics_ready_steps: 📅 fires onScheduleIcs() immediately (icon variant, aria 'Add to calendar')", () => {
      const fn = vi.fn();
      render(<RowActions inline={[]} menu={[]} schedule={{ state: "ics_ready_steps", onScheduleIcs: fn }} />);
      fireEvent.click(screen.getByRole("button", { name: /add to calendar/i }));
      expect(fn).toHaveBeenCalledWith();
    });
    it("ics_needs_duration: opens the popover; picking 30 fires onScheduleIcs(30)", () => {
      const fn = vi.fn();
      render(<RowActions inline={[]} menu={[]} schedule={{ state: "ics_needs_duration", onScheduleIcs: fn }} />);
      fireEvent.click(screen.getByRole("button", { name: /add to calendar/i }));
      fireEvent.click(screen.getByRole("button", { name: /^30 min$/i }));
      expect(fn).toHaveBeenCalledWith(30);
    });
    it("menu variant renders the label and fires onScheduleIcs", () => {
      const fn = vi.fn();
      render(<ScheduleControl variant="menu" state="ics_ready_steps" onScheduleIcs={fn} label="Add to calendar (.ics)" />);
      fireEvent.click(screen.getByRole("button", { name: "Add to calendar (.ics)" }));
      expect(fn).toHaveBeenCalledWith();
    });
  });

  describe("RowActions — Scheduled indicator", () => {
    it("renders 'Scheduled ✓' when scheduled, hides it otherwise", () => {
      const { rerender } = render(<RowActions inline={[]} schedule={null} menu={[]} scheduled />);
      expect(screen.getByText(/scheduled ✓/i)).toBeInTheDocument();
      rerender(<RowActions inline={[]} schedule={null} menu={[]} />);
      expect(screen.queryByText(/scheduled ✓/i)).toBeNull();
    });
  });
  ```
- [ ] Run: `npx vitest run src/components/inbox/row-actions.test.tsx` — expect FAIL (ICS states + `scheduled` prop unimplemented).
- [ ] Implement `src/components/inbox/row-actions.tsx`:
  - Change the `state` union in `ScheduleControlProps` to:
    ```ts
    state: "ready_steps" | "needs_duration" | "connect" | "reconnect" | "ics_ready_steps" | "ics_needs_duration";
    ```
    and add the callback prop:
    ```ts
    /** ICS "Add to calendar" handler — called with the chosen minutes for a
     *  stepless task (ics_needs_duration) or with no args for a task with steps
     *  (ics_ready_steps). */
    onScheduleIcs?: (minutes?: number) => void;
    ```
  - In `ScheduleControl`, destructure `onScheduleIcs` from props; after `const isMenu = variant === "menu";` add:
    ```ts
    const isIcs = state === "ics_ready_steps" || state === "ics_needs_duration";
    const needsDuration = state === "needs_duration" || state === "ics_needs_duration";
    ```
  - Delete the entire `if (state === "guest") { ... }` block (lines ~84–103).
  - Primary button: set the accessible name + click routing:
    ```ts
    aria-label={isMenu ? undefined : isIcs ? "Add to calendar (.ics)" : "Schedule"}
    title={isMenu ? undefined : isIcs ? "Add to calendar (.ics)" : "Schedule"}
    aria-haspopup={needsDuration ? "dialog" : undefined}
    aria-expanded={needsDuration ? open : undefined}
    ...
    onClick={() => {
      if (state === "ready_steps") onScheduleSteps?.();
      else if (state === "ics_ready_steps") onScheduleIcs?.();
      else setOpen((o) => !o); // needs_duration | ics_needs_duration
    }}
    ```
  - Popover render condition: change `{state === "needs_duration" && open && (` to `{needsDuration && open && (`.
  - Preset button onClick: `onClick={() => { setOpen(false); if (isIcs) onScheduleIcs?.(minutes); else onScheduleSingle?.(minutes); }}`.
  - `fireCustom`: `if (isIcs) onScheduleIcs?.(customMinutes); else onScheduleSingle?.(customMinutes);` (keep the guard + `setOpen(false)` + `setCustom("")`).
  - In `RowActions`, add `scheduled = false` to the destructured props (type `scheduled?: boolean`) and render the badge as the first child of the action-line `<div>`:
    ```tsx
    {scheduled && (
      <span className="text-emerald-600 font-medium" title="Scheduled">
        Scheduled ✓
      </span>
    )}
    {inline}
    ```
- [ ] Run: `npx vitest run src/components/inbox/row-actions.test.tsx` — expect PASS (existing + new).
- [ ] Wire the inbox rows. In `src/components/inbox/inbox-view.tsx`:
  - Add imports: `import { scheduleViaIcs } from "@/app/actions/ics-schedule";` and `import { downloadIcs } from "@/lib/download-ics";`.
  - Add to `SCHEDULE_ERROR_MESSAGES`: `not_found: "This task couldn't be found."`.
  - After `runSchedule`, add the ICS runner + helpers (inside `InboxView`, they close over `startTransition`, `pending`, `router`, `setScheduleErrors`):
    ```ts
    const runScheduleIcs = (
      itemId: string,
      fn: () => Promise<
        | { ok: true; ics: string; icsFilename: string }
        | { ok: false; reason: string; message?: string }
      >,
    ) =>
      startTransition(async () => {
        setScheduleErrors((prev) => {
          if (!(itemId in prev)) return prev;
          const next = { ...prev };
          delete next[itemId];
          return next;
        });
        const res = await fn();
        if (res.ok) {
          downloadIcs(res.ics, res.icsFilename);
          router.refresh();
          return;
        }
        setScheduleErrors((prev) => ({
          ...prev,
          [itemId]: res.message ?? SCHEDULE_ERROR_MESSAGES[res.reason] ?? "Couldn't build the calendar file.",
        }));
      });

    // Guest primary control + owner ▾ alternative both use this. State depends
    // on whether the task already has steps (per-step events vs. one timed event).
    const icsProps = (item: Item): ScheduleControlProps => ({
      state: item.stepsTotal > 0 ? "ics_ready_steps" : "ics_needs_duration",
      onScheduleIcs: (minutes?: number) => {
        const tid = item.taskId; // guard, mirroring the multi-step Google wiring
        if (!tid) return;
        runScheduleIcs(item.id, () =>
          scheduleViaIcs(tid, minutes != null ? { durationMin: minutes } : undefined),
        );
      },
      pending,
    });

    const isIcsState = (s: ScheduleControlProps["state"]) =>
      s === "ics_ready_steps" || s === "ics_needs_duration";
    const scheduleMenuLabel = (s: ScheduleControlProps["state"]) =>
      isIcsState(s) ? t("action.addToCalendar", voice) : t("action.schedule", voice);
    ```
    Add `import type { Item } from "@/components/inbox/bucket";` if not already imported for the `icsProps` signature (the file already imports `Item` via the bucket import on line 46 — reuse it).
  - Replace every `: { state: "guest" }` guest branch (needsReview ~line 515, multiStep ~line 588, singleTask ~line 800) with `: icsProps(item)`.
  - In each bucket's `menu` array, change the existing schedule mirror label and add the owner-only ICS entry. Replace:
    ```tsx
    schedule ? (
      <ScheduleControl key="schedule-m" {...schedule} variant="menu" label={t("action.schedule", voice)} />
    ) : null,
    ```
    with:
    ```tsx
    schedule ? (
      <ScheduleControl key="schedule-m" {...schedule} variant="menu" label={scheduleMenuLabel(schedule.state)} />
    ) : null,
    effectiveGoogle ? (
      <ScheduleControl key="ics-m" variant="menu" {...icsProps(item)} label={t("action.addToCalendar", voice)} />
    ) : null,
    ```
    (multiStep ~line 743, singleTask ~line 865). For the needs-review `ItemRow`, add a prop `icsMenu?: React.ReactNode` and render it in `ItemRow`'s `menu` array right after the `schedule ? <ScheduleControl ... />` mirror; the mirror's label there also becomes `scheduleMenuLabel(schedule.state)`. Pass from the parent: `icsMenu={effectiveGoogle ? <ScheduleControl key="ics-m" variant="menu" {...icsProps(item)} label={t("action.addToCalendar", voice)} /> : null}`.
- [ ] Add failing RTL tests to `src/components/inbox/inbox-view.test.tsx`. Extend mocks (top of file):
  ```tsx
  const { scheduleViaIcsMock, downloadIcsMock } = vi.hoisted(() => ({
    scheduleViaIcsMock: vi.fn(),
    downloadIcsMock: vi.fn(),
  }));
  vi.mock("@/app/actions/ics-schedule", () => ({ scheduleViaIcs: scheduleViaIcsMock }));
  vi.mock("@/lib/download-ics", () => ({ downloadIcs: downloadIcsMock }));
  ```
  In `beforeEach`, add `scheduleViaIcsMock.mockResolvedValue({ ok: true, ics: "BEGIN:VCALENDAR", icsFilename: "dlectroflow-x.ics" });`. Then add the tests:
  ```tsx
  it("guest single-task row shows an enabled 'Add to calendar' that schedules via ICS + downloads", async () => {
    render(
      <InboxView
        initialItems={[makeItem({ id: "s1", text: "Call dentist", status: "triaged", taskId: "t-s1", stepsTotal: 0 })]}
        settings={settings}
        google={null}
      />,
    );
    const user = userEvent.setup();
    const btn = screen.getByRole("button", { name: /add to calendar/i });
    expect(btn).toBeEnabled();
    await user.click(btn);
    await user.click(screen.getByRole("button", { name: /^30 min$/i }));
    await waitFor(() =>
      expect(scheduleViaIcsMock).toHaveBeenCalledWith("t-s1", { durationMin: 30 }),
    );
    expect(downloadIcsMock).toHaveBeenCalledWith("BEGIN:VCALENDAR", "dlectroflow-x.ics");
  });

  it("owner ▾ menu offers 'Add to calendar (.ics)' as an alternative to Google", async () => {
    render(
      <InboxView
        initialItems={[makeItem({ id: "s1", status: "triaged", taskId: "t-s1", stepsTotal: 0 })]}
        settings={settings}
        google={{ configured: true, connected: true, needsReconnect: false }}
      />,
    );
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "All options" }));
    expect(screen.getByRole("button", { name: /add to calendar/i })).toBeInTheDocument();
  });
  ```
  (`waitFor` is already imported in this file — confirm; if not, add it to the `@testing-library/react` import.)
- [ ] Run: `npx vitest run src/components/inbox/inbox-view.test.tsx` — expect PASS (existing + new).
- [ ] Run: `npx tsc --noEmit && npx eslint src/components/inbox src/lib/download-ics.ts src/lib/strings.ts` — expect PASS.
- [ ] Commit: `git add src/lib/download-ics.ts src/lib/download-ics.test.tsx src/lib/strings.ts src/components/inbox/row-actions.tsx src/components/inbox/row-actions.test.tsx src/components/inbox/inbox-view.tsx src/components/inbox/inbox-view.test.tsx && git commit -m "feat(inbox): actionable ICS 'Add to calendar' for guests + owner ▾ alternative (#29)"`

---

### Task 6: "Scheduled ✓" indicator from `scheduledAt`

**Files:**
- Modify: `src/components/inbox/bucket.ts` (`Item` type ~line 7)
- Modify: `src/app/(app)/inbox/page.tsx` (mapping ~line 51)
- Modify: `src/components/inbox/inbox-view.tsx` (pass `scheduled` to rows)
- Test: `src/components/inbox/inbox-view.test.tsx` (extend `makeItem` + add cases)

**Interfaces:**
- Consumes: `RowActions.scheduled` (added in Task 5), `Item.scheduledAt`.
- Produces: `Item` gains `scheduledAt: Date | null`; rows render "Scheduled ✓" when set.

Steps:
- [ ] Add `scheduledAt: Date | null;` to the `Item` type in `src/components/inbox/bucket.ts` (next to `completedAt`).
- [ ] Thread it in `src/app/(app)/inbox/page.tsx`: in the `rawItems.map(...)` object, add `scheduledAt: task?.scheduledAt ?? null,` (alongside `taskStatus`/`completedAt`).
- [ ] Extend `makeItem` in `src/components/inbox/inbox-view.test.tsx` — add `scheduledAt: null,` to the base object (keeps every existing test type-correct). Add failing tests:
  ```tsx
  it("shows a 'Scheduled ✓' indicator on a row whose task has been scheduled", () => {
    render(
      <InboxView
        initialItems={[makeItem({ id: "s1", status: "triaged", taskId: "t-s1", stepsTotal: 0, scheduledAt: new Date() })]}
        settings={settings}
        google={null}
      />,
    );
    expect(screen.getByText(/scheduled ✓/i)).toBeInTheDocument();
  });
  it("no 'Scheduled ✓' indicator when scheduledAt is null", () => {
    render(
      <InboxView
        initialItems={[makeItem({ id: "s1", status: "triaged", taskId: "t-s1", stepsTotal: 0 })]}
        settings={settings}
        google={null}
      />,
    );
    expect(screen.queryByText(/scheduled ✓/i)).toBeNull();
  });
  ```
- [ ] Run: `npx vitest run src/components/inbox/inbox-view.test.tsx` — expect FAIL (rows don't pass `scheduled` yet).
- [ ] In `src/components/inbox/inbox-view.tsx`, pass `scheduled={item.scheduledAt != null}` to the `RowActions` in the multiStep (~line 653) and singleTask (~line 819) buckets, and pass `scheduled={item.scheduledAt != null}` into `ItemRow` (add an `ItemRow` prop `scheduled?: boolean` and forward it to that row's `RowActions`).
- [ ] Run: `npx vitest run src/components/inbox/inbox-view.test.tsx` — expect PASS.
- [ ] Run: `npx tsc --noEmit` — expect PASS.
- [ ] Commit: `git add src/components/inbox/bucket.ts "src/app/(app)/inbox/page.tsx" src/components/inbox/inbox-view.tsx src/components/inbox/inbox-view.test.tsx && git commit -m "feat(inbox): 'Scheduled ✓' row indicator from Task.scheduledAt (#29)"`

---

### Task 7: Re-route the breakdown-chat .ics link through `scheduleViaIcs`

**Files:**
- Modify: `src/components/breakdown/breakdown-chat.tsx` (the `.ics` `<a>` ~lines 244–249; imports ~line 9)
- Test: `src/components/breakdown/breakdown-chat.schedule.test.tsx` (add ICS mocks + one case)
- Modify: `src/components/breakdown/breakdown-chat.test.tsx` (add ICS mocks so the new imports resolve)

**Interfaces:**
- Consumes: `scheduleViaIcs` (Task 3), `downloadIcs` (Task 5).
- Produces: the breakdown-chat "Download calendar (.ics)" entry point now marks + rewards uniformly (no reward-split with the row path).

Steps:
- [ ] In BOTH `src/components/breakdown/breakdown-chat.schedule.test.tsx` and `src/components/breakdown/breakdown-chat.test.tsx`, add the mocks (near the other `vi.mock` calls) so the new client imports resolve under jsdom:
  ```tsx
  const { scheduleViaIcsMock, downloadIcsMock } = vi.hoisted(() => ({
    scheduleViaIcsMock: vi.fn(),
    downloadIcsMock: vi.fn(),
  }));
  vi.mock("@/app/actions/ics-schedule", () => ({ scheduleViaIcs: scheduleViaIcsMock }));
  vi.mock("@/lib/download-ics", () => ({ downloadIcs: downloadIcsMock }));
  ```
  In `breakdown-chat.schedule.test.tsx` `beforeEach`, add `scheduleViaIcsMock.mockResolvedValue({ ok: true, ics: "BEGIN:VCALENDAR", icsFilename: "dlectroflow-plan-the-party.ics" });`.
- [ ] Add a failing test to `src/components/breakdown/breakdown-chat.schedule.test.tsx`:
  ```tsx
  it("re-routes 'Download calendar (.ics)' through scheduleViaIcs (uniform reward) + downloads", async () => {
    await renderChat({ google: { configured: true, connected: true, needsReconnect: false } });
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /download calendar/i }));
    await waitFor(() => expect(scheduleViaIcsMock).toHaveBeenCalledWith("task-1"));
    expect(downloadIcsMock).toHaveBeenCalledWith("BEGIN:VCALENDAR", "dlectroflow-plan-the-party.ics");
  });
  ```
- [ ] Run: `npx vitest run src/components/breakdown/breakdown-chat.schedule.test.tsx` — expect FAIL (still an `<a>` link, no button/handler).
- [ ] Implement in `src/components/breakdown/breakdown-chat.tsx`:
  - Add imports: `import { scheduleViaIcs } from "@/app/actions/ics-schedule";` and `import { downloadIcs } from "@/lib/download-ics";`.
  - Add state + handler inside the component (near the other schedule handlers):
    ```ts
    const [icsBusy, setIcsBusy] = useState(false);
    async function addToCalendar() {
      setIcsBusy(true);
      try {
        const res = await scheduleViaIcs(taskId);
        if (res.ok) {
          downloadIcs(res.ics, res.icsFilename);
          router.refresh();
        }
      } finally {
        setIcsBusy(false);
      }
    }
    ```
  - Replace the `<a href={`/api/ics/${taskId}`} ...>⬇️ Download calendar (.ics)</a>` element (~lines 244–249) with:
    ```tsx
    <button
      type="button"
      onClick={addToCalendar}
      disabled={icsBusy}
      className="bg-primary text-primary-foreground inline-block rounded-md px-3 py-2 font-medium disabled:opacity-50"
    >
      {icsBusy ? "Preparing…" : "⬇️ Download calendar (.ics)"}
    </button>
    ```
- [ ] Run: `npx vitest run src/components/breakdown/breakdown-chat.schedule.test.tsx src/components/breakdown/breakdown-chat.test.tsx` — expect PASS.
- [ ] Run: `npx tsc --noEmit && npx eslint src/components/breakdown/breakdown-chat.tsx` — expect PASS.
- [ ] Commit: `git add src/components/breakdown/breakdown-chat.tsx src/components/breakdown/breakdown-chat.schedule.test.tsx src/components/breakdown/breakdown-chat.test.tsx && git commit -m "feat(breakdown): route .ics download through scheduleViaIcs for uniform rewards (#29)"`

---

## Final verification (run before wrap-up)
- [ ] `npx tsc --noEmit` — expect PASS.
- [ ] `npx eslint .` — expect PASS (no new warnings/errors).
- [ ] `npx vitest run` — expect the FULL suite green.

## Spec-coverage map (self-review)
- Data model marker (`scheduledAt`/`scheduledVia`) → Task 1.
- Builder single-event for stepless tasks → Task 2.
- `scheduleViaIcs` workspace-scoped, guest-allowed, IDOR-safe, idempotent, best-effort reward, no-steps durationMin → Task 3.
- Google path sets the same marker (both `pushStepsToGoogleTasks` + `scheduleSingleTask`) → Task 4.
- Guest 📅 → actionable "Add to calendar (.ics)"; owner ▾ alternative; Blob download → Task 5.
- "Scheduled ✓" per-row indicator → Task 6.
- Breakdown-chat .ics re-routed through the action for uniform rewards → Task 7.
- Tests (action unit, builder, RTL) + gates green → every task + Final verification.

## Resolved spec ambiguities
1. **Action return shape.** The spec §2 sketches `Promise<{ icsFilename; ics }>`; the task brief's Interfaces example uses a discriminated `{ ok }` union. Adopted the `{ ok: true; ics; icsFilename } | { ok: false; reason }` union (matches `GoogleScheduleResult` convention + gives the UI a clean not-found branch).
2. **Rows without a linked `Task`.** `scheduleViaIcs(taskId)` requires an existing Task (needed to store the marker + be IDOR-scoped). Many inbox rows (fresh captures, drag-triaged single tasks) have `taskId === null`. Resolution: the UI wires ICS on every schedulable row but guards on `item.taskId` (exactly the existing `const tid = item.taskId; if (tid) …` pattern already used for the multi-step Google button) — so the common intentional to-dos (broken-down multi-step tasks via "Break into steps", kept single-tasks via "Add to-do"/▶ Focus) all have a Task and work; raw no-task rows no-op, consistent with the codebase's accepted Google-path behavior. Full lazy-create-from-item for ICS is intentionally out of scope for S0 (keeps the spec's `taskId` signature verbatim).
3. **Google single-task reward.** `scheduleSingleTask` currently awards nothing. To stay "small" (Task 4) and avoid changing reward economics unexpectedly, it only sets the marker (drives "Scheduled ✓"); no new reward is added there. Reward-once gating (with inner try/catch) is applied to `pushStepsToGoogleTasks`, which already awarded.
4. **`fallbackDurationMin` vs. synthesizing a fake step.** The spec says "synthesize a single step". Implemented as a builder option that emits one event titled with the task title alone (no `"title: title"` duplication) — cleaner output, same single-VEVENT result, keeps the builder pure/testable.
5. **Guest reward visibility (spec open item).** Not addressed here (out of S0 scope); the "Scheduled ✓" indicator provides visible feedback regardless. Flag as a follow-up if a guest rewards surface is absent.
