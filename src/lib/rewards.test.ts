import { describe, it, expect, vi, beforeEach } from "vitest";

// Unit test for the once-only badge award (issue #21 P5.2), re-pointed at the
// non-raising shape in #158. `prisma.badge` is mocked; what these prove is the
// SHAPE and the return value — that a duplicate is resolved by
// `createMany({ skipDuplicates: true })` returning `count: 0` rather than by a
// rejection somebody catches. They cannot prove the log line is gone, because
// the log line comes from a real client talking to a real Postgres: that half
// is `src/lib/__tests__/handled-p2002.integration.test.ts`.
const { prismaMock } = vi.hoisted(() => ({
  prismaMock: {
    // `create` is mocked even though nothing should call it any more: a silent
    // regression back to create-and-catch is exactly what this file guards.
    badge: { findUnique: vi.fn(), create: vi.fn(), createMany: vi.fn() },
    // #198 — reverseStepDoneReward reads the newest step_done row and removes it.
    // `delete` is mocked even though nothing should call it any more, for the
    // same reason `badge.create` is: a silent regression back to the raising
    // shape is exactly what this file guards. See the lost-race test below.
    rewardEvent: { findFirst: vi.fn(), delete: vi.fn(), deleteMany: vi.fn() },
  },
}));

vi.mock("@/lib/db", () => ({
  prisma: prismaMock,
  getSettings: vi.fn(),
  getStreak: vi.fn(),
}));

import type { Prisma } from "@prisma/client";
import {
  awardBadge,
  reverseStepCompletionRewards,
  reverseItemCompletionRewards,
} from "./rewards";
import { BadgeKey, RewardType } from "./constants";

class FakeOtherError extends Error {
  code = "P1001";
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("awardBadge — once-only, and never raises on a duplicate (#158)", () => {
  it("happy path: no existing badge → inserts one row and returns true", async () => {
    prismaMock.badge.findUnique.mockResolvedValue(null);
    prismaMock.badge.createMany.mockResolvedValue({ count: 1 });

    expect(await awardBadge("ws", BadgeKey.Streak5)).toBe(true);
    // `skipDuplicates` is the load-bearing flag: it is what makes Prisma emit
    // INSERT ... ON CONFLICT DO NOTHING, so a concurrent award loses silently
    // instead of raising P2002 and printing `prisma:error`.
    expect(prismaMock.badge.createMany).toHaveBeenCalledWith({
      data: { key: BadgeKey.Streak5, workspaceId: "ws" },
      skipDuplicates: true,
    });
    expect(prismaMock.badge.create).not.toHaveBeenCalled();
  });

  it("pre-existing badge → returns false without attempting a write", async () => {
    prismaMock.badge.findUnique.mockResolvedValue({ id: "b1" });

    expect(await awardBadge("ws", BadgeKey.Streak5)).toBe(false);
    expect(prismaMock.badge.createMany).not.toHaveBeenCalled();
    expect(prismaMock.badge.create).not.toHaveBeenCalled();
  });

  it("concurrent award race: nothing inserted → false, and nothing raised", async () => {
    // ON CONFLICT DO NOTHING skipped the row, so Prisma resolves with count 0.
    // Crucially it does NOT reject, so there is nothing for the client-level
    // logger to print (#158).
    prismaMock.badge.findUnique.mockResolvedValue(null);
    prismaMock.badge.createMany.mockResolvedValue({ count: 0 });

    await expect(awardBadge("ws", BadgeKey.Streak5)).resolves.toBe(false);
  });

  it("a genuine database failure still reaches the caller, unmasked", async () => {
    prismaMock.badge.findUnique.mockResolvedValue(null);
    prismaMock.badge.createMany.mockRejectedValue(
      new FakeOtherError("connection lost"),
    );

    await expect(awardBadge("ws", BadgeKey.Streak5)).rejects.toMatchObject({
      code: "P1001",
    });
  });
});

describe("reverseStepCompletionRewards — undoing a step completion (#198)", () => {
  it("removes the most recent step_done row and reports it", async () => {
    prismaMock.rewardEvent.findFirst.mockResolvedValue({ id: "re-9" });
    prismaMock.rewardEvent.deleteMany.mockResolvedValue({ count: 1 });

    expect(
      await reverseStepCompletionRewards("ws", { includeTaskComplete: false }),
    ).toEqual({ stepDone: true, taskComplete: false });

    // The read carries the workspace scope; the delete then goes by the id it
    // returned, which is why the read must be both filtered and ordered.
    expect(prismaMock.rewardEvent.findFirst).toHaveBeenCalledWith({
      where: { workspaceId: "ws", type: RewardType.StepDone },
      orderBy: { createdAt: "desc" },
      select: { id: true },
    });
    // `workspaceId` in the delete's own filter, not just the read's: `deleteMany`
    // is a bulk op, so `scoping.harness.test.ts` requires the scope in its
    // arguments rather than inherited from the read above (the by-id `delete` this
    // replaced was accepted under the primary-key rule instead).
    expect(prismaMock.rewardEvent.deleteMany).toHaveBeenCalledWith({
      where: { id: "re-9", workspaceId: "ws" },
    });
    expect(prismaMock.rewardEvent.delete).not.toHaveBeenCalled();
  });

  // Review round 3: `markTaskCompleted` logs `task_complete` every time a step
  // closes its task, and `logReward` has no idempotency guard, so the farm this
  // whole feature closes for `step_done` was left open one level up.
  it("also removes a task_complete row when asked", async () => {
    prismaMock.rewardEvent.findFirst.mockResolvedValue({ id: "re-1" });
    prismaMock.rewardEvent.deleteMany.mockResolvedValue({ count: 1 });

    expect(
      await reverseStepCompletionRewards("ws", { includeTaskComplete: true }),
    ).toEqual({ stepDone: true, taskComplete: true });

    expect(types()).toEqual([RewardType.StepDone, RewardType.TaskComplete]);
    expect(prismaMock.rewardEvent.deleteMany).toHaveBeenCalledTimes(2);
  });

  it("leaves task_complete alone when no task was reopened", async () => {
    prismaMock.rewardEvent.findFirst.mockResolvedValue({ id: "re-1" });
    prismaMock.rewardEvent.deleteMany.mockResolvedValue({ count: 1 });

    await reverseStepCompletionRewards("ws", { includeTaskComplete: false });

    // A task that never closed never earned one, so reversing here would take
    // points from a different, genuinely finished task.
    expect(types()).not.toContain(RewardType.TaskComplete);
    expect(prismaMock.rewardEvent.deleteMany).toHaveBeenCalledTimes(1);
  });

  // Rounds 2 and 3 together. Round 2 flagged that `session_finished` was not
  // reversed; round 3 showed the conditional reversal was the wrong remedy. It is
  // now never reversed, on the same reasoning that keeps the streak: it pays for
  // time genuinely spent, and re-completing through the timer needs a NEW
  // FocusSession, so a second row is paid for by a second real session. This test
  // exists so that decision cannot be quietly reverted.
  it("NEVER removes a session_finished row, on either path", async () => {
    prismaMock.rewardEvent.findFirst.mockResolvedValue({ id: "re-1" });
    prismaMock.rewardEvent.deleteMany.mockResolvedValue({ count: 1 });

    await reverseStepCompletionRewards("ws", { includeTaskComplete: true });
    await reverseStepCompletionRewards("ws", { includeTaskComplete: false });

    expect(types()).not.toContain(RewardType.SessionFinished);
  });

  it("nothing to reverse is a normal answer, not an error", async () => {
    prismaMock.rewardEvent.findFirst.mockResolvedValue(null);

    expect(
      await reverseStepCompletionRewards("ws", { includeTaskComplete: true }),
    ).toEqual({ stepDone: false, taskComplete: false });
    // Deleting on a null read would throw on a real client; reporting false lets
    // the caller carry on un-completing, which is the user's actual intent.
    expect(prismaMock.rewardEvent.deleteMany).not.toHaveBeenCalled();
  });

  // Review round 4. The findFirst→delete pair is a TOCTOU, exactly like
  // `awardBadge`'s findUnique→create above, and it had the same fix applied to
  // the other one back in #158 but never to this one: two concurrent reversals
  // both read the same newest row, the loser's `delete` finds it already gone and
  // Prisma raises P2025. That throw is what made a failed undo unretryable — the
  // step write had already committed, so the retry hit `if (!step.done) return`
  // and the reward stayed banked forever. `deleteMany` removes the race at its
  // source: it compiles to a plain DELETE and reports `count: 0` rather than
  // raising, so the loser is simply told it lost.
  it("a lost race — the row went between the read and the delete — is false, not a throw", async () => {
    prismaMock.rewardEvent.findFirst.mockResolvedValue({ id: "re-9" });
    prismaMock.rewardEvent.deleteMany.mockResolvedValue({ count: 0 });

    await expect(
      reverseStepCompletionRewards("ws", { includeTaskComplete: true }),
    ).resolves.toEqual({ stepDone: false, taskComplete: false });
  });

  it("a genuine database failure still reaches the caller, unmasked", async () => {
    // The point of `deleteMany` is to stop treating a lost race as an error, NOT
    // to swallow errors: a dead connection must still abort the undo (and, at the
    // call site, roll the step write back with it).
    prismaMock.rewardEvent.findFirst.mockResolvedValue({ id: "re-9" });
    prismaMock.rewardEvent.deleteMany.mockRejectedValue(
      new FakeOtherError("connection lost"),
    );

    await expect(
      reverseStepCompletionRewards("ws", { includeTaskComplete: false }),
    ).rejects.toMatchObject({ code: "P1001" });
  });

  // Review round 4 — the other half of the fix. `uncompleteStep` now runs the
  // step write and this reversal in ONE interactive transaction, so that a
  // failing reversal rolls the step back and leaves the undo retryable. That only
  // works if the reversal actually joins the transaction, which means running on
  // the `tx` client rather than on the module-level singleton — a call that
  // quietly used `prisma` would commit outside the transaction and be immune to
  // its rollback, which is the bug wearing the fix's clothes.
  it("runs on the transaction client it is handed, not the singleton", async () => {
    const tx = {
      rewardEvent: {
        findFirst: vi.fn().mockResolvedValue({ id: "re-tx" }),
        deleteMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
    };

    expect(
      await reverseStepCompletionRewards(
        "ws",
        { includeTaskComplete: true },
        tx as unknown as Prisma.TransactionClient,
      ),
    ).toEqual({ stepDone: true, taskComplete: true });

    expect(tx.rewardEvent.deleteMany).toHaveBeenCalledTimes(2);
    expect(prismaMock.rewardEvent.findFirst).not.toHaveBeenCalled();
    expect(prismaMock.rewardEvent.deleteMany).not.toHaveBeenCalled();
  });

  it("still defaults to the singleton when no transaction is passed", async () => {
    prismaMock.rewardEvent.findFirst.mockResolvedValue({ id: "re-1" });
    prismaMock.rewardEvent.deleteMany.mockResolvedValue({ count: 1 });

    await reverseStepCompletionRewards("ws", { includeTaskComplete: false });

    expect(prismaMock.rewardEvent.deleteMany).toHaveBeenCalledTimes(1);
  });

  /** Reward types the mock was asked for, in call order. */
  function types(): string[] {
    return prismaMock.rewardEvent.findFirst.mock.calls.map(
      (c) => (c[0] as { where: { type: string } }).where.type,
    );
  }
});

/**
 * #196 — `reopenItem` un-completes a WHOLE to-do, so it can undo several step
 * completions in one action. `reverseStepCompletionRewards` takes back exactly
 * one `step_done`, which is right for `uncompleteStep` and one short per extra
 * step here.
 *
 * The rule is unchanged, only the arity: a reward comes back when the same work
 * could otherwise be paid for twice. Reopening a five-step to-do and completing
 * it again would bank five `step_done` rows for work already paid for.
 */
describe("reverseItemCompletionRewards — undoing a whole to-do (#196)", () => {
  /** Reward types the mock was asked for, in call order. */
  function types(): string[] {
    return prismaMock.rewardEvent.findFirst.mock.calls.map(
      (c) => (c[0] as { where: { type: string } }).where.type,
    );
  }

  it("takes back one step_done per step the reopen actually un-completed", async () => {
    prismaMock.rewardEvent.findFirst.mockResolvedValue({ id: "re-9" });
    prismaMock.rewardEvent.deleteMany.mockResolvedValue({ count: 1 });

    expect(
      await reverseItemCompletionRewards("ws", {
        stepDone: 3,
        includeTaskComplete: false,
      }),
    ).toEqual({ stepDone: 3, taskComplete: false });

    expect(types()).toEqual([
      RewardType.StepDone,
      RewardType.StepDone,
      RewardType.StepDone,
    ]);
  });

  it("reverses task_complete once alongside them", async () => {
    prismaMock.rewardEvent.findFirst.mockResolvedValue({ id: "re-9" });
    prismaMock.rewardEvent.deleteMany.mockResolvedValue({ count: 1 });

    expect(
      await reverseItemCompletionRewards("ws", {
        stepDone: 2,
        includeTaskComplete: true,
      }),
    ).toEqual({ stepDone: 2, taskComplete: true });

    expect(types()).toEqual([
      RewardType.StepDone,
      RewardType.StepDone,
      RewardType.TaskComplete,
    ]);
  });

  // A stepless to-do earns a `task_complete` and no `step_done` at all, so the
  // two counts have to move independently. Asking for one step_done regardless
  // — which reusing `reverseStepCompletionRewards` in a loop would force — would
  // take back the newest step_done in the WORKSPACE, belonging to unrelated work.
  it("reverses task_complete alone when the to-do had no steps to un-complete", async () => {
    prismaMock.rewardEvent.findFirst.mockResolvedValue({ id: "re-9" });
    prismaMock.rewardEvent.deleteMany.mockResolvedValue({ count: 1 });

    expect(
      await reverseItemCompletionRewards("ws", {
        stepDone: 0,
        includeTaskComplete: true,
      }),
    ).toEqual({ stepDone: 0, taskComplete: true });

    expect(types()).toEqual([RewardType.TaskComplete]);
  });

  it("does nothing at all when there is nothing to take back", async () => {
    prismaMock.rewardEvent.findFirst.mockResolvedValue({ id: "re-9" });

    expect(
      await reverseItemCompletionRewards("ws", {
        stepDone: 0,
        includeTaskComplete: false,
      }),
    ).toEqual({ stepDone: 0, taskComplete: false });

    expect(prismaMock.rewardEvent.findFirst).not.toHaveBeenCalled();
    expect(prismaMock.rewardEvent.deleteMany).not.toHaveBeenCalled();
  });

  // Stops rather than spinning: once the workspace has no `step_done` left, the
  // remaining requests cannot find one either, and each would be a wasted round
  // trip inside somebody's open transaction.
  it("stops as soon as the workspace runs out of rows to reverse", async () => {
    prismaMock.rewardEvent.findFirst
      .mockResolvedValueOnce({ id: "re-9" })
      .mockResolvedValue(null);
    prismaMock.rewardEvent.deleteMany.mockResolvedValue({ count: 1 });

    expect(
      await reverseItemCompletionRewards("ws", {
        stepDone: 4,
        includeTaskComplete: false,
      }),
    ).toEqual({ stepDone: 1, taskComplete: false });

    expect(prismaMock.rewardEvent.findFirst).toHaveBeenCalledTimes(2);
    expect(prismaMock.rewardEvent.deleteMany).toHaveBeenCalledTimes(1);
  });

  // The reversals are strictly sequential, and must be: each one reads "the
  // newest row of this type" and then deletes it, so running them together
  // would have every request read the SAME row and only one delete land.
  it("never reverses in parallel — each read must see the previous delete", async () => {
    let inFlight = 0;
    let peak = 0;
    prismaMock.rewardEvent.findFirst.mockImplementation(async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await Promise.resolve();
      inFlight -= 1;
      return { id: "re-9" };
    });
    prismaMock.rewardEvent.deleteMany.mockResolvedValue({ count: 1 });

    await reverseItemCompletionRewards("ws", {
      stepDone: 3,
      includeTaskComplete: true,
    });

    expect(peak).toBe(1);
  });

  it("runs on the transaction client it is handed, not the singleton", async () => {
    const tx = {
      rewardEvent: {
        findFirst: vi.fn().mockResolvedValue({ id: "re-tx" }),
        deleteMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
    };

    await reverseItemCompletionRewards(
      "ws",
      { stepDone: 2, includeTaskComplete: true },
      tx as unknown as Prisma.TransactionClient,
    );

    expect(tx.rewardEvent.deleteMany).toHaveBeenCalledTimes(3);
    expect(prismaMock.rewardEvent.deleteMany).not.toHaveBeenCalled();
  });

  it("a genuine database failure still reaches the caller, unmasked", async () => {
    prismaMock.rewardEvent.findFirst.mockResolvedValue({ id: "re-9" });
    prismaMock.rewardEvent.deleteMany.mockRejectedValue(
      new FakeOtherError("connection lost"),
    );

    await expect(
      reverseItemCompletionRewards("ws", {
        stepDone: 2,
        includeTaskComplete: false,
      }),
    ).rejects.toMatchObject({ code: "P1001" });
  });
});
