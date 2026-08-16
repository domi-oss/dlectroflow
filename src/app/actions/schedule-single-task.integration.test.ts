/**
 * Real-Postgres proof that `scheduleSingleTask` creates at most one `Task` per
 * inbox item, however many callers reach it at once (#244).
 *
 * ## Why this file exists
 *
 * `src/lib/braindump-to-task.ts` names four writers that turn a `BrainDumpItem`
 * into a `Task`. #225 (`!306`) closed three of them — `keepAsTask`,
 * `ensureFocusStep` and `startBreakdown` — and its docblock recorded the fourth,
 * the lazy create inside `scheduleSingleTask`, as **outstanding rather than
 * quietly counted as safe**. This is that fourth one.
 *
 * The shape it had was `findFirst` → `if (!item.taskId)` → `$transaction(create,
 * link)`. The transaction made the two writes atomic with each other, which was
 * the point of the Duo round that added it, and it did nothing at all about the
 * decision that got them there: the `taskId` the `if` reads comes from a plain
 * `findFirst` taken **before** any lock exists. In READ COMMITTED a plain SELECT
 * does not wait on a row lock, it reads the last committed version — so a caller
 * whose read lands before a concurrent winner commits sees `taskId` as NULL,
 * enters the branch, and its `update` (whose `where` was `{ id }` alone)
 * cheerfully repoints the item at its own brand-new `Task` after the block
 * clears. Two `Task` rows, one of them reachable from no inbox row while
 * `focus/page.tsx`, `calendar-feed.ts` and `export/collect.ts` all still count
 * it, and any steps it carried gone with it.
 *
 * That is the unlocked check-then-act the siblings' docblocks describe, in the
 * one writer that still had it.
 *
 * ## Why a mock cannot show it
 *
 * The same reason `keep-as-task.integration.test.ts`,
 * `braindump-task-writers.integration.test.ts`, `reopen-item.integration.test.ts`
 * and `uncomplete-step.integration.test.ts` all exist: **the guard IS the lock.**
 * `google-schedule.single.test.ts` mocks `$transaction` as
 * `(fn) => fn(prisma)`, which runs the callback with no row lock to block on and
 * no rollback to demonstrate; the loser's `updateMany` would report `count: 1`
 * against a mock and `count: 0` against Postgres, and only the second is the
 * property being claimed. The *shapes* stay pinned in that file; the behaviour is
 * proved here.
 *
 * ## Why the interleaving is arranged and not hoped for
 *
 * Firing two calls with `Promise.all` and trusting them to overlap is not a
 * proof. `braindump-task-writers.integration.test.ts` measured that companion
 * passing against an UNFIXED writer and failing against another one in the same
 * file, same pool, same run — a warm connection pool serialises the two often
 * enough that the outcome says nothing either way. So the winner is held mid
 * transaction and released only once the action under test has **demonstrably**
 * blocked on its row lock, observed through `pg_blocking_pids`. See
 * {@link whileItemRowIsLockedWithATask}.
 *
 * ## What is stubbed, and what deliberately is not
 *
 * `@/lib/workspace` and `next/cache` (no request or cookie context exists outside
 * Next.js), `@/lib/google` (this is a database race; the Google round trip is not
 * under test) and `@/lib/rewards` (which is also how `awardFirstSchedule` is
 * neutralised — it calls `logReward`/`awardBadge` and nothing else).
 * **`@/lib/db` is the real client**, including the real `getSettings`, which is
 * why each workspace here is a real row.
 *
 * Isolation mirrors the sibling integration suites: a dedicated `PrismaClient`
 * for setup and assertions, so this file's own queries cannot interfere with the
 * singleton the action uses, and unique never-reused workspace ids wiped at both
 * ends.
 */

import {
  describe,
  it,
  expect,
  vi,
  beforeAll,
  beforeEach,
  afterAll,
} from "vitest";
import { PrismaClient } from "@prisma/client";
import { prismaErrorsDuring } from "@/lib/__tests__/prisma-error-log";
import { whileItemRowIsLockedWithATask } from "@/lib/__tests__/braindump-row-lock";

const WS = vi.hoisted(() => "itest-244-schedule-single");
/** A second workspace, so the IDOR spec proves the write's own scope. */
const OTHER_WS = vi.hoisted(() => "itest-244-schedule-single-other");
/**
 * The signed-in user the action resolves. `workspaceId` REFERENCES `WS` rather
 * than repeating its value (Duo review): `vi.hoisted` factories run in
 * declaration order, so this one can close over the constant above — and a second
 * copy of the id is a fixture that goes on passing while describing two different
 * workspaces, which for an IDOR spec is the failure that matters.
 */
const ME = vi.hoisted(() => ({
  id: "itest-244-user",
  role: "owner" as const,
  workspaceId: WS,
  provider: "gitlab",
  handle: "owner",
}));

vi.mock("@/lib/workspace", () => ({
  currentWorkspaceId: vi.fn().mockResolvedValue(WS),
  currentUser: vi.fn().mockResolvedValue(ME),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
// Every export `google-schedule.ts` imports, so the module replacement cannot
// leave a binding undefined for a path this file does not exercise.
vi.mock("@/lib/google", () => ({
  googleConfigured: vi.fn().mockReturnValue(true),
  getValidAccessToken: vi.fn().mockResolvedValue("test-token"),
  getGoogleStatus: vi.fn().mockResolvedValue({ needsReconnect: false }),
  findReclaimList: vi
    .fn()
    .mockResolvedValue({ id: "list-1", title: "Reclaim" }),
  upsertGoogleTask: vi.fn().mockResolvedValue({ id: "gtask-1", created: true }),
  listTaskLists: vi.fn(),
  createGoogleTask: vi.fn(),
  disconnectGoogle: vi.fn(),
}));
// Also neutralises `awardFirstSchedule`, whose only writes go through these two.
vi.mock("@/lib/rewards", () => ({
  // #233 — the ledger attributes a streak credit to the inbox item behind a
  // task. `null` is the ordinary answer for a task with no item, and is what
  // makes a credit permanent, so it is the right default for a file not asking
  // about attribution.
  itemIdForTask: vi.fn().mockResolvedValue(null),
  logReward: vi.fn().mockResolvedValue(undefined),
  awardBadge: vi.fn().mockResolvedValue(undefined),
  maybeAwardInboxZero: vi.fn().mockResolvedValue(undefined),
  maybeAwardTenStepsDay: vi.fn().mockResolvedValue(undefined),
  touchStreakOnCompletion: vi.fn().mockResolvedValue(null),
  touchStreakOnEngagement: vi.fn().mockResolvedValue(null),
  reverseItemCompletionRewards: vi.fn().mockResolvedValue(undefined),
}));

const prisma = new PrismaClient();

async function wipe() {
  for (const ws of [WS, OTHER_WS]) {
    await prisma.step.deleteMany({ where: { task: { workspaceId: ws } } });
    await prisma.brainDumpItem.deleteMany({ where: { workspaceId: ws } });
    await prisma.task.deleteMany({ where: { workspaceId: ws } });
    await prisma.settings.deleteMany({ where: { workspaceId: ws } });
    await prisma.workspace.deleteMany({ where: { id: ws } });
  }
}

/**
 * A triaged single to-do with no linked Task — the row the Single-task bucket
 * offers "Schedule" on, carrying the note and deadline the conversion has to
 * take across.
 */
function seedItem(workspaceId = WS) {
  return prisma.brainDumpItem.create({
    data: {
      text: "Water the plants",
      notes: "can under the sink",
      scheduleDueAt: new Date("2026-09-01T09:00:00.000Z"),
      workspaceId,
    },
  });
}

const tasksIn = (workspaceId = WS) =>
  prisma.task.findMany({
    where: { workspaceId },
    select: {
      id: true,
      title: true,
      notes: true,
      googleTaskId: true,
      scheduledAt: true,
    },
    orderBy: { createdAt: "asc" },
  });

const itemById = (id: string) =>
  prisma.brainDumpItem.findUnique({
    where: { id },
    select: { taskId: true },
  });

beforeAll(async () => {
  await wipe();
  await prisma.workspace.create({ data: { id: WS, kind: "owner" } });
  await prisma.workspace.create({ data: { id: OTHER_WS, kind: "owner" } });
});

beforeEach(async () => {
  for (const ws of [WS, OTHER_WS]) {
    await prisma.step.deleteMany({ where: { task: { workspaceId: ws } } });
    await prisma.brainDumpItem.deleteMany({ where: { workspaceId: ws } });
    await prisma.task.deleteMany({ where: { workspaceId: ws } });
  }
});

afterAll(async () => {
  await wipe();
  await prisma.$disconnect();
});

describe("scheduleSingleTask (real Postgres) — one schedule, one Task (#244)", () => {
  /**
   * The non-zero control. Every assertion below is a count that must stay at
   * one, and a count that can only ever read one proves nothing — this is the
   * spec that shows these reads can see a lazy create happen at all.
   */
  it("creates the Task on the first schedule, carrying the item's note across", async () => {
    const item = await seedItem();
    const { scheduleSingleTask } = await import("./google-schedule");

    expect(await scheduleSingleTask(item.id, 25)).toEqual({ ok: true });

    const tasks = await tasksIn();
    expect(tasks).toHaveLength(1);
    expect(tasks[0].title).toBe("Water the plants");
    expect(tasks[0].notes).toBe("can under the sink");
    expect(tasks[0].googleTaskId).toBe("gtask-1");
    expect(tasks[0].scheduledAt).not.toBeNull();
    expect(await itemById(item.id)).toEqual({ taskId: tasks[0].id });
  });

  /**
   * The Retry, not a double-tap: the first call has fully committed by the time
   * the second starts, exactly as it has when the inbox's ten-second client
   * timeout is followed by a press of the notice's Retry.
   *
   * This one passes against the unfixed action too — the second `findFirst` is
   * served after the first commit and reads the link. It is here because it is
   * the *ordinary* way a second call arrives, and a regression that broke it
   * would otherwise only be caught by the contended spec below.
   */
  it("adopts the Task a landed schedule already made when the user retries", async () => {
    const item = await seedItem();
    const { scheduleSingleTask } = await import("./google-schedule");

    expect(await scheduleSingleTask(item.id, 25)).toEqual({ ok: true });
    expect(await scheduleSingleTask(item.id, 25)).toEqual({ ok: true });

    const tasks = await tasksIn();
    expect(tasks).toHaveLength(1);
    expect(await itemById(item.id)).toEqual({ taskId: tasks[0].id });
  });

  /**
   * THE test, and the one that fails on the pre-fix action.
   *
   * The contended path with the interleaving arranged — see
   * {@link whileItemRowIsLockedWithATask}. The loser has to come back and read the
   * winner's `taskId` rather than carry on with the NULL its snapshot held before
   * the winner committed.
   *
   * Measured against the unfixed action: two `Task` rows, the item pointing at
   * the loser's, and the winner's left reachable from nothing.
   */
  it("adopts the winner's Task when it loses the race for the row", async () => {
    const item = await seedItem();
    const { scheduleSingleTask } = await import("./google-schedule");

    let outcome!: {
      winner: string;
      result: Awaited<ReturnType<typeof scheduleSingleTask>>;
    };
    const errors = await prismaErrorsDuring(async () => {
      outcome = await whileItemRowIsLockedWithATask(
        prisma,
        { itemId: item.id, workspaceId: WS },
        () => scheduleSingleTask(item.id, 25),
      );
    });

    // A lost race is a no-op on the create, not an error to put in front of
    // somebody who pressed a button twice — the schedule itself still succeeds,
    // against the Task that already exists.
    expect(errors).toEqual([]);
    expect(outcome.result).toEqual({ ok: true });
    const tasks = await tasksIn();
    expect(tasks).toHaveLength(1);
    expect(tasks[0].id).toBe(outcome.winner);
    expect(await itemById(item.id)).toEqual({ taskId: outcome.winner });
    // And the schedule landed on the ADOPTED task, not on a discarded one.
    expect(tasks[0].googleTaskId).toBe("gtask-1");
  });

  /**
   * The unarranged companion: two schedules fired together. It cannot be trusted
   * on its own — `braindump-task-writers.integration.test.ts` measured the same
   * shape passing against an unfixed writer, because a warm pool serialises the
   * two — so it is here to show the ordinary double press raises nothing, never
   * as the proof that the guard works. That is the spec above.
   */
  it("neither raises nor creates a second Task when two schedules collide", async () => {
    const item = await seedItem();
    const { scheduleSingleTask } = await import("./google-schedule");

    const errors = await prismaErrorsDuring(async () => {
      const [a, b] = await Promise.all([
        scheduleSingleTask(item.id, 25),
        scheduleSingleTask(item.id, 25),
      ]);
      expect(a).toEqual({ ok: true });
      expect(b).toEqual({ ok: true });
    });

    expect(errors).toEqual([]);
    expect(await tasksIn()).toHaveLength(1);
  });

  /**
   * The scope travels with the write, not with the read above it. `updateMany`'s
   * `where` carries `workspaceId`, so an item id belonging to somebody else is
   * "not found" rather than a row this workspace can repoint.
   */
  it("refuses another workspace's item and creates nothing", async () => {
    const item = await seedItem(OTHER_WS);
    const { scheduleSingleTask } = await import("./google-schedule");

    expect(await scheduleSingleTask(item.id, 25)).toEqual({
      ok: false,
      reason: "error",
      message: "Item not found",
    });

    expect(await tasksIn(WS)).toEqual([]);
    expect(await tasksIn(OTHER_WS)).toEqual([]);
    expect(await itemById(item.id)).toEqual({ taskId: null });
  });
});
