/**
 * Real-Postgres proof for #233: two simultaneous completions of one to-do must
 * bank its rewards exactly once between them.
 *
 * `completeItem` guarded two `logReward` calls on a `findFirst` it ran before it
 * wrote. Both callers read `completedAt: null`, both passed the guard, and both
 * paid out — the item completed once and was paid for twice. Measured on #233: a
 * stepless to-do **+25**, a 5-step to-do **+75**, and a **permanent unearned
 * `ten_steps_day` badge**, because a double-completed 5-step to-do writes 10
 * `step_done` rows for 5 real steps and `maybeAwardTenStepsDay` awards at `>=
 * 10`. Badges are never reversed, so that one does not wash out.
 *
 * ## Why this cannot be a mocked unit test
 *
 * The fix is a precondition on a write, not a shape in the code: `updateMany`
 * with `completedAt: null` in its `where`, whose count is what every reward is
 * then gated on. Postgres re-evaluates an UPDATE's WHERE after releasing the row
 * lock it was waiting on, so the loser matches nothing and reports `count: 0`.
 * A mocked `updateMany` returns whatever it was told to, which is the assertion
 * restated rather than tested. `complete.test.ts` pins the call shapes; the
 * behaviour is proved here. Same division as
 * `reopen-item.integration.test.ts` (#196) and
 * `uncomplete-step.integration.test.ts` (#198).
 *
 * ## The interleaving is arranged, not hoped for
 *
 * `Promise.all([completeItem(x), completeItem(x)])` is **not** evidence, and
 * this repo has now been bitten by that twice. `reopen-item.integration.test.ts`
 * recorded it first: the bare shape fails on a cold query engine and passes once
 * earlier tests have warmed the pool, because the second read is then served
 * after the first commit. #233 then found the same defect had been silently
 * disarming the restored `rewards.integration.test.ts` — with the row lock
 * removed, its two "concurrent" callers returned
 * `[{continued:true},{continued:false}]`, having never overlapped at all.
 *
 * So the window is opened by hand and the ordering is total. The first caller is
 * parked the instant its `findFirst` resolves — before it has written anything —
 * the second then runs start to finish on an un-parked path, and only then is
 * the first released to act on a snapshot that is now stale. That is the
 * strongest form of this race, it needs no second connection, and it is
 * deterministic: nothing here depends on which caller Postgres happens to
 * schedule.
 *
 * Only `@/lib/workspace` and `next/cache` are stubbed (no request or cookie
 * context exists outside Next.js), plus the one-shot park. `@/lib/db`'s client
 * is the real one behind a pass-through `Proxy`, `@/lib/rewards` is entirely
 * real, and `@/lib/google-task-sync` is left real because every row is seeded
 * with `googleTaskId: null` — `patchPool` returns 0 on an empty queue before it
 * looks up a token.
 *
 * Fixtures and assertions use their own `PrismaClient`, the convention
 * `delete-completed-item.integration.test.ts` sets: this file's setup must not
 * run through the parked singleton the action under test is using.
 */

import {
  describe,
  it,
  expect,
  vi,
  beforeAll,
  afterAll,
  beforeEach,
} from "vitest";
import { PrismaClient } from "@prisma/client";
import {
  RewardType,
  RewardPoints,
  BadgeKey,
  TaskStatus,
  BrainDumpStatus,
} from "@/lib/constants";

const WS = vi.hoisted(() => "test-233-complete-race-ws");
/** A second workspace, only ever the negative control for the guard's scoping. */
const OTHER = vi.hoisted(() => "test-233-complete-race-other");

/**
 * One-shot park immediately after a `BrainDumpItem.findFirst` resolves.
 *
 * That is exactly the top of the read-then-act window: the caller now holds the
 * snapshot every reward decision used to be taken from, and has written nothing.
 * Parking there rather than at the `$transaction` boundary is deliberate — the
 * boundary does not exist in the code this test first has to fail against, so a
 * barrier placed there would prove the fix against nothing.
 *
 * `onPark` fires as the caller goes to sleep, which is the signal the helper
 * waits on instead of a timer.
 */
const barrier = vi.hoisted(() => ({
  wait: null as Promise<void> | null,
  onPark: null as (() => void) | null,
}));

vi.mock("@/lib/workspace", () => ({
  currentWorkspaceId: vi.fn().mockResolvedValue(WS),
  currentUser: vi.fn().mockResolvedValue(null),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/db")>();
  // A Proxy, not a replacement client: every property including every model
  // delegate is the real one, and only `brainDumpItem.findFirst` is wrapped.
  // Methods are bound to their real receiver so `this` never becomes the Proxy —
  // Prisma's client is already a Proxy and reading through two of them with a
  // rebound receiver is a trap this does not need to walk into.
  const prisma = new Proxy(actual.prisma, {
    get(target, prop, receiver) {
      if (prop !== "brainDumpItem") {
        const value = Reflect.get(target, prop, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      }
      const delegate = Reflect.get(target, prop, receiver) as object;
      return new Proxy(delegate, {
        get(d, p, r) {
          const value = Reflect.get(d, p, r);
          if (p !== "findFirst") {
            return typeof value === "function" ? value.bind(d) : value;
          }
          const findFirst = value as (...a: unknown[]) => Promise<unknown>;
          return async (...args: unknown[]) => {
            const row = await findFirst.call(d, ...args);
            const wait = barrier.wait;
            if (wait) {
              barrier.wait = null; // one-shot — the next caller is not parked
              barrier.onPark?.();
              await wait;
            }
            return row;
          };
        },
      });
    },
  });
  return { ...actual, prisma };
});

// Its own client, never the parked singleton — see the file docblock.
const prisma = new PrismaClient();

async function wipe() {
  for (const ws of [WS, OTHER]) {
    await prisma.step.deleteMany({ where: { task: { workspaceId: ws } } });
    await prisma.brainDumpItem.deleteMany({ where: { workspaceId: ws } });
    await prisma.task.deleteMany({ where: { workspaceId: ws } });
    await prisma.rewardEvent.deleteMany({ where: { workspaceId: ws } });
    await prisma.badge.deleteMany({ where: { workspaceId: ws } });
    await prisma.streakRecord.deleteMany({ where: { workspaceId: ws } });
    await prisma.streak.deleteMany({ where: { workspaceId: ws } });
    await prisma.settings.deleteMany({ where: { workspaceId: ws } });
    await prisma.workspace.deleteMany({ where: { id: ws } });
  }
}

/** An un-completed to-do with `steps` open steps, in the shape triage leaves. */
async function todo({
  steps = 0,
  workspaceId = WS,
}: { steps?: number; workspaceId?: string } = {}) {
  const task = await prisma.task.create({
    data: { title: "demo", workspaceId, status: TaskStatus.Active },
  });
  if (steps) {
    await prisma.step.createMany({
      data: Array.from({ length: steps }, (_, i) => ({
        taskId: task.id,
        text: `step ${i + 1}`,
        order: i,
        total: steps,
        estMinutes: 5,
        done: false,
      })),
    });
  }
  const item = await prisma.brainDumpItem.create({
    data: {
      text: "demo",
      workspaceId,
      status: BrainDumpStatus.Triaged,
      triagedAt: new Date(),
      taskId: task.id,
    },
  });
  return { item, task };
}

const countRewards = (type: string, workspaceId = WS) =>
  prisma.rewardEvent.count({ where: { workspaceId, type } });

const totalPoints = async (workspaceId = WS) =>
  (
    await prisma.rewardEvent.aggregate({
      _sum: { points: true },
      where: { workspaceId },
    })
  )._sum.points ?? 0;

const hasBadge = async (key: string, workspaceId = WS) =>
  (await prisma.badge.count({ where: { workspaceId, key } })) > 0;

/**
 * Two completions of one to-do, with the read-then-act window held open.
 *
 * Returns the two settled promises so a caller can assert that the loser
 * resolved rather than raising — nothing may be thrown at somebody whose second
 * tab merely finished first.
 */
async function completeTwiceAcrossTheWindow(id: string) {
  const { completeItem } = await import("./braindump");

  let release!: () => void;
  barrier.wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  const parked = new Promise<void>((resolve) => {
    barrier.onPark = resolve;
  });

  // Parks the moment its read resolves, holding a snapshot of an un-completed
  // to-do. This is the caller that must end up banking nothing.
  const stale = completeItem(id);
  await parked;
  // Runs start to finish while the first is asleep, so there is no ambiguity
  // about who wrote what.
  const winner = await completeItem(id).then(
    () => ({ ok: true }) as const,
    (error: unknown) => ({ ok: false, error }) as const,
  );
  release();
  const loser = await stale.then(
    () => ({ ok: true }) as const,
    (error: unknown) => ({ ok: false, error }) as const,
  );
  return { winner, loser };
}

beforeAll(async () => {
  await wipe();
  for (const id of [WS, OTHER]) {
    await prisma.workspace.create({ data: { id, kind: "guest" } });
  }
});

afterAll(async () => {
  await wipe();
  await prisma.$disconnect();
});

beforeEach(async () => {
  for (const ws of [WS, OTHER]) {
    await prisma.step.deleteMany({ where: { task: { workspaceId: ws } } });
    await prisma.brainDumpItem.deleteMany({ where: { workspaceId: ws } });
    await prisma.task.deleteMany({ where: { workspaceId: ws } });
    await prisma.rewardEvent.deleteMany({ where: { workspaceId: ws } });
    await prisma.badge.deleteMany({ where: { workspaceId: ws } });
    await prisma.streakRecord.deleteMany({ where: { workspaceId: ws } });
    await prisma.streak.deleteMany({ where: { workspaceId: ws } });
  }
  barrier.wait = null;
  barrier.onPark = null;
});

describe("completeItem — two completions of one to-do (#233)", () => {
  it("banks one task_complete, not two", async () => {
    const { item } = await todo();

    const { winner, loser } = await completeTwiceAcrossTheWindow(item.id);

    expect(winner.ok).toBe(true);
    // A no-op, never an error. Somebody whose phone finished the completion
    // first has done nothing wrong, and the whole guard is documented by that
    // sentence — same rule `reopenItem` and `deleteBrainDumpItem` follow.
    expect(loser.ok).toBe(true);

    expect(await countRewards(RewardType.TaskComplete)).toBe(1);
    // The `_sum(points)` the dashboard and the daily rollup email both read, and
    // the number #233 measured at +25 for this shape. `inbox_zero` is in the
    // total because completing the workspace's only queued item does empty the
    // queue, and its own once/day guard already holds it at one row.
    expect(await totalPoints()).toBe(
      RewardPoints[RewardType.TaskComplete] +
        RewardPoints[RewardType.InboxZero],
    );
    expect(await countRewards(RewardType.InboxZero)).toBe(1);
  });

  it("does not earn ten_steps_day off a 5-step to-do", async () => {
    // Five steps is ordinary — production already holds a seven-step task — and
    // it is the threshold that makes this defect permanent rather than
    // cosmetic. Double-banked, a 5-step completion writes 10 `step_done` rows
    // and `maybeAwardTenStepsDay` awards at `>= 10`. Badges are never reversed.
    const { item } = await todo({ steps: 5 });

    await completeTwiceAcrossTheWindow(item.id);

    expect(await countRewards(RewardType.StepDone)).toBe(5);
    expect(await hasBadge(BadgeKey.TenStepsDay)).toBe(false);
    expect(await countRewards(RewardType.TaskComplete)).toBe(1);
    // #233's magnitude claim for this shape: 5×10 + 25, plus the 15 the emptied
    // queue genuinely earns. Doubled it was +75 over.
    expect(await totalPoints()).toBe(
      5 * RewardPoints[RewardType.StepDone] +
        RewardPoints[RewardType.TaskComplete] +
        RewardPoints[RewardType.InboxZero],
    );
  });

  it("still completes the to-do exactly once, steps and task included", async () => {
    const { item, task } = await todo({ steps: 3 });

    await completeTwiceAcrossTheWindow(item.id);

    const after = await prisma.brainDumpItem.findUnique({
      where: { id: item.id },
    });
    expect(after?.completedAt).not.toBeNull();
    // `completeItem` clears this alongside the completion; a guard that returned
    // early before doing the local writes would leave it set.
    expect(after?.breakdownRequestedAt).toBeNull();
    expect(
      await prisma.step.count({ where: { taskId: task.id, done: false } }),
    ).toBe(0);
    expect(
      (await prisma.task.findUnique({ where: { id: task.id } }))?.status,
    ).toBe(TaskStatus.Done);
  });

  it("pays a single completion in full — the control", async () => {
    // The assertion that stops the fix being "gate everything and bank
    // nothing": one caller, no window, full payout. Without this, a guard that
    // returned early unconditionally would pass every test above.
    const { item, task } = await todo({ steps: 5 });
    const { completeItem } = await import("./braindump");

    await completeItem(item.id);

    expect(await countRewards(RewardType.StepDone)).toBe(5);
    expect(await countRewards(RewardType.TaskComplete)).toBe(1);
    expect(await hasBadge(BadgeKey.TaskComplete)).toBe(true);
    expect(
      await prisma.step.count({ where: { taskId: task.id, done: false } }),
    ).toBe(0);
  });

  it("leaves another workspace's identical to-do alone — scoping control", async () => {
    // The guard's `where` carries `workspaceId` in its own arguments rather than
    // inheriting the scope from the read above it, which is this repo's rule for
    // a bulk write. A zero here is only evidence because the WS assertions in
    // the same run are non-zero.
    const mine = await todo({ steps: 2 });
    const theirs = await todo({ steps: 2, workspaceId: OTHER });

    await completeTwiceAcrossTheWindow(mine.item.id);

    expect(await countRewards(RewardType.StepDone)).toBe(2); // non-zero control
    expect(await countRewards(RewardType.StepDone, OTHER)).toBe(0);
    expect(await countRewards(RewardType.TaskComplete, OTHER)).toBe(0);
    expect(
      (await prisma.brainDumpItem.findUnique({ where: { id: theirs.item.id } }))
        ?.completedAt,
    ).toBeNull();
    expect(
      await prisma.step.count({
        where: { taskId: theirs.task.id, done: true },
      }),
    ).toBe(0);
  });
});
