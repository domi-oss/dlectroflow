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

import { awardBadge, reverseStepDoneReward } from "./rewards";
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

describe("reverseStepDoneReward — undoing a step completion (#198)", () => {
  it("removes the most recent step_done row in that workspace and reports it", async () => {
    prismaMock.rewardEvent.findFirst.mockResolvedValue({ id: "re-9" });
    prismaMock.rewardEvent.delete.mockResolvedValue({});

    expect(await reverseStepDoneReward("ws")).toBe(true);

    // The read is what carries the workspace scope; the delete then goes by the
    // id it returned, which is why the read must be filtered and ordered.
    expect(prismaMock.rewardEvent.findFirst).toHaveBeenCalledWith({
      where: { workspaceId: "ws", type: RewardType.StepDone },
      orderBy: { createdAt: "desc" },
      select: { id: true },
    });
    expect(prismaMock.rewardEvent.delete).toHaveBeenCalledWith({
      where: { id: "re-9" },
    });
  });

  it("takes back a step_done and nothing else — no other reward type is touched", async () => {
    prismaMock.rewardEvent.findFirst.mockResolvedValue({ id: "re-1" });
    await reverseStepDoneReward("ws");
    // A task_complete or session_finished row must survive an un-complete: the
    // step is what is being undone, not the session that ran or the task that
    // closed. The `type` filter is the only thing enforcing that.
    expect(prismaMock.rewardEvent.findFirst.mock.calls[0][0].where.type).toBe(
      RewardType.StepDone,
    );
  });

  it("nothing to reverse is a normal answer, not an error", async () => {
    prismaMock.rewardEvent.findFirst.mockResolvedValue(null);

    expect(await reverseStepDoneReward("ws")).toBe(false);
    // Deleting on a null read would throw on a real client; returning false lets
    // the caller carry on un-completing, which is the user's actual intent.
    expect(prismaMock.rewardEvent.delete).not.toHaveBeenCalled();
  });
});
