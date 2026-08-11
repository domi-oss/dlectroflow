/**
 * Real-Postgres proof that ALL the brain-dump→Task writers create at most one
 * Task per item, not just the one Duo happened to ask about (!306, substitute
 * review).
 *
 * `keep-as-task.integration.test.ts` closes `keepAsTask` and its docblock says
 * why the guard has to be the write's own rather than a read in front of it:
 * "autocommit would release the lock the moment the stamp landed, and the second
 * caller would read `taskId` as NULL because the first has not created its Task
 * yet. That window is the whole defect."
 *
 * The same docblock then excuses the other three writers as already safe —
 * "`startBreakdown` and `ensureFocusStep` both check `item.taskId` first". They
 * do check it. They check it with a `findFirst` outside any transaction, which is
 * the unlocked check-then-act that paragraph had just finished describing as the
 * defect. So the reasoning was right and the conclusion drawn from it was wrong,
 * and both actions could still build a second `Task` and repoint the item at it,
 * leaving the first reachable from no inbox row while `focus/page.tsx`,
 * `calendar-feed.ts` and `export/collect.ts` all still counted it.
 *
 * Reachable the same three ways `keepAsTask` was, all of them now live because
 * !306 puts these two behind the notice's Retry as well:
 *
 * 1. **Retry after a timeout.** `withActionTimeout` bounds the wait, not the
 *    request, so the notice's Retry can fire a second call at a row whose first
 *    one is still going or has already landed.
 * 2. **A double press.** Before !306 neither had any client guard at all.
 * 3. **Two tabs**, which no in-memory guard can span and only the write can.
 *
 * **Neither property can be shown with a mock**, for the reason the sibling file
 * gives: a mocked `$transaction` runs its callback with no row lock and nothing
 * to roll back, and the guard here IS the lock.
 *
 * Only `@/lib/workspace`, `next/cache` and `@/lib/rewards` are stubbed — no
 * request or cookie context exists outside Next.js, and the badge/points side is
 * not what is under test. `@/lib/db`'s client is the real one.
 *
 * Isolation mirrors the sibling file: a dedicated `PrismaClient` for setup and
 * assertions so this file's own queries cannot interfere with the singleton the
 * actions use, and a unique never-reused workspace id wiped at both ends.
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
import { BrainDumpStatus } from "@/lib/constants";

const WS = vi.hoisted(() => "itest-225-task-writers");
/** A second workspace, so each IDOR spec proves the write's own scope. */
const OTHER_WS = vi.hoisted(() => "itest-225-task-writers-other");

vi.mock("@/lib/workspace", () => ({
  currentWorkspaceId: vi.fn().mockResolvedValue(WS),
  currentUser: vi.fn().mockResolvedValue(null),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
// Every export the two modules import, so the replacement cannot leave a binding
// undefined for a path this file does not exercise.
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

/** An untriaged capture, with the note and deadline the conversion must carry. */
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
    select: { taskId: true, status: true },
  });

/**
 * Steps belonging to THIS file's workspace only.
 *
 * Scoped rather than a bare `step.count()`, because the integration suites share
 * one Postgres schema per worktree and run concurrently: an unscoped count reads
 * `uncomplete-step.integration.test.ts`'s rows too and fails for reasons that
 * have nothing to do with the action under test. Caught exactly that way.
 */
const stepsIn = (workspaceId = WS) =>
  prisma.step.findMany({
    where: { task: { workspaceId } },
    select: { id: true, taskId: true },
  });

/**
 * Is some other session blocked specifically by `holderPid`?
 *
 * The barrier the contention spec below waits on, and the reason it is a proof
 * rather than a hope. Firing two calls at once and trusting them to overlap does
 * not work: measured on this file, the `Promise.all` companions pass against the
 * UNFIXED `ensureFocusStep` and fail against the unfixed `startBreakdown` — same
 * file, same pool, same run — so whether the interleaving happens is not
 * something a spec can assume either way. `reopen-item.integration.test.ts`
 * reached the same conclusion and arranged its interleaving too.
 *
 * `pg_blocking_pids` rather than a count of sessions in `wait_event_type =
 * 'Lock'`, because this database is shared: up to forty worktrees run their
 * integration suites against it on separate schemas, so a database-wide count of
 * blocked sessions can be satisfied by somebody else's test entirely — which
 * would release the lock before the action under test ever reached it and quietly
 * turn this spec back into the sequential one. Naming the holder's own pid is
 * what makes the observation about this test.
 */
async function isBlockedBy(holderPid: number): Promise<boolean> {
  const [row] = await prisma.$queryRaw<{ blocked: bigint }[]>`
    SELECT count(*)::bigint AS blocked
    FROM pg_stat_activity
    WHERE pid <> ${holderPid}
      AND ${holderPid} = ANY(pg_blocking_pids(pid))`;
  return Number(row.blocked) > 0;
}

/** Poll until the action has demonstrably blocked on the holder, or fail saying
 *  so. A block that never appears means the action took no lock, and the spec
 *  has to say that rather than quietly assert something weaker. */
async function waitUntilBlockedBy(holderPid: number): Promise<void> {
  for (let i = 0; i < 200; i += 1) {
    if (await isBlockedBy(holderPid)) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(
    `nothing ever blocked on pid ${holderPid}'s row lock — the action under ` +
      "test did not take one, so this spec cannot prove the loser adopts",
  );
}

/**
 * Run `act` while the item's row is held locked by a transaction that has
 * already given it a Task, and release the lock only once `act` has demonstrably
 * blocked on it.
 *
 * This is the interleaving the fix exists for, arranged rather than hoped for:
 * the action reaches its guarded write, blocks, and when it unblocks Postgres
 * re-evaluates the `UPDATE` against the COMMITTED row — so the `taskId` it reads
 * back is the winner's. Against a `findFirst` outside any transaction the same
 * arrangement is a deterministic failure instead: that read is served from a
 * snapshot taken before the commit, so it sees `taskId` as NULL and creates a
 * second Task.
 *
 * Returns the winner's task id so the caller can assert the loser adopted it.
 */
async function whileRowIsLockedWithATask<T>(
  itemId: string,
  act: () => Promise<T>,
): Promise<{ winner: string; result: T }> {
  let release = () => {};
  const held = new Promise<void>((resolve) => (release = resolve));
  let announceLocked = () => {};
  const locked = new Promise<void>((resolve) => (announceLocked = resolve));
  let winner = "";

  let holderPid = 0;
  const holder = prisma.$transaction(
    async (tx) => {
      const [{ pid }] = await tx.$queryRaw<{ pid: number }[]>`
        SELECT pg_backend_pid() AS pid`;
      holderPid = pid;
      const task = await tx.task.create({
        data: { title: "Water the plants", workspaceId: WS },
      });
      winner = task.id;
      // Takes the row lock this spec is about, and gives the row the `taskId`
      // the loser has to come back and read.
      await tx.brainDumpItem.update({
        where: { id: itemId },
        data: { taskId: task.id },
      });
      announceLocked();
      await held;
    },
    // Generous: the timeout has to outlast the poll below, and a transaction
    // that times out here would look like the defect rather than like a slow
    // machine.
    { timeout: 30_000, maxWait: 30_000 },
  );

  await locked;
  const running = act();
  await waitUntilBlockedBy(holderPid);
  release();
  await holder;
  return { winner, result: await running };
}

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

describe("ensureFocusStep (real Postgres) — one ▶ Focus, one Task (#225)", () => {
  /**
   * The non-zero control. Every assertion below is a count that must stay at
   * one, and a count that can only ever read one proves nothing — this is the
   * spec that shows these reads can see ▶ Focus build a task at all.
   */
  it("creates the Task and its one step on the first press, note included", async () => {
    const item = await seedItem();
    const { ensureFocusStep } = await import("./braindump");

    const stepId = await ensureFocusStep(item.id);

    const tasks = await tasksIn();
    expect(tasks).toHaveLength(1);
    expect(tasks[0].notes).toBe("can under the sink");
    expect((await itemById(item.id))?.taskId).toBe(tasks[0].id);
    const steps = await prisma.step.findMany({
      where: { taskId: tasks[0].id },
    });
    expect(steps).toHaveLength(1);
    expect(steps[0].id).toBe(stepId);
  });

  /**
   * THE test, and the one that fails on the pre-fix action.
   *
   * Sequential on purpose — this is the Retry the notice now offers, not a
   * double-tap. The first call has fully committed by the time the second
   * starts, exactly as it has when a ten-second client timeout is followed by a
   * press of the button.
   */
  it("adopts the Task a landed press already made when the user retries", async () => {
    const item = await seedItem();
    const { ensureFocusStep } = await import("./braindump");

    const first = await ensureFocusStep(item.id);
    const second = await ensureFocusStep(item.id);

    expect(await tasksIn()).toHaveLength(1);
    // Same task, and the same STEP: a second step would put the timer on a
    // duplicate of work the user is already part-way through.
    expect(second).toBe(first);
    expect(await stepsIn()).toHaveLength(1);
  });

  /**
   * The contended path, with the interleaving arranged — see
   * {@link whileRowIsLockedWithATask}. The loser of the race has to come back
   * and read the winner's `taskId` rather than carry on with the NULL it saw
   * before the winner committed.
   */
  it("adopts the winner's Task when it loses the race for the row", async () => {
    const item = await seedItem();
    const { ensureFocusStep } = await import("./braindump");

    let outcome!: { winner: string; result: string | null };
    const errors = await prismaErrorsDuring(async () => {
      outcome = await whileRowIsLockedWithATask(item.id, () =>
        ensureFocusStep(item.id),
      );
    });

    // A lost race is a no-op, not an error to put in front of somebody who
    // pressed a button twice.
    expect(errors).toEqual([]);
    const tasks = await tasksIn();
    expect(tasks).toHaveLength(1);
    expect(tasks[0].id).toBe(outcome.winner);
    expect((await itemById(item.id))?.taskId).toBe(outcome.winner);
    // It still owes the caller a step to focus, and that step belongs to the
    // adopted Task rather than to one of its own.
    const steps = await stepsIn();
    expect(steps).toHaveLength(1);
    expect(steps[0].taskId).toBe(outcome.winner);
    expect(outcome.result).toBe(steps[0].id);
  });

  /**
   * The unarranged companion: two presses fired together. It cannot be trusted
   * on its own — measured on this file, it passes against the unfixed action
   * because a warm pool serialises the two — so it is here to show the ordinary
   * double press raises nothing, never as the proof that the guard works. That
   * is the spec above.
   */
  it("neither raises nor creates a second Task when two presses collide", async () => {
    const item = await seedItem();
    const { ensureFocusStep } = await import("./braindump");

    let both: (string | null)[] = [];
    const errors = await prismaErrorsDuring(async () => {
      both = await Promise.all([
        ensureFocusStep(item.id),
        ensureFocusStep(item.id),
      ]);
    });

    expect(errors).toEqual([]);
    const tasks = await tasksIn();
    expect(tasks).toHaveLength(1);
    expect(await stepsIn()).toHaveLength(1);
    expect(both[0]).toBe(both[1]);
  });

  /**
   * ▶ Focus must not triage. `keepAsTask`'s guard is on `taskId` rather than on
   * `status` precisely because this action gives an item a Task while leaving it
   * in the review queue, and a status-shaped guard would have refused it.
   */
  it("leaves the item untriaged — a Task is not a triage", async () => {
    const item = await seedItem();
    const { ensureFocusStep } = await import("./braindump");

    await ensureFocusStep(item.id);

    expect((await itemById(item.id))?.status).toBe(BrainDumpStatus.Inbox);
  });

  /**
   * The boundary of what this file proves, asserted so it cannot be mistaken for
   * more. Two concurrent calls against an item that already has a Task with NO
   * steps take no lock — neither enters the create-and-link block — so both can
   * create a step. That is recorded in `ensureFocusStep`'s doc comment as
   * outstanding, with the two instruments that would close it; this spec pins the
   * SEQUENTIAL case, which is the one the action does guarantee, so a future fix
   * has a passing test to keep passing.
   */
  it("adds no second step when called twice on a task that had none", async () => {
    const item = await seedItem();
    const task = await prisma.task.create({
      data: { title: "Water the plants", workspaceId: WS },
    });
    await prisma.brainDumpItem.update({
      where: { id: item.id },
      data: { taskId: task.id },
    });
    const { ensureFocusStep } = await import("./braindump");

    const first = await ensureFocusStep(item.id);
    const second = await ensureFocusStep(item.id);

    expect(second).toBe(first);
    expect(await stepsIn()).toHaveLength(1);
  });

  it("reuses the task's existing steps rather than adding another", async () => {
    const item = await seedItem();
    const task = await prisma.task.create({
      data: { title: "Water the plants", workspaceId: WS },
    });
    const step = await prisma.step.create({
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
      data: { taskId: task.id },
    });
    const { ensureFocusStep } = await import("./braindump");

    expect(await ensureFocusStep(item.id)).toBe(step.id);
    expect(await tasksIn()).toHaveLength(1);
    expect(await stepsIn()).toHaveLength(1);
  });

  /** The scoping invariant, proved against the write itself. */
  it("no-ops on an item belonging to another workspace", async () => {
    const foreign = await seedItem(OTHER_WS);
    const { ensureFocusStep } = await import("./braindump");

    await expect(ensureFocusStep(foreign.id)).resolves.toBeNull();

    expect(await tasksIn(OTHER_WS)).toHaveLength(0);
    expect((await itemById(foreign.id))?.taskId).toBeNull();
  });

  it("no-ops on an item that no longer exists", async () => {
    const { ensureFocusStep } = await import("./braindump");
    await expect(ensureFocusStep("does-not-exist")).resolves.toBeNull();
    expect(await tasksIn()).toHaveLength(0);
  });
});

describe("startBreakdown (real Postgres) — one press, one Task (#225)", () => {
  /** The non-zero control, as above. */
  it("creates the Task and triages the item on the first press", async () => {
    const item = await seedItem();
    const { startBreakdown } = await import("./breakdown");

    const taskId = await startBreakdown(item.id);

    const tasks = await tasksIn();
    expect(tasks).toHaveLength(1);
    expect(tasks[0].notes).toBe("can under the sink");
    expect(taskId).toBe(tasks[0].id);
    expect(await itemById(item.id)).toEqual({
      taskId: tasks[0].id,
      status: BrainDumpStatus.Triaged,
    });
  });

  /** THE test — the Retry the notice now offers for this write too. */
  it("adopts the Task a landed press already made when the user retries", async () => {
    const item = await seedItem();
    const { startBreakdown } = await import("./breakdown");

    const first = await startBreakdown(item.id);
    const second = await startBreakdown(item.id);

    expect(await tasksIn()).toHaveLength(1);
    expect(second).toBe(first);
    expect((await itemById(item.id))?.taskId).toBe(first);
  });

  /**
   * The contended path with the interleaving arranged — see
   * {@link whileRowIsLockedWithATask}. The loser has to come back and read the
   * winner's `taskId` rather than carry on with the NULL it saw first, and it
   * still owes the caller a triage.
   */
  it("adopts the winner's Task when it loses the race for the row", async () => {
    const item = await seedItem();
    const { startBreakdown } = await import("./breakdown");

    let outcome!: { winner: string; result: string | null };
    const errors = await prismaErrorsDuring(async () => {
      outcome = await whileRowIsLockedWithATask(item.id, () =>
        startBreakdown(item.id),
      );
    });

    expect(errors).toEqual([]);
    const tasks = await tasksIn();
    expect(tasks).toHaveLength(1);
    expect(tasks[0].id).toBe(outcome.winner);
    expect(outcome.result).toBe(outcome.winner);
    // Losing the race for the Task does not cost the caller its triage: the
    // stamp is what took the lock, so it landed either way.
    expect(await itemById(item.id)).toEqual({
      taskId: outcome.winner,
      status: BrainDumpStatus.Triaged,
    });
  });

  /**
   * The unarranged companion, with the same caveat as its ▶ Focus twin: it is
   * here to show an ordinary double press raises nothing, never as the proof
   * that the guard works. That is the spec above.
   */
  it("neither raises nor creates a second Task when two presses collide", async () => {
    const item = await seedItem();
    const { startBreakdown } = await import("./breakdown");

    let both: (string | null)[] = [];
    const errors = await prismaErrorsDuring(async () => {
      both = await Promise.all([
        startBreakdown(item.id),
        startBreakdown(item.id),
      ]);
    });

    expect(errors).toEqual([]);
    const tasks = await tasksIn();
    expect(tasks).toHaveLength(1);
    expect(both).toEqual([tasks[0].id, tasks[0].id]);
  });

  /**
   * The steps survive, which is the harm the orphaned Task actually did: a
   * breakdown re-entered from the inbox has to find the plan the user already
   * has rather than an empty task beside it.
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
    const { startBreakdown } = await import("./breakdown");

    expect(await startBreakdown(item.id)).toBe(task.id);
    expect(await tasksIn()).toHaveLength(1);
    expect(await prisma.step.count({ where: { taskId: task.id } })).toBe(1);
  });

  /** The scoping invariant, proved against the write itself. */
  it("no-ops on an item belonging to another workspace", async () => {
    const foreign = await seedItem(OTHER_WS);
    const { startBreakdown } = await import("./breakdown");

    await expect(startBreakdown(foreign.id)).resolves.toBeNull();

    expect(await tasksIn(OTHER_WS)).toHaveLength(0);
    expect((await itemById(foreign.id))?.status).toBe(BrainDumpStatus.Inbox);
  });

  it("no-ops on an item that no longer exists", async () => {
    const { startBreakdown } = await import("./breakdown");
    await expect(startBreakdown("does-not-exist")).resolves.toBeNull();
    expect(await tasksIn()).toHaveLength(0);
  });
});
