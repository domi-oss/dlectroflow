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
    rewardEvent: { findFirst: vi.fn(), delete: vi.fn() },
  },
}));

vi.mock("@/lib/db", () => ({
  prisma: prismaMock,
  getSettings: vi.fn(),
  getStreak: vi.fn(),
}));

import { awardBadge, reverseStepCompletionRewards } from "./rewards";
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
    prismaMock.rewardEvent.delete.mockResolvedValue({});

    expect(
      await reverseStepCompletionRewards("ws", {
        includeSessionFinished: false,
      }),
    ).toEqual({ stepDone: true, sessionFinished: false });

    // The read carries the workspace scope; the delete then goes by the id it
    // returned, which is why the read must be both filtered and ordered.
    expect(prismaMock.rewardEvent.findFirst).toHaveBeenCalledWith({
      where: { workspaceId: "ws", type: RewardType.StepDone },
      orderBy: { createdAt: "desc" },
      select: { id: true },
    });
    expect(prismaMock.rewardEvent.delete).toHaveBeenCalledWith({
      where: { id: "re-9" },
    });
  });

  // Duo review round 2. `completeFocus` logs BOTH rewards for one step, and the
  // undo added in #198 lives on the timer's done screen — exactly that path — so
  // reversing only step_done left session_finished farmable.
  it("also removes a session_finished row when asked, and only then", async () => {
    prismaMock.rewardEvent.findFirst.mockResolvedValue({ id: "re-1" });
    prismaMock.rewardEvent.delete.mockResolvedValue({});

    expect(
      await reverseStepCompletionRewards("ws", {
        includeSessionFinished: true,
      }),
    ).toEqual({ stepDone: true, sessionFinished: true });

    const types = prismaMock.rewardEvent.findFirst.mock.calls.map(
      (c) => (c[0] as { where: { type: string } }).where.type,
    );
    expect(types).toEqual([RewardType.StepDone, RewardType.SessionFinished]);
    expect(prismaMock.rewardEvent.delete).toHaveBeenCalledTimes(2);
  });

  it("leaves session_finished alone when the completion had no session", async () => {
    prismaMock.rewardEvent.findFirst.mockResolvedValue({ id: "re-1" });
    prismaMock.rewardEvent.delete.mockResolvedValue({});

    await reverseStepCompletionRewards("ws", { includeSessionFinished: false });

    // Reversing one here would take back points a DIFFERENT, genuinely finished
    // session earned — the one case where "which row goes is unobservable" stops
    // being true, because the types are not interchangeable.
    const types = prismaMock.rewardEvent.findFirst.mock.calls.map(
      (c) => (c[0] as { where: { type: string } }).where.type,
    );
    expect(types).not.toContain(RewardType.SessionFinished);
    expect(prismaMock.rewardEvent.delete).toHaveBeenCalledTimes(1);
  });

  it("touches no other reward type at all", async () => {
    prismaMock.rewardEvent.findFirst.mockResolvedValue({ id: "re-1" });
    await reverseStepCompletionRewards("ws", { includeSessionFinished: true });
    const types = prismaMock.rewardEvent.findFirst.mock.calls.map(
      (c) => (c[0] as { where: { type: string } }).where.type,
    );
    // task_complete in particular: closing a task is its own achievement and
    // un-completing one step of it does not undo that.
    expect(types).not.toContain(RewardType.TaskComplete);
  });

  it("nothing to reverse is a normal answer, not an error", async () => {
    prismaMock.rewardEvent.findFirst.mockResolvedValue(null);

    expect(
      await reverseStepCompletionRewards("ws", {
        includeSessionFinished: true,
      }),
    ).toEqual({ stepDone: false, sessionFinished: false });
    // Deleting on a null read would throw on a real client; reporting false lets
    // the caller carry on un-completing, which is the user's actual intent.
    expect(prismaMock.rewardEvent.delete).not.toHaveBeenCalled();
  });
});
