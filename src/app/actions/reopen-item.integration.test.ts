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
 * reversal. `@/lib/db`'s client is the real one, and `@/lib/google` is left real:
 * every row here is seeded with `googleTaskId: null`, so the sync returns before
 * it looks up a token.
 */

const WS = vi.hoisted(() => "itest-196-reopen-rewards");

// One-shot fault injection, for the same reason #198's file gives: the real
// reversal only fails on a real fault (a dead connection), which cannot be
// arranged to order. The REVERSAL is faked for one call; the transaction, the
// rollback and the retry that the assertions read are all real.
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
