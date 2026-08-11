/**
 * Real-Postgres proof that ▶ Focus gives an item **one** step, however many
 * callers reach `ensureFocusStep` at once (#245).
 *
 * ## The half #225 could not close
 *
 * `!306` closed the duplicate-`Task` race in all four brain-dump→Task writers
 * (#244 finished the set), each by putting a precondition inside the write. It
 * then said in as many words what it had NOT closed, and this is that:
 *
 * > **The STEP create.** Two concurrent calls against an item that ALREADY has a
 * > Task with no steps take no lock at all — neither enters the block above — so
 * > both read `steps: []` from their own snapshot and both create one, leaving two
 * > steps at `order: 1, total: 1`.
 *
 * A transaction-scoped precondition cannot close it, which is the whole reason it
 * was filed separately. Both transactions genuinely find no step, because there is
 * no row and therefore nothing to lock: an `UPDATE`'s `where` can carry a
 * precondition, an `INSERT`'s cannot. Only something at the table grain can decide
 * which of two inserts wins.
 *
 * The trigger is ordinary — pressing ▶ Focus twice — and `!306` made it easier to
 * reach by putting this write behind the failure notice's **Retry**, since
 * `withActionTimeout` bounds how long the UI waits and not how long the request
 * runs.
 *
 * ## Why the interleaving is ARRANGED here, and arranged differently
 *
 * `braindump-row-lock.ts` waits on `pg_blocking_pids` because the writes it is
 * about take a row lock, so "the loser blocked" is observable. **This race has no
 * lock to observe on the unfixed code**: nothing blocks, both callers simply read
 * an empty list. A barrier that waited for a block would throw before it could
 * demonstrate anything, and a bare `Promise.all` is the shape
 * `braindump-task-writers.integration.test.ts` measured passing against an unfixed
 * writer on a warm pool.
 *
 * So the barrier parks the caller at the one point that matters — **after its
 * check, before its act** — using the pass-through `$transaction` Proxy idiom from
 * `reopen-item.integration.test.ts`, extended one level to the transaction client
 * so the park lands on the `step` write rather than on the transaction boundary.
 * The competing step is then committed by this file's own client while the caller
 * is parked on a snapshot that says there are none, and released.
 *
 * That reproduces exactly the sentence above: both parties decided there was no
 * step, and both went on to insert one.
 *
 * ## What is stubbed, and what deliberately is not
 *
 * `@/lib/workspace` and `next/cache` (no request or cookie context exists outside
 * Next.js) and `@/lib/rewards` (the badge/points side is not under test).
 * **`@/lib/db`'s client is the real one** — the barrier is a pass-through Proxy
 * that delays one delegate method, not a fake — because the property under test is
 * what Postgres does with two inserts.
 *
 * Isolation mirrors the sibling integration suites: a dedicated `PrismaClient` for
 * setup and assertions, and a unique never-reused workspace id wiped at both ends.
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

const WS = vi.hoisted(() => "itest-245-ensure-focus-step");

/**
 * One-shot park, injected immediately before the `step` write inside
 * `ensureFocusStep`'s transaction — after its check, before its act.
 *
 * `wait` clears itself as it fires, so only the FIRST caller to reach the write is
 * delayed and every other spec in this file runs untouched. `onPark` fires as that
 * caller goes to sleep, which is the signal the test waits on instead of a timer.
 */
const barrier = vi.hoisted(() => ({
  wait: null as Promise<void> | null,
  onPark: null as (() => void) | null,
}));

vi.mock("@/lib/workspace", () => ({
  currentWorkspaceId: () => Promise.resolve(WS),
  currentUser: () => Promise.resolve(null),
}));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/lib/rewards", () => ({
  maybeAwardInboxZero: vi.fn().mockResolvedValue(undefined),
  maybeAwardTenStepsDay: vi.fn().mockResolvedValue(undefined),
  logReward: vi.fn().mockResolvedValue(undefined),
  awardBadge: vi.fn().mockResolvedValue(undefined),
  touchStreakOnCompletion: vi.fn().mockResolvedValue(null),
  touchStreakOnEngagement: vi.fn().mockResolvedValue(null),
  reverseItemCompletionRewards: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/db")>();

  /**
   * The `step` delegate writes the park has to cover.
   *
   * Both spellings, so ONE barrier survives the fix and the same spec can be
   * watched failing and then passing: the unfixed action inserts with
   * `step.create`, and the fix moves to `createManyAndReturn` +
   * `skipDuplicates` (the `ON CONFLICT DO NOTHING` shape `src/lib/db.ts`
   * prescribes). A barrier that named only one of them would silently stop
   * arranging anything the moment the fix landed, and the spec would go green
   * for the wrong reason — which is this repo's most expensive failure class.
   */
  const PARKED_WRITES = new Set([
    "create",
    "createMany",
    "createManyAndReturn",
  ]);

  /** Bind through, delaying only a `step` write. Everything else is the real
   *  delegate — methods bound to their own receiver so `this` never becomes a
   *  Proxy, the trap `reopen-item.integration.test.ts` documents. */
  const wrapTx = (tx: object): object =>
    new Proxy(tx, {
      get(target, prop, receiver) {
        const value = Reflect.get(target, prop, receiver);
        if (prop !== "step" || typeof value !== "object" || value === null) {
          return typeof value === "function" ? value.bind(target) : value;
        }
        const delegate = value as Record<string, unknown>;
        return new Proxy(delegate, {
          get(d, method) {
            const fn = Reflect.get(d, method);
            if (typeof fn !== "function") return fn;
            if (!PARKED_WRITES.has(String(method))) return fn.bind(d);
            return async (...args: unknown[]) => {
              const wait = barrier.wait;
              if (wait) {
                barrier.wait = null; // one-shot
                barrier.onPark?.();
                await wait;
              }
              return (fn as (...a: unknown[]) => unknown).apply(d, args);
            };
          },
        });
      },
    });

  const prisma = new Proxy(actual.prisma, {
    get(target, prop, receiver) {
      if (prop !== "$transaction") {
        const value = Reflect.get(target, prop, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      }
      return (...args: unknown[]) => {
        // BOUND to the real client. Prisma's `$transaction` reads `_engineConfig`
        // off `this`, so calling it detached fails with an unhandled rejection
        // that names an internal field and nothing about the test — the same
        // receiver trap the comment above is about, one method further in.
        const run = (
          target.$transaction as unknown as (
            ...a: unknown[]
          ) => Promise<unknown>
        ).bind(target);
        const [first, ...rest] = args;
        // Only the interactive form takes a callback; the array form (used
        // elsewhere in this module) is passed straight through untouched.
        if (typeof first !== "function") return run(...args);
        const callback = first as (tx: unknown) => unknown;
        return run((tx: object) => callback(wrapTx(tx)), ...rest);
      };
    },
  });

  return { ...actual, prisma };
});

const prisma = new PrismaClient();

async function wipe() {
  await prisma.focusSession.deleteMany({ where: { workspaceId: WS } });
  await prisma.step.deleteMany({ where: { task: { workspaceId: WS } } });
  await prisma.brainDumpItem.deleteMany({ where: { workspaceId: WS } });
  await prisma.task.deleteMany({ where: { workspaceId: WS } });
  await prisma.workspace.deleteMany({ where: { id: WS } });
}

/**
 * A triaged item that already HAS a Task and no steps — the state "Add to-do"
 * leaves behind, and the one where the duplicate-Task guard is skipped entirely
 * because `taskId` is already set. That is what makes this the unguarded path:
 * `ensureFocusStep` takes no lock at all on it.
 */
async function seedTriagedItemWithNoSteps() {
  const task = await prisma.task.create({
    data: { title: "Water the plants", workspaceId: WS },
  });
  const item = await prisma.brainDumpItem.create({
    data: {
      text: "Water the plants",
      workspaceId: WS,
      taskId: task.id,
      status: BrainDumpStatus.Triaged,
    },
  });
  return { item, task };
}

const stepsIn = () =>
  prisma.step.findMany({
    where: { task: { workspaceId: WS } },
    select: { id: true, taskId: true, text: true, order: true, total: true },
    orderBy: { order: "asc" },
  });

/** Commit a step for `taskId` from this file's own client — the competing press,
 *  landed and committed while the action under test is parked. */
const commitAStepFor = (taskId: string, text = "Water the plants") =>
  prisma.step.create({
    data: { taskId, text, order: 1, total: 1, estMinutes: 10 },
  });

/**
 * Run `act`, and once it has parked immediately before its `step` write, commit a
 * competing step and let it go.
 *
 * The arrangement IS the proof. Both parties have decided there is no step: the
 * action from the snapshot its `findFirst` took before the park, and this file
 * from having just looked. On the unfixed action both then insert.
 */
async function whileParkedBeforeItsStepWrite<T>(
  taskId: string,
  act: () => Promise<T>,
): Promise<T> {
  let release = () => {};
  barrier.wait = new Promise<void>((resolve) => (release = resolve));
  const parked = new Promise<void>((resolve) => (barrier.onPark = resolve));

  const running = act();
  try {
    await parked;
    await commitAStepFor(taskId);
  } finally {
    // Always, even if the park never fired — otherwise a failure here leaves the
    // action waiting on a promise nobody resolves and the spec times out at 30 s
    // instead of saying what went wrong.
    release();
    barrier.wait = null;
    barrier.onPark = null;
  }
  return running;
}

beforeAll(async () => {
  await wipe();
  await prisma.workspace.create({ data: { id: WS, kind: "owner" } });
});

beforeEach(async () => {
  barrier.wait = null;
  barrier.onPark = null;
  await prisma.focusSession.deleteMany({ where: { workspaceId: WS } });
  await prisma.step.deleteMany({ where: { task: { workspaceId: WS } } });
  await prisma.brainDumpItem.deleteMany({ where: { workspaceId: WS } });
  await prisma.task.deleteMany({ where: { workspaceId: WS } });
});

afterAll(async () => {
  await wipe();
  await prisma.$disconnect();
});

describe("ensureFocusStep (real Postgres) — one ▶ Focus, one step (#245)", () => {
  /**
   * The non-zero control. Every assertion below is a count that must stay at one,
   * and a count that can only ever read one proves nothing — this is the spec that
   * shows these reads can see ▶ Focus create a step at all.
   */
  it("creates the one step on the first press and returns it", async () => {
    const { item, task } = await seedTriagedItemWithNoSteps();
    const { ensureFocusStep } = await import("./braindump");

    const stepId = await ensureFocusStep(item.id);

    const steps = await stepsIn();
    expect(steps).toHaveLength(1);
    expect(steps[0]).toMatchObject({
      taskId: task.id,
      text: "Water the plants",
      order: 1,
      total: 1,
    });
    expect(stepId).toBe(steps[0].id);
  });

  /**
   * THE test, and the one that fails on the pre-fix action.
   *
   * See {@link whileParkedBeforeItsStepWrite}. Measured against the unfixed
   * action: two steps at `order: 1, total: 1`, and the caller answering with the
   * one nobody else can reach.
   */
  it("adopts the step a concurrent press committed rather than inserting a second", async () => {
    const { item, task } = await seedTriagedItemWithNoSteps();
    const { ensureFocusStep } = await import("./braindump");

    let stepId: string | null = null;
    const errors = await prismaErrorsDuring(async () => {
      stepId = await whileParkedBeforeItsStepWrite(task.id, () =>
        ensureFocusStep(item.id),
      );
    });

    // Silent, not merely handled. `src/lib/db.ts` keeps `log: ["error"]` truthful
    // on purpose, and a caught `P2002` still prints before any `catch` runs — the
    // defect #156 and #158 exist for. `ON CONFLICT DO NOTHING` raises nothing at
    // all, which is why it is the shape that file prescribes.
    expect(errors).toEqual([]);
    const steps = await stepsIn();
    expect(steps).toHaveLength(1);
    // And it answers with the step that actually exists, not one it rolled back.
    // A timer opened on an unreachable step id is the user-visible half of this.
    expect(stepId).toBe(steps[0].id);
  });

  /**
   * The unarranged companion: two presses fired together. It cannot be trusted on
   * its own — `braindump-task-writers.integration.test.ts` measured that shape
   * passing against an unfixed writer, because a warm pool serialises the two — so
   * it is here to show the ordinary double press raises nothing, never as the proof
   * that the guard works. That is the spec above.
   */
  it("neither raises nor creates a second step when two presses collide", async () => {
    const { item } = await seedTriagedItemWithNoSteps();
    const { ensureFocusStep } = await import("./braindump");

    let both: [string | null, string | null] = [null, null];
    const errors = await prismaErrorsDuring(async () => {
      both = await Promise.all([
        ensureFocusStep(item.id),
        ensureFocusStep(item.id),
      ]);
    });

    expect(errors).toEqual([]);
    const steps = await stepsIn();
    expect(steps).toHaveLength(1);
    // Both callers get the SAME step. A second step would put the timer on a
    // duplicate of work the user is already part-way through.
    expect(both[0]).toBe(steps[0].id);
    expect(both[1]).toBe(steps[0].id);
  });

  /**
   * The Retry, sequential. It passes against the unfixed action too — the second
   * call's read is served after the first commit — and is here because it is the
   * ordinary way a second press arrives.
   */
  it("returns the same step on a plain second press", async () => {
    const { item } = await seedTriagedItemWithNoSteps();
    const { ensureFocusStep } = await import("./braindump");

    const first = await ensureFocusStep(item.id);
    const second = await ensureFocusStep(item.id);

    expect(await stepsIn()).toHaveLength(1);
    expect(second).toBe(first);
  });

  /**
   * The unique index is on `(taskId, order)`, so it must not refuse a genuine
   * multi-step breakdown — the shape `confirmBreakdown` writes. The control that
   * keeps the migration from being a guard that breaks the app.
   */
  it("leaves a real multi-step breakdown alone and focuses its first open step", async () => {
    const { item, task } = await seedTriagedItemWithNoSteps();
    await prisma.step.createMany({
      data: [1, 2, 3].map((order) => ({
        taskId: task.id,
        text: `step ${order}`,
        order,
        total: 3,
        estMinutes: 5,
        done: order === 1,
      })),
    });
    const { ensureFocusStep } = await import("./braindump");

    const stepId = await ensureFocusStep(item.id);

    const steps = await stepsIn();
    expect(steps).toHaveLength(3);
    // The first NOT-done step, which is what the timer should open on.
    expect(stepId).toBe(steps.find((s) => s.order === 2)!.id);
  });
});
