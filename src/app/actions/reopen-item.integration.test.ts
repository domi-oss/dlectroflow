import {
  describe,
  it,
  expect,
  vi,
  beforeAll,
  afterAll,
  beforeEach,
} from "vitest";
import { prisma } from "@/lib/db";
import { prismaErrorsDuring } from "@/lib/__tests__/prisma-error-log";
import {
  RewardPoints,
  RewardType,
  TaskStatus,
  BrainDumpStatus,
} from "@/lib/constants";

/**
 * Real-Postgres proof for the reward half of #196.
 *
 * `reopenItem` un-completed a to-do and took back none of what completing it
 * paid: `completeItem` banks one `step_done` per step it closes plus a
 * `task_complete`, so complete → reopen → complete banked every one of them
 * twice for one piece of work. The fix reverses one per step this call actually
 * un-completes, inside the reopen's own `$transaction`.
 *
 * **Two properties here cannot be shown with a mock.** The arithmetic — that N
 * reopened steps remove exactly N rows, sequentially, each read seeing the
 * previous delete — needs rows that really exist, because
 * `reverseLatestReward` takes "the newest row of this type" and a mocked
 * `findFirst` returns the same object however many times it is asked. And a
 * mocked `$transaction` runs its callback with no rollback to demonstrate, which
 * is the same reason `uncomplete-step.integration.test.ts` exists for #198. The
 * shapes are pinned in `complete.test.ts`; the behaviour is proved here.
 *
 * Only `@/lib/workspace` and `next/cache` are stubbed (no request or cookie
 * context exists outside Next.js), plus a one-shot fault injected into the
 * reversal and a one-shot barrier at the transaction boundary. `@/lib/db`'s
 * client is the real one behind both — the barrier is a pass-through Proxy that
 * delays `$transaction`, not a fake — and `@/lib/google` is left real: every row
 * here is seeded with `googleTaskId: null`, so the sync returns before it looks
 * up a token.
 */

const WS = vi.hoisted(() => "itest-196-reopen-rewards");

// One-shot fault injection, for the same reason #198's file gives: the real
// reversal only fails on a real fault (a dead connection), which cannot be
// arranged to order. The REVERSAL is faked for one call; the transaction, the
// rollback and the retry that the assertions read are all real.
const armed = vi.hoisted(() => ({ fail: false }));

/**
 * One-shot barrier at the `$transaction` boundary, for the concurrency proof at
 * the foot of this file (review round 12).
 *
 * The race being closed is "both callers read before either wrote", and a bare
 * `Promise.all([reopenItem(x), reopenItem(x)])` only produces it when the query
 * engine happens to let both reads land before the first transaction commits.
 * Measured on this file: it does on a cold pool (the test fails alone, as it
 * must) and does NOT once the five tests above have warmed one, where the second
 * read is served after the first commit and the call correctly reverses nothing.
 * A test that only fails when it is run alone is not a proof of anything, so the
 * interleaving is arranged rather than hoped for.
 *
 * `wait` parks the FIRST caller to reach `$transaction` — after its read, before
 * any write — and clears itself, so the second caller runs straight through.
 * `parked` fires as the first one goes to sleep, which is the signal the test
 * waits on instead of a timer.
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
vi.mock("@/lib/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/db")>();
  // A Proxy rather than a replacement client: every property, including every
  // model delegate, is the real one, and only `$transaction` is wrapped. Methods
  // are bound to the real client so `this` never becomes the Proxy — Prisma's
  // own client is already a Proxy and reading through two of them with a
  // rebound receiver is a trap this does not need to walk into.
  const prisma = new Proxy(actual.prisma, {
    get(target, prop, receiver) {
      if (prop !== "$transaction") {
        const value = Reflect.get(target, prop, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      }
      return async (...args: unknown[]) => {
        const wait = barrier.wait;
        if (wait) {
          barrier.wait = null; // one-shot — the next caller is not delayed
          barrier.onPark?.();
          await wait;
        }
        return (
          target.$transaction as unknown as (
            ...a: unknown[]
          ) => Promise<unknown>
        )(...args);
      };
    },
  });
  return { ...actual, prisma };
});
vi.mock("@/lib/rewards", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/rewards")>();
  return {
    ...actual,
    reverseItemCompletionRewards: (
      ...args: Parameters<typeof actual.reverseItemCompletionRewards>
    ) => {
      if (armed.fail) {
        armed.fail = false;
        return Promise.reject(new Error("injected reversal failure"));
      }
      return actual.reverseItemCompletionRewards(...args);
    },
  };
});

/** Bank one reward row of `type`, `n` times — what completing the to-do paid. */
async function bank(type: RewardType, n: number) {
  if (!n) return;
  await prisma.rewardEvent.createMany({
    data: Array.from({ length: n }, () => ({
      type,
      points: RewardPoints[type],
      workspaceId: WS,
    })),
  });
}

/**
 * A completed to-do with `doneSteps` closed steps and `openSteps` still open,
 * and the reward rows completing it would have banked.
 */
async function seedCompletedItem(doneSteps: number, openSteps = 0) {
  const task = await prisma.task.create({
    data: {
      title: "Repaint the hall",
      workspaceId: WS,
      status: TaskStatus.Done,
    },
  });
  const total = doneSteps + openSteps;
  const steps = [];
  for (let i = 0; i < total; i++) {
    steps.push(
      await prisma.step.create({
        data: {
          taskId: task.id,
          text: `step ${i + 1}`,
          order: i + 1,
          total,
          estMinutes: 5,
          done: i < doneSteps,
        },
      }),
    );
  }
  const item = await prisma.brainDumpItem.create({
    data: {
      text: "Repaint the hall",
      workspaceId: WS,
      taskId: task.id,
      status: BrainDumpStatus.Triaged,
      completedAt: new Date(),
    },
  });
  await bank(RewardType.StepDone, doneSteps);
  await bank(RewardType.TaskComplete, 1);
  return { task, item, steps };
}

function countOf(type: RewardType) {
  return prisma.rewardEvent.count({ where: { workspaceId: WS, type } });
}

async function wipe() {
  await prisma.rewardEvent.deleteMany({ where: { workspaceId: WS } });
  await prisma.step.deleteMany({ where: { task: { workspaceId: WS } } });
  await prisma.brainDumpItem.deleteMany({ where: { workspaceId: WS } });
  await prisma.task.deleteMany({ where: { workspaceId: WS } });
  await prisma.workspace.deleteMany({ where: { id: WS } });
}

beforeAll(async () => {
  await wipe();
  await prisma.workspace.create({ data: { id: WS, kind: "guest" } });
});

beforeEach(async () => {
  await prisma.rewardEvent.deleteMany({ where: { workspaceId: WS } });
  await prisma.step.deleteMany({ where: { task: { workspaceId: WS } } });
  await prisma.brainDumpItem.deleteMany({ where: { workspaceId: WS } });
  await prisma.task.deleteMany({ where: { workspaceId: WS } });
  armed.fail = false;
  // Disarmed between tests as well as consumed on use: a test that fails before
  // it releases the barrier would otherwise park the next one forever, turning
  // one red assertion into a suite-wide timeout.
  barrier.wait = null;
  barrier.onPark = null;
});

afterAll(async () => {
  await wipe();
  await prisma.$disconnect();
});

describe("reopenItem takes back what completing the to-do paid (#196)", () => {
  it("removes one step_done per step it un-completes, and the task_complete", async () => {
    const { task, item } = await seedCompletedItem(3);
    const { reopenItem } = await import("./braindump");

    expect(await countOf(RewardType.StepDone)).toBe(3);

    await expect(reopenItem(item.id)).resolves.toBeUndefined();

    // Three rows, not one: `reverseStepCompletionRewards` would have removed a
    // single `step_done` and left two banked for work now un-done. This is the
    // arithmetic a mocked `findFirst` cannot show, because it hands back the same
    // row every time it is asked.
    expect(await countOf(RewardType.StepDone)).toBe(0);
    expect(await countOf(RewardType.TaskComplete)).toBe(0);
    // And the local state really did reopen, so the zero above is a reversal
    // rather than an action that returned early.
    expect(
      (await prisma.brainDumpItem.findUnique({ where: { id: item.id } }))
        ?.completedAt,
    ).toBeNull();
    expect(
      (await prisma.task.findUnique({ where: { id: task.id } }))?.status,
    ).toBe(TaskStatus.Active);
  });

  it("leaves alone the step_done of a step that was already open", async () => {
    // Two done, one open. The open one never earned a `step_done`, so reversing
    // for it would take a row belonging to unrelated work in the same workspace.
    const { item } = await seedCompletedItem(2, 1);
    const { reopenItem } = await import("./braindump");
    await bank(RewardType.StepDone, 1); // an unrelated step, finished elsewhere

    await reopenItem(item.id);

    expect(await countOf(RewardType.StepDone)).toBe(1);
  });

  it("counts only the steps the caller selected", async () => {
    const { item, steps } = await seedCompletedItem(3);
    const { reopenItem } = await import("./braindump");

    await reopenItem(item.id, [steps[0].id, steps[1].id]);

    expect(await countOf(RewardType.StepDone)).toBe(1);
    expect(
      (await prisma.step.findUnique({ where: { id: steps[2].id } }))?.done,
    ).toBe(true);
  });

  it("reverses the task_complete alone for a to-do with no steps", async () => {
    const { item } = await seedCompletedItem(0);
    const { reopenItem } = await import("./braindump");

    await reopenItem(item.id);

    expect(await countOf(RewardType.TaskComplete)).toBe(0);
  });

  it("takes back nothing that is not there, rather than reaching into other work", async () => {
    // A reopen of an item whose rewards were already cleared must not go hunting.
    const { item } = await seedCompletedItem(2);
    await prisma.rewardEvent.deleteMany({ where: { workspaceId: WS } });
    await bank(RewardType.SessionFinished, 1);
    const { reopenItem } = await import("./braindump");

    await reopenItem(item.id);

    // `session_finished` pays for time genuinely spent and is never reversed —
    // the rule `reverseStepCompletionRewards` documents, holding at this arity.
    expect(await countOf(RewardType.SessionFinished)).toBe(1);
  });

  it("rolls the whole reopen back when the reversal fails, so the retry still works", async () => {
    // THE atomicity test. Without one transaction the item would be reopened
    // with its points still banked, and nothing would ever take them: the reopen
    // is not guarded on `completedAt`, so a retry re-runs the local writes but
    // the reward rows are gone from nobody's reach.
    const { task, item, steps } = await seedCompletedItem(2);
    const { reopenItem } = await import("./braindump");

    armed.fail = true;
    await expect(reopenItem(item.id)).rejects.toThrow(
      /injected reversal failure/,
    );

    // Not one of the three local writes survived, on real Postgres.
    expect(
      (await prisma.brainDumpItem.findUnique({ where: { id: item.id } }))
        ?.completedAt,
    ).not.toBeNull();
    expect(
      (await prisma.task.findUnique({ where: { id: task.id } }))?.status,
    ).toBe(TaskStatus.Done);
    expect(
      (await prisma.step.findUnique({ where: { id: steps[0].id } }))?.done,
    ).toBe(true);
    expect(await countOf(RewardType.StepDone)).toBe(2);

    // And the retry finishes the job, rewards included.
    await expect(reopenItem(item.id)).resolves.toBeUndefined();
    expect(await countOf(RewardType.StepDone)).toBe(0);
    expect(await countOf(RewardType.TaskComplete)).toBe(0);
  });
});

/**
 * #196 review round 12 — the whole-to-do twin of the hole `uncompleteStep`
 * closed in #198 rounds 10 and 11.
 *
 * `reopenItem` reads the item with a `findFirst` OUTSIDE its transaction and
 * used to count the reversal off that snapshot: `reopening.length` for the
 * `step_done`s, `item.completedAt !== null` for the `task_complete`. None of the
 * three writes inside the transaction carried a precondition, so a second caller
 * arriving on the same snapshot was not a no-op. It re-ran writes that happen to
 * be idempotent — clearing an already-null `completedAt`, setting an already
 * Active task Active — and then reversed the entire payout a second time.
 *
 * That second reversal cannot hit the same rows twice, because there are no
 * "same rows": `reverseLatestReward` takes back *the newest row of that type in
 * the WORKSPACE*, and `RewardEvent` holds no link back to the item that earned
 * it. So it reaches unrelated, already-settled work. One reopen of a two-step
 * to-do, four `step_done` and two `task_complete` gone.
 *
 * Reachable without contriving anything, and by the same pair of gestures that
 * produced #198: a double-tap that outruns the button's own `disabled`, or the
 * same Done row open in two tabs.
 */
describe("two reopens of ONE to-do take back one payout, not two (#196, round 12)", () => {
  /** The two earlier, unrelated payouts a double reversal reaches for. */
  async function seedOlderUnrelatedRewards() {
    const olderStep = await prisma.rewardEvent.create({
      data: {
        type: RewardType.StepDone,
        points: RewardPoints[RewardType.StepDone],
        workspaceId: WS,
        createdAt: new Date(Date.now() - 60_000),
      },
    });
    const olderTask = await prisma.rewardEvent.create({
      data: {
        type: RewardType.TaskComplete,
        points: RewardPoints[RewardType.TaskComplete],
        workspaceId: WS,
        createdAt: new Date(Date.now() - 120_000),
      },
    });
    return { olderStep, olderTask };
  }

  /**
   * Rows still banked, newest first. Read as IDs rather than as a count,
   * because "one `step_done` and one `task_complete` remain" would also pass if
   * the two that survived were the wrong ones.
   */
  function survivors() {
    return prisma.rewardEvent.findMany({
      where: { workspaceId: WS },
      orderBy: { createdAt: "desc" },
      select: { id: true, type: true },
    });
  }

  /**
   * THE test, and the one that fails on the pre-fix action.
   *
   * The interleaving is arranged rather than hoped for — see `barrier` at the
   * top of the file for the measurement that made that necessary. One caller is
   * parked between its read and its transaction, the other runs the whole reopen
   * to completion, and only then is the first let go. It resumes holding a
   * snapshot that says "completed, two steps done" about a to-do that is now
   * open with two steps not done, which is exactly the state the losing side of
   * a double-tap resumes in.
   *
   * No lock contention here, deliberately: the parked caller has taken no locks,
   * so the second one never blocks and the test cannot hang. What makes the
   * reversal not happen a second time is therefore the precondition on the
   * writes and nothing else — which is the property under test. The companion
   * below covers the contended path.
   */
  it("reverses nothing a second time when its snapshot went stale mid-flight", async () => {
    const { olderStep, olderTask } = await seedOlderUnrelatedRewards();
    const { task, item } = await seedCompletedItem(2);
    const { reopenItem } = await import("./braindump");

    let release!: () => void;
    barrier.wait = new Promise<void>((resolve) => (release = resolve));
    const parked = new Promise<void>((resolve) => (barrier.onPark = resolve));

    // Neither caller may raise: a duplicate reopen is a no-op, not an error to
    // put in front of someone who pressed a button twice.
    const errors = await prismaErrorsDuring(async () => {
      const stale = reopenItem(item.id); // reads, then sleeps at its transaction
      await parked;

      // The other tab. Arrives second, finishes first, and correctly takes back
      // the two `step_done` and the one `task_complete` this to-do earned.
      await expect(reopenItem(item.id)).resolves.toBeUndefined();
      expect(await survivors()).toHaveLength(2);

      release();
      await expect(stale).resolves.toBeUndefined();
    });
    expect(errors).toEqual([]);

    // The reopen itself still happened — the fix must not be "make the loser
    // refuse to reopen", and this is the non-zero control for the assertion
    // below: these reads can see a reopen land.
    expect(
      (await prisma.brainDumpItem.findUnique({ where: { id: item.id } }))
        ?.completedAt,
    ).toBeNull();
    expect(
      (await prisma.task.findUnique({ where: { id: task.id } }))?.status,
    ).toBe(TaskStatus.Active);

    // The point of the test. Before the fix both of these were gone, taken by a
    // reversal counted off a snapshot that had stopped being true.
    expect(await survivors()).toEqual([
      { id: olderStep.id, type: RewardType.StepDone },
      { id: olderTask.id, type: RewardType.TaskComplete },
    ]);
  });

  /**
   * The contended path the barrier test skips: two genuinely simultaneous
   * reopens, both writing the same `BrainDumpItem` row, so the second blocks on
   * the first's row lock and Postgres re-evaluates its `WHERE` only after the
   * first commits. That re-evaluation is the mechanism the fix relies on —
   * `uncompleteStep` documents it at length — and nothing else in this file
   * exercises it.
   *
   * Honest about what it can prove: if the query engine serialises the two reads
   * (which it does once the pool is warm), the second caller reads post-commit
   * state, reverses nothing for the right reason, and this passes without having
   * raced. It is a companion to the barrier test, never a substitute for it.
   */
  it("neither raises nor double-reverses when two reopens genuinely collide", async () => {
    const { olderStep, olderTask } = await seedOlderUnrelatedRewards();
    const { item } = await seedCompletedItem(2);
    const { reopenItem } = await import("./braindump");

    const errors = await prismaErrorsDuring(async () => {
      await expect(
        Promise.all([reopenItem(item.id), reopenItem(item.id)]),
      ).resolves.toHaveLength(2);
    });
    expect(errors).toEqual([]);

    expect(
      (await prisma.brainDumpItem.findUnique({ where: { id: item.id } }))
        ?.completedAt,
    ).toBeNull();
    expect(await survivors()).toEqual([
      { id: olderStep.id, type: RewardType.StepDone },
      { id: olderTask.id, type: RewardType.TaskComplete },
    ]);
  });
});
