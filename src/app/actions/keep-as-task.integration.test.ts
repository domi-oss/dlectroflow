/**
 * Real-Postgres proof for the SERVER half of #225's double-press guard
 * (!306, Duo review round 13).
 *
 * The client-side guard in `inbox-view.tsx` keys `inFlight` per write target,
 * so a second press while the first is running is absorbed. What it cannot
 * cover is the press that comes AFTER: `withActionTimeout` gives up at ten
 * seconds and the `finally` releases the guard, but a server action cannot be
 * aborted from the client — the call may still be in flight, and may still
 * land. The notice says exactly that ("this may already have gone through")
 * and offers a Retry, so a user who takes it fires a SECOND `keepAsTask` at a
 * row that already has its Task.
 *
 * Before the fix that created a second one. `keepAsTask` was
 * `findFirst`-then-`task.create` with no precondition at all — the only one of
 * the four brain-dump→task writers without one (`startBreakdown` and
 * `ensureFocusStep` both check `item.taskId` first) — so the item's `taskId`
 * was repointed at the new row and the first Task was left behind, reachable
 * from no inbox row but still counted by the focus lanes, the ICS feed and the
 * data export.
 *
 * **Neither property can be shown with a mock.** A mocked `$transaction` runs
 * its callback with no row lock and no rollback to demonstrate, which is the
 * same reason `reopen-item.integration.test.ts` and
 * `uncomplete-step.integration.test.ts` exist; and the guard here IS the lock —
 * Postgres re-evaluates a blocked `UPDATE` against the committed row and
 * `RETURNING` hands back that new version, which is how the loser of a race
 * learns the winner's `taskId`. The mocked shapes live in
 * `request-breakdown.test.ts`; the behaviour is proved here.
 *
 * Only `@/lib/workspace`, `next/cache` and `@/lib/rewards` are stubbed (no
 * request or cookie context exists outside Next.js, and the badge/points side
 * is not what is under test). `@/lib/db`'s client is the real one.
 *
 * Isolation mirrors `delete-braindump-item.integration.test.ts`: a dedicated
 * `PrismaClient` for setup and assertions, so this file's own queries cannot
 * interfere with the singleton the action uses, and a unique never-reused
 * workspace id wiped at both ends.
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
import { BrainDumpStatus, TaskStatus } from "@/lib/constants";

const WS = vi.hoisted(() => "itest-225-keep-as-task");
/** A second workspace, so the IDOR spec proves the write's own scope. */
const OTHER_WS = vi.hoisted(() => "itest-225-keep-as-task-other");

vi.mock("@/lib/workspace", () => ({
  currentWorkspaceId: vi.fn().mockResolvedValue(WS),
  currentUser: vi.fn().mockResolvedValue(null),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
// Every export `braindump.ts` imports, so the module replacement cannot leave a
// binding undefined for a path this file does not exercise.
vi.mock("@/lib/rewards", () => ({
  maybeAwardInboxZero: vi.fn().mockResolvedValue(undefined),
  maybeAwardTenStepsDay: vi.fn().mockResolvedValue(undefined),
  logReward: vi.fn().mockResolvedValue(undefined),
  awardBadge: vi.fn().mockResolvedValue(undefined),
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
    await prisma.workspace.deleteMany({ where: { id: ws } });
  }
}

/** An untriaged capture, with the note and deadline triage has to carry across. */
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
    select: { id: true, title: true, notes: true },
    orderBy: { createdAt: "asc" },
  });

const itemById = (id: string) =>
  prisma.brainDumpItem.findUnique({
    where: { id },
    select: { taskId: true, status: true, breakdownRequestedAt: true },
  });

describe("keepAsTask (real Postgres) — one press, one Task (#225)", () => {
  beforeAll(async () => {
    await wipe();
    await prisma.workspace.create({ data: { id: WS, kind: "owner" } });
    await prisma.workspace.create({ data: { id: OTHER_WS, kind: "owner" } });
  });

  beforeEach(async () => {
    await prisma.step.deleteMany({ where: { task: { workspaceId: WS } } });
    await prisma.brainDumpItem.deleteMany({ where: { workspaceId: WS } });
    await prisma.task.deleteMany({ where: { workspaceId: WS } });
  });

  afterAll(async () => {
    await wipe();
    await prisma.$disconnect();
  });

  /**
   * The non-zero control. Every assertion below is a count that must stay at
   * one, and a count that can only ever read one proves nothing — this is the
   * spec that shows these reads can see a triage happen at all.
   */
  it("creates the Task on the first press, carrying the item's note across", async () => {
    const item = await seedItem();
    const { keepAsTask } = await import("./braindump");

    const taskId = await keepAsTask(item.id);

    const tasks = await tasksIn();
    expect(tasks).toHaveLength(1);
    expect(tasks[0].notes).toBe("can under the sink");
    expect(taskId).toBe(tasks[0].id);
    expect(await itemById(item.id)).toEqual({
      taskId: tasks[0].id,
      status: BrainDumpStatus.Triaged,
      breakdownRequestedAt: null,
    });
  });

  /**
   * THE test, and the one that fails on the pre-fix action.
   *
   * Sequential on purpose — this is the Retry, not a double-tap. The first call
   * has fully committed by the time the second starts, exactly as it has when a
   * ten-second client timeout is followed by a press of the button the notice
   * offers.
   */
  it("adopts the Task a landed write already made when the user retries", async () => {
    const item = await seedItem();
    const { keepAsTask } = await import("./braindump");

    const first = await keepAsTask(item.id);
    const second = await keepAsTask(item.id);

    expect(await tasksIn()).toHaveLength(1);
    // The retry answers with the same Task rather than silently making another:
    // an action whose second call disagrees with its first is not idempotent,
    // it just hides the extra row from this caller.
    expect(second).toBe(first);
    expect((await itemById(item.id))?.taskId).toBe(first);
  });

  /**
   * The contended path: two presses that genuinely overlap, so the second
   * blocks on the first's row lock. Postgres re-evaluates the blocked `UPDATE`
   * against the committed row and `RETURNING` hands back that version, which is
   * where the loser reads the winner's `taskId` — the mechanism the fix relies
   * on, and the one a mock cannot stand in for.
   *
   * Honest about what it can prove: if the query engine serialises the two
   * (which it does on a warm pool), the second caller simply runs after the
   * first and adopts for the same reason the spec above does. It is a companion
   * to that one, never a substitute.
   */
  it("neither raises nor creates a second Task when two presses collide", async () => {
    const item = await seedItem();
    const { keepAsTask } = await import("./braindump");

    let both: (string | undefined)[] = [];
    const errors = await prismaErrorsDuring(async () => {
      both = await Promise.all([keepAsTask(item.id), keepAsTask(item.id)]);
    });

    // A duplicate press is a no-op, not an error to put in front of somebody
    // who pressed a button twice.
    expect(errors).toEqual([]);
    const tasks = await tasksIn();
    expect(tasks).toHaveLength(1);
    expect(both).toEqual([tasks[0].id, tasks[0].id]);
    expect((await itemById(item.id))?.taskId).toBe(tasks[0].id);
  });

  /**
   * The same defect reached without any race at all, and the reason the guard
   * is `taskId` rather than `status`.
   *
   * ▶ Focus (`ensureFocusStep`) gives an item a Task without triaging it, and
   * `moveToReview` un-triages an item while deliberately keeping its Task —
   * "so re-triaging reuses the same breakdown", in its own words. Pressing
   * "Add to-do" afterwards used to build a second Task and repoint the item at
   * it, stranding the steps the first one carried. The item still has to become
   * triaged; what it must not do is acquire a new Task to do it.
   */
  it("adopts the Task the item already has instead of stranding its steps", async () => {
    const item = await seedItem();
    const task = await prisma.task.create({
      data: { title: "Water the plants", workspaceId: WS },
    });
    await prisma.step.create({
      data: {
        taskId: task.id,
        text: "fill the can",
        order: 1,
        total: 1,
        estMinutes: 5,
      },
    });
    await prisma.brainDumpItem.update({
      where: { id: item.id },
      data: { taskId: task.id, status: BrainDumpStatus.Inbox },
    });
    const { keepAsTask } = await import("./braindump");

    const taskId = await keepAsTask(item.id);

    expect(taskId).toBe(task.id);
    expect(await tasksIn()).toHaveLength(1);
    expect(await itemById(item.id)).toEqual({
      taskId: task.id,
      status: BrainDumpStatus.Triaged,
      breakdownRequestedAt: null,
    });
    // The whole point of adopting: the breakdown survives the second press.
    expect(await prisma.step.count({ where: { taskId: task.id } })).toBe(1);
  });

  /**
   * The scoping invariant, proved against the write itself rather than against
   * a read in front of it: the guarded `updateMany` carries `workspaceId` in
   * its own `where`, so another workspace's id matches nothing and no Task is
   * created for it.
   */
  it("no-ops on an item belonging to another workspace", async () => {
    const foreign = await seedItem(OTHER_WS);
    const { keepAsTask } = await import("./braindump");

    await expect(keepAsTask(foreign.id)).resolves.toBeUndefined();

    expect(await tasksIn(OTHER_WS)).toHaveLength(0);
    expect(
      (
        await prisma.brainDumpItem.findUnique({
          where: { id: foreign.id },
          select: { status: true, taskId: true },
        })
      )?.status,
    ).toBe(BrainDumpStatus.Inbox);
  });

  /** A missing row is a no-op, not a throw — the pre-fix `if (!item) return`. */
  it("no-ops on an item that no longer exists", async () => {
    const { keepAsTask } = await import("./braindump");
    await expect(keepAsTask("does-not-exist")).resolves.toBeUndefined();
    expect(await tasksIn()).toHaveLength(0);
  });

  /** The adopted Task is left alone — adopting is not a second conversion. */
  it("does not rewrite the adopted Task", async () => {
    const item = await seedItem();
    const { keepAsTask } = await import("./braindump");
    const taskId = await keepAsTask(item.id);
    await prisma.task.update({
      where: { id: taskId! },
      data: { title: "Water the plants (renamed)", status: TaskStatus.Done },
    });

    await keepAsTask(item.id);

    const [task] = await tasksIn();
    expect(task.title).toBe("Water the plants (renamed)");
  });
});
