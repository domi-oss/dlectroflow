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
import { reverseStepCompletionRewards } from "@/lib/rewards";
import {
  RewardPoints,
  RewardType,
  TaskStatus,
  BrainDumpStatus,
} from "@/lib/constants";

/**
 * Real-Postgres proof for the atomicity half of #198 (review round 4).
 *
 * `uncompleteStep` used to commit the step write, then reverse the reward. The
 * guard in front of it is `if (!step.done) return`, so a reversal that failed
 * left an unrecoverable state: the step was already not-done, the notice told the
 * user it was "still marked done" (false), and every retry no-opped on the guard
 * — the points stayed banked for work that had been un-done, permanently. The fix
 * puts both writes in one `$transaction`, so a failed reversal rolls the step
 * back and the undo is exactly as retryable as before it was pressed.
 *
 * **That property cannot be shown with a mock.** A mocked `$transaction` runs the
 * callback and has no rollback to demonstrate — the same reason
 * `rewards.integration.test.ts` fires real concurrent calls for the interactive-tx
 * row lock, and the reason `handled-p2002.integration.test.ts` exists at all. So
 * the shape is pinned in `complete.test.ts` and the behaviour is proved here.
 *
 * Only `@/lib/workspace` and `next/cache` are stubbed (no request/cookie context
 * exists outside Next.js), plus a one-shot fault injected into the reversal.
 * `@/lib/db`'s client is the real one, and `@/lib/google` is left real too: every
 * step here is seeded with `googleTaskId: null`, so `reopenGoogleTaskForStep`
 * returns before it looks up any token.
 */

const WS = vi.hoisted(() => "itest-198-atomic-undo");

// One-shot fault injection. The reversal is the write whose failure the fix is
// about, and the real one only fails on a real fault (a lost race — now absorbed
// by `deleteMany` — or a dead connection), neither of which can be arranged to
// order. So the REVERSAL is faked for one call and everything the assertions
// actually read — the transaction, the rollback, the retry — is real.
const armed = vi.hoisted(() => ({ fail: false }));

vi.mock("@/lib/workspace", () => ({
  currentWorkspaceId: () => Promise.resolve(WS),
  currentUser: () => Promise.resolve(null),
}));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/lib/rewards", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/rewards")>();
  return {
    ...actual,
    reverseStepCompletionRewards: (
      ...args: Parameters<typeof actual.reverseStepCompletionRewards>
    ) => {
      if (armed.fail) {
        armed.fail = false;
        return Promise.reject(new Error("injected reversal failure"));
      }
      return actual.reverseStepCompletionRewards(...args);
    },
  };
});

/** A step that was completed, closing its task and its inbox item with it. */
async function seedCompletedStep() {
  const task = await prisma.task.create({
    data: { title: "Ship the undo", workspaceId: WS, status: TaskStatus.Done },
  });
  const step = await prisma.step.create({
    data: {
      taskId: task.id,
      text: "the only step",
      order: 1,
      total: 1,
      estMinutes: 5,
      done: true,
    },
  });
  const item = await prisma.brainDumpItem.create({
    data: {
      text: "Ship the undo",
      workspaceId: WS,
      taskId: task.id,
      status: BrainDumpStatus.Triaged,
      completedAt: new Date(),
    },
  });
  // What completing it paid out, and therefore what the undo has to take back.
  await prisma.rewardEvent.createMany({
    data: [
      {
        type: RewardType.StepDone,
        points: RewardPoints[RewardType.StepDone],
        workspaceId: WS,
      },
      {
        type: RewardType.TaskComplete,
        points: RewardPoints[RewardType.TaskComplete],
        workspaceId: WS,
      },
    ],
  });
  return { task, step, item };
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
});

afterAll(async () => {
  await wipe();
  await prisma.$disconnect();
});

describe("uncompleteStep is atomic, so a failed undo stays retryable (#198)", () => {
  it("commits all four effects when the reversal succeeds", async () => {
    // The control for the rollback test below: it proves these reads CAN see the
    // undo happen, so "still done" there is a rollback and not a test that never
    // reached the write. A zero nobody has seen turn non-zero is not a result.
    const { task, step, item } = await seedCompletedStep();
    const { uncompleteStep } = await import("./focus");

    await expect(uncompleteStep(step.id)).resolves.toBeUndefined();

    expect(
      (await prisma.step.findUnique({ where: { id: step.id } }))?.done,
    ).toBe(false);
    expect(
      (await prisma.task.findUnique({ where: { id: task.id } }))?.status,
    ).toBe(TaskStatus.Active);
    expect(
      (await prisma.brainDumpItem.findUnique({ where: { id: item.id } }))
        ?.completedAt,
    ).toBeNull();
    // Both rewards taken back: `step_done` always, `task_complete` because this
    // undo really did reopen a closed task.
    expect(await prisma.rewardEvent.count({ where: { workspaceId: WS } })).toBe(
      0,
    );
  });

  it("rolls the step write back when the reversal fails, and the retry then completes it", async () => {
    // THE test. Everything else in this file supports it.
    const { task, step, item } = await seedCompletedStep();
    const { uncompleteStep } = await import("./focus");

    armed.fail = true;
    await expect(uncompleteStep(step.id)).rejects.toThrow(
      /injected reversal failure/,
    );

    // Not one of the three local writes survived, on real Postgres. Before the
    // fix the step here read `done: false` — committed, unreversed, and with the
    // guard now permanently in the way of putting it right.
    expect(
      (await prisma.step.findUnique({ where: { id: step.id } }))?.done,
    ).toBe(true);
    expect(
      (await prisma.task.findUnique({ where: { id: task.id } }))?.status,
    ).toBe(TaskStatus.Done);
    expect(
      (await prisma.brainDumpItem.findUnique({ where: { id: item.id } }))
        ?.completedAt,
    ).not.toBeNull();
    expect(await prisma.rewardEvent.count({ where: { workspaceId: WS } })).toBe(
      2,
    );

    // And so the retry — the failure notice's own Retry button, which re-invokes
    // this same action — gets past `if (!step.done) return` and finishes the job,
    // rewards included. This is the whole user-visible point: the notice says the
    // step is still marked done, and pressing Retry makes that stop being true.
    await expect(uncompleteStep(step.id)).resolves.toBeUndefined();

    expect(
      (await prisma.step.findUnique({ where: { id: step.id } }))?.done,
    ).toBe(false);
    expect(
      (await prisma.task.findUnique({ where: { id: task.id } }))?.status,
    ).toBe(TaskStatus.Active);
    expect(await prisma.rewardEvent.count({ where: { workspaceId: WS } })).toBe(
      0,
    );
  });
});

describe("reverseLatestReward's deleteMany absorbs a lost race (#198)", () => {
  // The other half of the round-4 fix, and the reason the reversal can fail at
  // all: `findFirst` then `delete` is a TOCTOU, exactly like `awardBadge`'s
  // findUnique→create (#158). Two concurrent reversals both read the same newest
  // row and the loser's `delete` raises P2025 — which, per #156/#158, ALSO prints
  // `prisma:error` before any `catch` can see it. `deleteMany` reports `count: 0`
  // instead of raising.
  //
  // Asserted from both sides for the reason handled-p2002.integration.test.ts
  // gives: "nothing raised" is also what a test that queried nothing looks like.
  it("Prisma really does answer count 0 rather than raising, where delete raises P2025", async () => {
    const gone = "itest-198-no-such-reward-id";

    let noRaise: unknown = "never ran";
    const quiet = await prismaErrorsDuring(async () => {
      noRaise = await prisma.rewardEvent.deleteMany({ where: { id: gone } });
    });
    expect(noRaise).toEqual({ count: 0 });
    expect(quiet).toEqual([]);

    // The non-zero control: the shape the fix replaced, on the very same absent
    // row, both raising and printing.
    let rejection: unknown;
    const loud = await prismaErrorsDuring(async () => {
      rejection = await prisma.rewardEvent.delete({ where: { id: gone } }).then(
        () => undefined,
        (e: unknown) => e,
      );
    });
    expect(rejection).toMatchObject({ code: "P2025" });
    expect(loud).toHaveLength(1);
  });

  it("concurrent reversals of one reward row: nothing raises, exactly one wins", async () => {
    // Four callers, one `step_done` row. If a run serialises completely it still
    // passes — correctly, it just proves less that time; same caveat as the #158
    // burst tests. What it cannot do any more is raise.
    await prisma.rewardEvent.create({
      data: {
        type: RewardType.StepDone,
        points: RewardPoints[RewardType.StepDone],
        workspaceId: WS,
      },
    });

    let outcomes: { stepDone: boolean; taskComplete: boolean }[] = [];
    const errors = await prismaErrorsDuring(async () => {
      outcomes = await Promise.all(
        Array.from({ length: 4 }, () =>
          reverseStepCompletionRewards(WS, { includeTaskComplete: false }),
        ),
      );
    });

    expect(errors).toEqual([]);
    expect(outcomes.filter((o) => o.stepDone)).toHaveLength(1);
    expect(await prisma.rewardEvent.count({ where: { workspaceId: WS } })).toBe(
      0,
    );
  });
});

describe("two undos of ONE step take back one reward, not two (#198, round 10)", () => {
  /**
   * `reverseLatestReward` absorbing a lost race (the block above) protects the
   * REWARD row. It does not protect the *decision to reverse*, and that is a
   * separate hole one level up.
   *
   * `uncompleteStep` reads `step.done` outside the transaction and takes no lock,
   * so two near-simultaneous undos of the same step both pass
   * `if (!step || !step.done) return` before either commits. Both then entered
   * their own transaction, both flipped `done` to `false` (idempotent, harmless),
   * and both called `reverseStepCompletionRewards` — which takes back *the newest
   * `step_done` in the workspace*, not one tied to this step. So the loser
   * silently reversed an UNRELATED step's reward: one press, two rewards gone.
   *
   * Reachable without contriving anything: a double-click that outruns the
   * button's own `disabled`, or the same step open in two tabs.
   *
   * **This is deterministic, not a race the test hopes to hit.** The first
   * transaction's write takes a row lock, so the second blocks on it and only
   * proceeds after the first has committed — which is precisely when a guarded
   * write must re-read `done` and find it already `false`.
   */
  it("leaves an unrelated step's step_done alone when two undos of one step race", async () => {
    // An earlier, unrelated completion's payout. Older, so it is the row the
    // buggy second reversal reaches for once the first has taken the newest.
    const unrelated = await prisma.rewardEvent.create({
      data: {
        type: RewardType.StepDone,
        points: RewardPoints[RewardType.StepDone],
        workspaceId: WS,
        createdAt: new Date(Date.now() - 60_000),
      },
    });
    const { task, step } = await seedCompletedStep();
    const { uncompleteStep } = await import("./focus");

    // Neither call may raise: a duplicate undo is a no-op, not an error the user
    // should ever see.
    const errors = await prismaErrorsDuring(async () => {
      await expect(
        Promise.all([uncompleteStep(step.id), uncompleteStep(step.id)]),
      ).resolves.toHaveLength(2);
    });
    expect(errors).toEqual([]);

    // The undo itself still happened, exactly once over.
    expect(
      (await prisma.step.findUnique({ where: { id: step.id } }))?.done,
    ).toBe(false);
    expect(
      (await prisma.task.findUnique({ where: { id: task.id } }))?.status,
    ).toBe(TaskStatus.Active);

    // The point of the test: the unrelated reward is untouched, and it is
    // identified BY ID rather than by a count, because "one step_done remains"
    // would also pass if the wrong one had survived.
    const survivors = await prisma.rewardEvent.findMany({
      where: { workspaceId: WS },
      select: { id: true, type: true },
    });
    expect(survivors).toEqual([
      { id: unrelated.id, type: RewardType.StepDone },
    ]);
  });
});

describe("two undos of DIFFERENT steps of one task reverse one task_complete (#198, round 11)", () => {
  /**
   * Round 10 closed the same-step race by folding `done: true` into the step write.
   * Round 11 found the sibling one level up, and it is genuinely different: two
   * undos of *different* steps of the same completed task never contend on that
   * guard, because they touch different `Step` rows.
   *
   * `reopenedTask` is read BEFORE the transaction opens, so both calls see
   * `status: Done` and both pass `includeTaskComplete: true`. The task itself only
   * transitions Done→Active once — but the reversal runs twice, and
   * `reverseLatestReward` takes back *the newest `task_complete` in the workspace*.
   * The second one therefore reaches a completely unrelated, already-settled task's
   * reward. One reopening, two `task_complete` rows gone.
   *
   * This is not the "which row goes is unobservable" argument the doc comment makes
   * for `step_done`: that is about not caring *which* of N equivalent rows is
   * removed for one correctly-counted reversal. Here the COUNT is wrong.
   *
   * Deterministic for the same reason as round 10's: both transactions write the
   * same `Task` row, so the second blocks until the first commits — exactly when a
   * guarded write must re-read `status`.
   */
  it("leaves an unrelated task's task_complete alone when two steps of one task are undone at once", async () => {
    // A different task, settled long ago, whose payout is the one at risk.
    const unrelated = await prisma.rewardEvent.create({
      data: {
        type: RewardType.TaskComplete,
        points: RewardPoints[RewardType.TaskComplete],
        workspaceId: WS,
        createdAt: new Date(Date.now() - 120_000),
      },
    });

    const task = await prisma.task.create({
      data: {
        title: "Two done steps",
        workspaceId: WS,
        status: TaskStatus.Done,
      },
    });
    const mk = (order: number) =>
      prisma.step.create({
        data: {
          taskId: task.id,
          text: `step ${order}`,
          order,
          total: 2,
          estMinutes: 5,
          done: true,
        },
      });
    const s1 = await mk(1);
    const s2 = await mk(2);
    await prisma.brainDumpItem.create({
      data: {
        text: "Two done steps",
        workspaceId: WS,
        taskId: task.id,
        status: BrainDumpStatus.Triaged,
        completedAt: new Date(),
      },
    });
    // What completing both steps and thereby the task paid out.
    await prisma.rewardEvent.createMany({
      data: [
        {
          type: RewardType.StepDone,
          points: RewardPoints[RewardType.StepDone],
          workspaceId: WS,
        },
        {
          type: RewardType.StepDone,
          points: RewardPoints[RewardType.StepDone],
          workspaceId: WS,
        },
        {
          type: RewardType.TaskComplete,
          points: RewardPoints[RewardType.TaskComplete],
          workspaceId: WS,
        },
      ],
    });

    const { uncompleteStep } = await import("./focus");
    const errors = await prismaErrorsDuring(async () => {
      await expect(
        Promise.all([uncompleteStep(s1.id), uncompleteStep(s2.id)]),
      ).resolves.toHaveLength(2);
    });
    expect(errors).toEqual([]);

    // Both steps really were reopened, and the task with them — this must not be
    // "fixed" by making the second undo a no-op. Both undos are legitimate.
    expect((await prisma.step.findUnique({ where: { id: s1.id } }))?.done).toBe(
      false,
    );
    expect((await prisma.step.findUnique({ where: { id: s2.id } }))?.done).toBe(
      false,
    );
    expect(
      (await prisma.task.findUnique({ where: { id: task.id } }))?.status,
    ).toBe(TaskStatus.Active);

    // Two `step_done` reversed — one per undo, which is correct — and exactly ONE
    // `task_complete`, because only one task reopened. The unrelated task's reward
    // is identified by id: a bare count of 1 would also pass if the wrong row lived.
    const survivors = await prisma.rewardEvent.findMany({
      where: { workspaceId: WS },
      select: { id: true, type: true },
    });
    expect(survivors).toEqual([
      { id: unrelated.id, type: RewardType.TaskComplete },
    ]);
  });
});
