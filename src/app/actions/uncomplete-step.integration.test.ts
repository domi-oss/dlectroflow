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
