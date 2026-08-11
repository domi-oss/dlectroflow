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

/** Bank `n` reward rows of one type — what a completion would have paid. */
async function bank(workspaceId: string, type: string, n: number) {
  if (!n) return;
  await prisma.rewardEvent.createMany({
    data: Array.from({ length: n }, () => ({
      type,
      points: RewardPoints[type as keyof typeof RewardPoints],
      workspaceId,
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
}: { steps?: number; completed?: boolean; workspaceId?: string } = {}) {
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
      completedAt: completed ? new Date() : null,
    },
  });
  await bank(workspaceId, RewardType.StepDone, steps);
  if (completed) await bank(workspaceId, RewardType.TaskComplete, 1);
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

    const { deleteBrainDumpItem } = await import("./braindump");
    await Promise.all([
      deleteBrainDumpItem(item.id),
      deleteBrainDumpItem(item.id),
    ]);

    expect(await countRewards(WS, RewardType.StepDone)).toBe(1);
    expect(await countRewards(WS, RewardType.TaskComplete)).toBe(1);
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
