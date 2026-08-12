/**
 * Real-DB proof for #251's reward reversal: deleting a completed to-do takes
 * back what its completion banked, inside the delete's own transaction.
 *
 * ## Why this file exists rather than more cases in the mocked unit test
 *
 * Every guarantee asserted here is a property of Postgres, not of the code
 * shape. The reversal is gated on the row counts that `updateMany`/`deleteMany`
 * report *after* the row lock is released — the same guarded-bulk pattern
 * `reopenItem` and `reverseLatestReward` adopted — and a mock cannot show that a
 * loser re-evaluates its WHERE and matches nothing. Two concurrent deletes must
 * reverse the payout exactly once between them, and only a real transaction can
 * demonstrate it. The double payout that #196 records was found this way.
 *
 * The floor guard is the same kind of claim: reversing a to-do that owes more
 * than the workspace holds must stop at zero rows rather than reach into another
 * workspace's, and "stopped at zero" is only meaningful against a store that
 * really ran out.
 *
 * Only `@/lib/workspace` and `next/cache` are mocked (no request context outside
 * Next.js), plus `maybeAwardInboxZero` — which the delete already called before
 * this issue and which would otherwise bank an `inbox_zero` row mid-assertion.
 * The reversal itself is the real module.
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
import { RewardType, BadgeKey, RewardPoints } from "@/lib/constants";

const WS = vi.hoisted(() => "test-251-delete-rewards-ws");
/** A second workspace, only ever used as the negative control for scoping. */
const OTHER = vi.hoisted(() => "test-251-delete-rewards-other");

vi.mock("@/lib/workspace", () => ({
  currentWorkspaceId: vi.fn().mockResolvedValue(WS),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/rewards", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/rewards")>();
  // The one pre-existing side effect of a delete, stubbed so it cannot bank an
  // `inbox_zero` row into the middle of a points assertion. Everything the
  // reversal uses stays real.
  return {
    ...actual,
    maybeAwardInboxZero: vi.fn().mockResolvedValue(undefined),
  };
});

// Dedicated client, for the reason delete-braindump-item.integration.test.ts
// gives: this file's own setup/teardown must not interfere with the singleton
// the action under test uses.
const prisma = new PrismaClient();

async function wipe() {
  for (const ws of [WS, OTHER]) {
    await prisma.step.deleteMany({ where: { task: { workspaceId: ws } } });
    await prisma.brainDumpItem.deleteMany({ where: { workspaceId: ws } });
    await prisma.task.deleteMany({ where: { workspaceId: ws } });
    await prisma.rewardEvent.deleteMany({ where: { workspaceId: ws } });
    await prisma.badge.deleteMany({ where: { workspaceId: ws } });
    await prisma.workspace.deleteMany({ where: { id: ws } });
  }
}

/**
 * Bank `n` reward rows of one type — what a completion would have paid.
 *
 * `at` dates them, which the #251-review cases need: the defect they pin is that
 * a reversal reached for TODAY's rows to pay for work finished on an earlier day,
 * and "an earlier day" is not expressible without writing `createdAt`.
 */
async function bank(workspaceId: string, type: string, n: number, at?: Date) {
  if (!n) return;
  await prisma.rewardEvent.createMany({
    data: Array.from({ length: n }, () => ({
      type,
      points: RewardPoints[type as keyof typeof RewardPoints],
      workspaceId,
      ...(at ? { createdAt: at } : {}),
    })),
  });
}

const countRewards = (workspaceId: string, type: string) =>
  prisma.rewardEvent.count({ where: { workspaceId, type } });

const hasBadge = async (workspaceId: string, key: string) =>
  (await prisma.badge.count({ where: { workspaceId, key } })) > 0;

/**
 * A completed to-do with `steps` steps, all done — the shape the Done bucket
 * renders — together with the reward rows its completion banked.
 */
async function completedTodo({
  steps = 0,
  completed = true,
  workspaceId = WS,
  at,
}: {
  steps?: number;
  completed?: boolean;
  workspaceId?: string;
  /**
   * When this to-do was finished. Dates `completedAt` AND the reward rows the
   * completion banked, so the two agree the way `completeItem` leaves them —
   * a fixture that stamped one and not the other would be testing a state the
   * app cannot produce.
   */
  at?: Date;
} = {}) {
  const task = await prisma.task.create({
    data: { title: "demo", workspaceId, status: completed ? "done" : "active" },
  });
  if (steps) {
    await prisma.step.createMany({
      data: Array.from({ length: steps }, (_, i) => ({
        taskId: task.id,
        text: `step ${i + 1}`,
        order: i + 1,
        total: steps,
        estMinutes: 10,
        done: true,
      })),
    });
  }
  const item = await prisma.brainDumpItem.create({
    data: {
      text: "demo",
      workspaceId,
      taskId: task.id,
      status: "triaged",
      completedAt: completed ? (at ?? new Date()) : null,
    },
  });
  // `completeItem` banks the step points BEFORE it stamps `completedAt` and the
  // `task_complete` after it (measured: two `step_done` at the stamp or 2ms
  // earlier, the `task_complete` 3ms later). The fixture reproduces that
  // ordering, because it is exactly what makes `completedAt` a sound upper bound
  // for the item's own step rows and an unsound one for its completion row.
  await bank(
    workspaceId,
    RewardType.StepDone,
    steps,
    at ? new Date(at.getTime() - 1000) : undefined,
  );
  if (completed)
    await bank(
      workspaceId,
      RewardType.TaskComplete,
      1,
      at ? new Date(at.getTime() + 1000) : undefined,
    );
  return { item, task };
}

beforeAll(async () => {
  await wipe();
  await prisma.workspace.create({ data: { id: WS, kind: "guest" } });
  await prisma.workspace.create({ data: { id: OTHER, kind: "guest" } });
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
  }
});

describe("deleteBrainDumpItem — reward reversal on a completed item (#251)", () => {
  it("takes back one step_done per done step plus the task_complete", async () => {
    const { item } = await completedTodo({ steps: 3 });
    expect(await countRewards(WS, RewardType.StepDone)).toBe(3);
    expect(await countRewards(WS, RewardType.TaskComplete)).toBe(1);

    const { deleteBrainDumpItem } = await import("./braindump");
    await deleteBrainDumpItem(item.id);

    expect(await countRewards(WS, RewardType.StepDone)).toBe(0);
    expect(await countRewards(WS, RewardType.TaskComplete)).toBe(0);
  });

  it("leaves session_finished alone — the time was really spent", async () => {
    const { item } = await completedTodo({ steps: 1 });
    await bank(WS, RewardType.SessionFinished, 2);

    const { deleteBrainDumpItem } = await import("./braindump");
    await deleteBrainDumpItem(item.id);

    expect(await countRewards(WS, RewardType.SessionFinished)).toBe(2);
  });

  it("a stepless completed to-do reverses only its task_complete", async () => {
    const { item } = await completedTodo({ steps: 0 });
    // Another to-do's step points, which this delete must not reach for.
    await bank(WS, RewardType.StepDone, 4);

    const { deleteBrainDumpItem } = await import("./braindump");
    await deleteBrainDumpItem(item.id);

    expect(await countRewards(WS, RewardType.TaskComplete)).toBe(0);
    expect(await countRewards(WS, RewardType.StepDone)).toBe(4);
  });

  it("an item that was never completed still gives back its done steps, and no task_complete", async () => {
    // The Library's Done tab shows `isFullyDone` rows too — every step ticked,
    // `completedAt` never stamped — and those banked a step_done each while
    // banking no task_complete. The arithmetic matches what reopening the same
    // row would reverse, which is the rule this whole reversal follows.
    const { item } = await completedTodo({ steps: 2, completed: false });
    await bank(WS, RewardType.TaskComplete, 1); // another to-do's completion

    const { deleteBrainDumpItem } = await import("./braindump");
    await deleteBrainDumpItem(item.id);

    expect(await countRewards(WS, RewardType.StepDone)).toBe(0);
    expect(await countRewards(WS, RewardType.TaskComplete)).toBe(1);
  });
});

describe("deleteBrainDumpItem — the floor guard (#251)", () => {
  it("stops at zero rather than driving the balance negative", async () => {
    const { item } = await completedTodo({ steps: 3 });
    // The workspace owes 3 step_done but holds 1: a reopen already took two, or
    // the rows predate the reward table. Nothing may go below zero, and nothing
    // may be borrowed from another type to make up the difference.
    await prisma.rewardEvent.deleteMany({
      where: { workspaceId: WS, type: RewardType.StepDone },
    });
    await bank(WS, RewardType.StepDone, 1);
    await bank(WS, RewardType.Scheduled, 2);

    const { deleteBrainDumpItem } = await import("./braindump");
    await deleteBrainDumpItem(item.id);

    expect(await countRewards(WS, RewardType.StepDone)).toBe(0);
    expect(await countRewards(WS, RewardType.Scheduled)).toBe(2);
    const total = await prisma.rewardEvent.aggregate({
      where: { workspaceId: WS },
      _sum: { points: true },
    });
    expect(total._sum.points ?? 0).toBeGreaterThanOrEqual(0);
  });

  it("never reaches another workspace's reward rows", async () => {
    const { item } = await completedTodo({ steps: 2 });
    await prisma.rewardEvent.deleteMany({ where: { workspaceId: WS } });
    await bank(OTHER, RewardType.StepDone, 5);
    await bank(OTHER, RewardType.TaskComplete, 5);

    const { deleteBrainDumpItem } = await import("./braindump");
    await deleteBrainDumpItem(item.id);

    expect(await countRewards(OTHER, RewardType.StepDone)).toBe(5);
    expect(await countRewards(OTHER, RewardType.TaskComplete)).toBe(5);
  });

  it("refuses a completed item belonging to another workspace, points included", async () => {
    const { item } = await completedTodo({ steps: 2, workspaceId: OTHER });

    // `currentWorkspaceId` resolves to WS, so this id is not ours to delete.
    const { deleteBrainDumpItem } = await import("./braindump");
    await deleteBrainDumpItem(item.id);

    expect(
      await prisma.brainDumpItem.findUnique({ where: { id: item.id } }),
    ).not.toBeNull();
    expect(await countRewards(OTHER, RewardType.StepDone)).toBe(2);
    expect(await countRewards(OTHER, RewardType.TaskComplete)).toBe(1);
  });
});

describe("deleteBrainDumpItem — reversing exactly once (#251)", () => {
  it("a second delete of the same id reverses nothing more", async () => {
    const { item } = await completedTodo({ steps: 1 });
    // A second completed to-do, so there is something left to take twice from.
    await completedTodo({ steps: 1 });

    const { deleteBrainDumpItem } = await import("./braindump");
    await deleteBrainDumpItem(item.id);
    await deleteBrainDumpItem(item.id);

    // The survivor's payout is untouched: 1 step_done + 1 task_complete.
    expect(await countRewards(WS, RewardType.StepDone)).toBe(1);
    expect(await countRewards(WS, RewardType.TaskComplete)).toBe(1);
  });

  it("two concurrent deletes of one item reverse the payout once between them", async () => {
    const { item } = await completedTodo({ steps: 1 });
    await completedTodo({ steps: 1 });

    const rewards = await import("@/lib/rewards");
    vi.mocked(rewards.maybeAwardInboxZero).mockClear();

    const { deleteBrainDumpItem } = await import("./braindump");
    await Promise.all([
      deleteBrainDumpItem(item.id),
      deleteBrainDumpItem(item.id),
    ]);

    expect(await countRewards(WS, RewardType.StepDone)).toBe(1);
    expect(await countRewards(WS, RewardType.TaskComplete)).toBe(1);
    // The half this test used to be blind to. Asserting only the reward counts
    // let the loser of the race run the award: it claims no completion, so
    // `tookCompletion` reads 0 — the same value an untriaged delete produces —
    // and a gate gated on that alone waves it through. Both callers here deleted
    // a COMPLETED row, so neither may award.
    expect(rewards.maybeAwardInboxZero).not.toHaveBeenCalled();
  });

  it("two concurrent deletes of one UNTRIAGED item award inbox zero exactly once", async () => {
    // The discriminating case, and the one that shows why "did this call claim a
    // completion" is the wrong question for a post-transaction award. Neither
    // caller claims a completion here, because there is none — so the gate has to
    // ask the other question instead: did THIS call remove a row. Exactly one of
    // them did.
    const item = await prisma.brainDumpItem.create({
      data: { text: "needs triage", workspaceId: WS, status: "inbox" },
    });
    const rewards = await import("@/lib/rewards");
    vi.mocked(rewards.maybeAwardInboxZero).mockClear();

    const { deleteBrainDumpItem } = await import("./braindump");
    await Promise.all([
      deleteBrainDumpItem(item.id),
      deleteBrainDumpItem(item.id),
    ]);

    expect(await prisma.brainDumpItem.count({ where: { id: item.id } })).toBe(
      0,
    );
    expect(rewards.maybeAwardInboxZero).toHaveBeenCalledTimes(1);
  });
});

describe("deleteBrainDumpItem — badge revocation (#251)", () => {
  it("revokes task_complete when the deleted item was the last completed one", async () => {
    const { item } = await completedTodo({ steps: 0 });
    await prisma.badge.create({
      data: { workspaceId: WS, key: BadgeKey.TaskComplete },
    });

    const { deleteBrainDumpItem } = await import("./braindump");
    await deleteBrainDumpItem(item.id);

    expect(await hasBadge(WS, BadgeKey.TaskComplete)).toBe(false);
  });

  it("keeps task_complete when another completed item still qualifies for it", async () => {
    const { item } = await completedTodo({ steps: 0 });
    await completedTodo({ steps: 0 });
    await prisma.badge.create({
      data: { workspaceId: WS, key: BadgeKey.TaskComplete },
    });

    const { deleteBrainDumpItem } = await import("./braindump");
    await deleteBrainDumpItem(item.id);

    expect(await hasBadge(WS, BadgeKey.TaskComplete)).toBe(true);
  });

  it("revokes ten_steps_day earned today once the reversal drops today below ten", async () => {
    const { item } = await completedTodo({ steps: 3 });
    await bank(WS, RewardType.StepDone, 7); // 10 today in total
    await prisma.badge.create({
      data: {
        workspaceId: WS,
        key: BadgeKey.TenStepsDay,
        earnedAt: new Date(),
      },
    });

    const { deleteBrainDumpItem } = await import("./braindump");
    await deleteBrainDumpItem(item.id);

    expect(await countRewards(WS, RewardType.StepDone)).toBe(7);
    expect(await hasBadge(WS, BadgeKey.TenStepsDay)).toBe(false);
  });

  it("keeps ten_steps_day when ten steps still stand today", async () => {
    const { item } = await completedTodo({ steps: 3 });
    await bank(WS, RewardType.StepDone, 10); // 13 today; 10 survive the reversal
    await prisma.badge.create({
      data: {
        workspaceId: WS,
        key: BadgeKey.TenStepsDay,
        earnedAt: new Date(),
      },
    });

    const { deleteBrainDumpItem } = await import("./braindump");
    await deleteBrainDumpItem(item.id);

    expect(await countRewards(WS, RewardType.StepDone)).toBe(10);
    expect(await hasBadge(WS, BadgeKey.TenStepsDay)).toBe(true);
  });

  it("keeps a ten_steps_day earned on an earlier day", async () => {
    // The badge has no per-day ledger and today's count says nothing about the
    // day it was earned, so a badge banked last Tuesday survives a delete today.
    // Revoking it would be the "un-award something the item never contributed
    // to" failure, not a reversal.
    const { item } = await completedTodo({ steps: 3 });
    const earlier = new Date(Date.now() - 3 * 86_400_000);
    await prisma.badge.create({
      data: { workspaceId: WS, key: BadgeKey.TenStepsDay, earnedAt: earlier },
    });

    const { deleteBrainDumpItem } = await import("./braindump");
    await deleteBrainDumpItem(item.id);

    expect(await hasBadge(WS, BadgeKey.TenStepsDay)).toBe(true);
  });

  it("leaves a badge this delete cannot have contributed to alone", async () => {
    // Deleting a completed to-do cannot un-earn "you broke something down" or
    // "your first focus session". Only the badges whose qualifying condition is
    // recomputable from what the delete changed are in scope.
    const { item } = await completedTodo({ steps: 1 });
    await prisma.badge.createMany({
      data: [
        { workspaceId: WS, key: BadgeKey.FirstBreakdown },
        { workspaceId: WS, key: BadgeKey.FirstFocus },
        { workspaceId: WS, key: BadgeKey.Streak5 },
      ],
    });

    const { deleteBrainDumpItem } = await import("./braindump");
    await deleteBrainDumpItem(item.id);

    expect(await hasBadge(WS, BadgeKey.FirstBreakdown)).toBe(true);
    expect(await hasBadge(WS, BadgeKey.FirstFocus)).toBe(true);
    expect(await hasBadge(WS, BadgeKey.Streak5)).toBe(true);
  });

  it("does not revoke a badge when the delete reversed nothing", async () => {
    // An item that banked nothing — never completed, no done steps — must not
    // take a badge with it just because the workspace happens to look
    // unqualified (a reopen leaves exactly that state behind).
    const task = await prisma.task.create({
      data: { title: "open", workspaceId: WS },
    });
    const item = await prisma.brainDumpItem.create({
      data: { text: "open", workspaceId: WS, taskId: task.id, status: "inbox" },
    });
    await prisma.badge.create({
      data: { workspaceId: WS, key: BadgeKey.TaskComplete },
    });

    const { deleteBrainDumpItem } = await import("./braindump");
    await deleteBrainDumpItem(item.id);

    expect(await hasBadge(WS, BadgeKey.TaskComplete)).toBe(true);
  });

  it("a step-only reversal does not take task_complete with it", async () => {
    // The `isFullyDone` route: every step ticked, `completedAt` never stamped, so
    // the delete owes `step_done` and no `task_complete`. The badge here was
    // earned by a DIFFERENT to-do that has since been reopened or deleted, which
    // is why the workspace already looks unqualified. Recomputing the condition
    // and revoking on it would be taking away something this delete had no part
    // in — so each badge is gated on the reversal that could actually have
    // un-qualified it, not merely on the delete having reversed something.
    const { item } = await completedTodo({ steps: 2, completed: false });
    await prisma.badge.create({
      data: { workspaceId: WS, key: BadgeKey.TaskComplete },
    });

    const { deleteBrainDumpItem } = await import("./braindump");
    await deleteBrainDumpItem(item.id);

    expect(await countRewards(WS, RewardType.StepDone)).toBe(0); // it did reverse
    expect(await hasBadge(WS, BadgeKey.TaskComplete)).toBe(true);
  });

  it("a completion-only reversal does not take ten_steps_day with it", async () => {
    // The mirror case. A stepless completed to-do owes a `task_complete` and no
    // `step_done`, so today's step count is untouched and the day's badge is not
    // this delete's business — even though the workspace holds fewer than ten.
    const { item } = await completedTodo({ steps: 0 });
    await bank(WS, RewardType.StepDone, 4);
    await prisma.badge.create({
      data: {
        workspaceId: WS,
        key: BadgeKey.TenStepsDay,
        earnedAt: new Date(),
      },
    });

    const { deleteBrainDumpItem } = await import("./braindump");
    await deleteBrainDumpItem(item.id);

    expect(await countRewards(WS, RewardType.TaskComplete)).toBe(0); // it did reverse
    expect(await hasBadge(WS, BadgeKey.TenStepsDay)).toBe(true);
  });
});

/**
 * #251 review — the reversal must take back the DELETED ITEM's points, not the
 * newest points in the workspace.
 *
 * `reverseLatestReward` takes "the newest row of that type", and the docblock on
 * `reverseStepCompletionRewards` rested that whole design on one claim: *within a
 * type, which row goes is unobservable*. `revokeUnqualifiedBadges` is the first
 * per-day read of `RewardEvent` in a reversal path, and it falsifies that claim —
 * it recounts `step_done` rows from `startOfToday()`, so a delete that consumed
 * today's rows to pay for an earlier day's work drops today's count and revokes a
 * badge earned today by work that still exists.
 *
 * Measured before the fix: `step_done×13, stepsToday=10, ten_steps_day held` →
 * delete an item completed yesterday → `step_done×10, stepsToday=7, badge gone`.
 */
describe("deleteBrainDumpItem — which rows come back (#251 review)", () => {
  const yesterday = () => new Date(Date.now() - 86_400_000);
  const startOfToday = () => {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return d;
  };
  const stepsToday = () =>
    prisma.rewardEvent.count({
      where: {
        workspaceId: WS,
        type: RewardType.StepDone,
        createdAt: { gte: startOfToday() },
      },
    });
  const totalPoints = async () =>
    (
      await prisma.rewardEvent.aggregate({
        where: { workspaceId: WS },
        _sum: { points: true },
      })
    )._sum.points ?? 0;

  it("keeps a ten_steps_day earned today when the deleted item was finished yesterday", async () => {
    // Complete a to-do Monday; do ten steps Tuesday and earn the badge; delete
    // Monday's row from the Library's Done tab on Tuesday. Every one of those is
    // an ordinary press, and the badge was earned by ten steps that still exist.
    const { item } = await completedTodo({ steps: 3, at: yesterday() });
    await bank(WS, RewardType.StepDone, 10); // today's ten, still standing
    await prisma.badge.create({
      data: {
        workspaceId: WS,
        key: BadgeKey.TenStepsDay,
        earnedAt: new Date(),
      },
    });
    expect(await countRewards(WS, RewardType.StepDone)).toBe(13);
    expect(await stepsToday()).toBe(10);

    const { deleteBrainDumpItem } = await import("./braindump");
    await deleteBrainDumpItem(item.id);

    expect(await countRewards(WS, RewardType.StepDone)).toBe(10);
    // The assertion the whole case exists for: the three rows that went were
    // YESTERDAY's, so today is untouched and the day's badge still qualifies.
    expect(await stepsToday()).toBe(10);
    expect(await hasBadge(WS, BadgeKey.TenStepsDay)).toBe(true);
  });

  it("still takes back exactly what the item banked — nothing more, nothing less", async () => {
    // The bound must not turn into "reverse less". The arithmetic is the same
    // arithmetic as an unbounded reversal; only the choice of rows differs.
    const { item } = await completedTodo({ steps: 3, at: yesterday() });
    await bank(WS, RewardType.StepDone, 10);
    const before = await totalPoints();

    const { deleteBrainDumpItem } = await import("./braindump");
    await deleteBrainDumpItem(item.id);

    expect(before - (await totalPoints())).toBe(
      3 * RewardPoints[RewardType.StepDone] +
        RewardPoints[RewardType.TaskComplete],
    );
  });

  it("takes today's rows when the item was completed today — the bound is not a filter", async () => {
    // The negative control. A bound that excluded the item's own rows would look
    // identical to the fix on the case above and be wrong on the common one:
    // almost every delete is of something finished the same day.
    const { item } = await completedTodo({ steps: 2 });
    expect(await stepsToday()).toBe(2);

    const { deleteBrainDumpItem } = await import("./braindump");
    await deleteBrainDumpItem(item.id);

    expect(await stepsToday()).toBe(0);
  });

  it("falls back past the bound rather than stopping short of what it owes", async () => {
    // The floor is unchanged: the workspace owes 3 and holds only 1 row inside
    // the bound, so the reversal keeps going into the unbounded set rather than
    // leaving two payouts banked forever. An inconsistent store (a reopen already
    // took some, or the rows predate the reward table) must not become a
    // permanent over-payment — the same reasoning the floor guard above carries.
    const { item } = await completedTodo({ steps: 3, at: yesterday() });
    await prisma.rewardEvent.deleteMany({
      where: { workspaceId: WS, type: RewardType.StepDone },
    });
    await bank(WS, RewardType.StepDone, 1, new Date(Date.now() - 86_400_000));
    await bank(WS, RewardType.StepDone, 5);

    const { deleteBrainDumpItem } = await import("./braindump");
    await deleteBrainDumpItem(item.id);

    expect(await countRewards(WS, RewardType.StepDone)).toBe(3);
  });

  it("takes the item's OWN task_complete, which is banked after the stamp", async () => {
    // Why the bound is on the step rows only, stated as a test rather than as a
    // comment nobody can check. `completeItem` logs `step_done` BEFORE stamping
    // `completedAt` and `task_complete` AFTER it — measured on real Postgres at
    // -2ms and +3ms — so `completedAt` covers the item's step rows and EXCLUDES
    // its own completion row. Bounding `task_complete` by it would reach past the
    // item's row to an older one every time, which is the defect being fixed
    // wearing the fix's clothes.
    //
    // Here the workspace holds one older `task_complete` from a to-do completed
    // three days ago that still exists; deleting yesterday's must take
    // yesterday's, leaving the older one alone.
    const older = new Date(Date.now() - 3 * 86_400_000);
    await completedTodo({ steps: 0, at: older });
    const { item } = await completedTodo({ steps: 0, at: yesterday() });
    expect(await countRewards(WS, RewardType.TaskComplete)).toBe(2);

    const { deleteBrainDumpItem } = await import("./braindump");
    await deleteBrainDumpItem(item.id);

    const left = await prisma.rewardEvent.findMany({
      where: { workspaceId: WS, type: RewardType.TaskComplete },
      select: { createdAt: true },
    });
    expect(left).toHaveLength(1);
    // The survivor is the OLD one: the row that went was the deleted item's.
    expect(left[0].createdAt.getTime()).toBeLessThan(yesterday().getTime());
  });
});

describe("deleteBrainDumpItem — the inbox-zero award it must not re-pay (#251)", () => {
  // `maybeAwardInboxZero` counts `status: Inbox, completedAt: null`. A completed
  // item is excluded from that count by BOTH halves of the predicate, so deleting
  // one cannot lower it — the queue it measures is the same size before and
  // after. Calling the award anyway can only re-pay an inbox zero the workspace
  // was already sitting on, which is the "delete a demo item, gain 15 points"
  // shape #251 exists to remove. For an item that is still untriaged the call is
  // correct and has to stay, hence the control below.
  it("does not run the award when the deleted item was completed", async () => {
    const rewards = await import("@/lib/rewards");
    const item = await prisma.brainDumpItem.create({
      data: {
        text: "a demo item, already done",
        workspaceId: WS,
        status: "inbox",
        completedAt: new Date(),
      },
    });
    vi.mocked(rewards.maybeAwardInboxZero).mockClear();

    const { deleteBrainDumpItem } = await import("./braindump");
    await deleteBrainDumpItem(item.id);

    expect(await prisma.brainDumpItem.count({ where: { id: item.id } })).toBe(
      0,
    );
    expect(rewards.maybeAwardInboxZero).not.toHaveBeenCalled();
  });

  it("still runs the award when the deleted item was untriaged", async () => {
    // The negative control. Deleting an untriaged row genuinely can empty the
    // queue, so gating the award must not reach this path — without this case a
    // gate that removed the call outright would pass the test above.
    const rewards = await import("@/lib/rewards");
    const item = await prisma.brainDumpItem.create({
      data: {
        text: "still needs triage",
        workspaceId: WS,
        status: "inbox",
        completedAt: null,
      },
    });
    vi.mocked(rewards.maybeAwardInboxZero).mockClear();

    const { deleteBrainDumpItem } = await import("./braindump");
    await deleteBrainDumpItem(item.id);

    expect(await prisma.brainDumpItem.count({ where: { id: item.id } })).toBe(
      0,
    );
    expect(rewards.maybeAwardInboxZero).toHaveBeenCalledWith(WS);
  });

  // ── #251 review — the sibling leak `c7a53b7` left open ────────────────────
  //
  // `c7a53b7` closed this for COMPLETED rows by gating on `tookCompletion === 0`,
  // and a row that banked `step_done` but was never `completedAt`-stamped reads 0
  // there too. That is the partially-worked shape this issue added a reversal test
  // for ("an item that was never completed still gives back its done steps"), and
  // it was waved straight through to the award: a user does 1 of 3 steps, decides
  // it isn't worth doing, deletes it, and their score goes UP.
  //
  // The fix is the predicate itself rather than a third boolean.
  // `maybeAwardInboxZero` counts `status: Inbox AND completedAt: null AND not
  // snoozed into the future`, and `tookCompletion === 0` re-tests one third of
  // that. The comment on the gate declined to restate the rest because two copies
  // of "what counts as untriaged" would drift — so the definition moved into
  // `inbox-zero-queue.ts` and both sides read it, and
  // `inbox-zero-queue.integration.test.ts` is what fails if the SQL shape and the
  // row shape ever disagree.
  describe("a partially-worked row that was never completed", () => {
    /** 3 steps, `done` of them ticked, triaged, `completedAt` never stamped. */
    const partiallyWorked = async (done: number, status = "triaged") => {
      const task = await prisma.task.create({
        data: { title: "1 of 3", workspaceId: WS },
      });
      await prisma.step.createMany({
        data: [1, 2, 3].map((i) => ({
          taskId: task.id,
          text: `step ${i}`,
          order: i,
          total: 3,
          estMinutes: 5,
          done: i <= done,
        })),
      });
      const item = await prisma.brainDumpItem.create({
        data: { text: "1 of 3", workspaceId: WS, taskId: task.id, status },
      });
      await bank(WS, RewardType.StepDone, done);
      return item;
    };
    const points = async () =>
      (
        await prisma.rewardEvent.aggregate({
          where: { workspaceId: WS },
          _sum: { points: true },
        })
      )._sum.points ?? 0;

    it("does not pay 15 points and a free inbox_zero for deleting it", async () => {
      // The real award, not the stub, because the measurement IS the defect:
      // took back 10, paid out 15.
      const rewards = await import("@/lib/rewards");
      const real =
        await vi.importActual<typeof import("@/lib/rewards")>("@/lib/rewards");
      vi.mocked(rewards.maybeAwardInboxZero).mockImplementationOnce(
        real.maybeAwardInboxZero,
      );
      const item = await partiallyWorked(1);
      expect(await points()).toBe(10);
      expect(await hasBadge(WS, BadgeKey.InboxZero)).toBe(false);

      const { deleteBrainDumpItem } = await import("./braindump");
      await deleteBrainDumpItem(item.id);

      // Measured before the fix: `pts=15, inbox_zero×1, badges=[inbox_zero]`.
      expect(await points()).toBe(0);
      expect(await countRewards(WS, RewardType.InboxZero)).toBe(0);
      expect(await hasBadge(WS, BadgeKey.InboxZero)).toBe(false);
    });

    it("does not run the award for a triaged row at all, worked or not", async () => {
      // The general form, and why this is the predicate rather than "did it bank
      // anything": a triaged row was never in the count, so removing it cannot
      // have lowered it, whatever it had done.
      const rewards = await import("@/lib/rewards");
      const item = await partiallyWorked(0);
      vi.mocked(rewards.maybeAwardInboxZero).mockClear();

      const { deleteBrainDumpItem } = await import("./braindump");
      await deleteBrainDumpItem(item.id);

      expect(rewards.maybeAwardInboxZero).not.toHaveBeenCalled();
    });

    it("does not run the award for a row snoozed into the future", async () => {
      // The third of the three terms, and the one the gate could not see at all
      // before the predicate was shared. A snoozed row is not in the count
      // either, so deleting it cannot empty the queue.
      const rewards = await import("@/lib/rewards");
      const item = await prisma.brainDumpItem.create({
        data: {
          text: "not until tomorrow",
          workspaceId: WS,
          status: "inbox",
          snoozedUntil: new Date(Date.now() + 86_400_000),
        },
      });
      vi.mocked(rewards.maybeAwardInboxZero).mockClear();

      const { deleteBrainDumpItem } = await import("./braindump");
      await deleteBrainDumpItem(item.id);

      expect(rewards.maybeAwardInboxZero).not.toHaveBeenCalled();
    });

    it("still runs the award for an UNTRIAGED row that had steps worked on it", async () => {
      // The control that keeps the fix from being "never award on a delete".
      // ▶ Focus gives an item a Task and a Step without triaging it, so an
      // untriaged row CAN carry a done step — and it was genuinely in the queue,
      // so removing it genuinely can empty it. The award is correct here.
      const rewards = await import("@/lib/rewards");
      const item = await partiallyWorked(1, "inbox");
      vi.mocked(rewards.maybeAwardInboxZero).mockClear();

      const { deleteBrainDumpItem } = await import("./braindump");
      await deleteBrainDumpItem(item.id);

      expect(rewards.maybeAwardInboxZero).toHaveBeenCalledWith(WS);
    });
  });
});
