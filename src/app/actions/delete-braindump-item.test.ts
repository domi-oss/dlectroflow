/**
 * Action tests for deleteBrainDumpItem — #64 (focus↔library data integrity).
 *
 * Root cause: deleting a BrainDumpItem used to delete only that row, leaving
 * its linked Task (+ Steps/BreakdownTurns) behind as a permanent orphan —
 * invisible to the Library (whose only source query is BrainDumpItem) but
 * still surfaced forever in the Focus launcher (which reads Task directly).
 * These tests pin the fix: deleting the last BrainDumpItem referencing a
 * Task must also delete that Task, inside one transaction.
 *
 * Mirrors the vi.mock shape used in complete.test.ts ($transaction support).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { TASK_WRITER_TX_BUDGET } from "@/lib/constants";

const { prismaMock, revalidatePathMock, currentWorkspaceIdMock } = vi.hoisted(
  () => {
    const prismaMock = {
      brainDumpItem: {
        findFirst: vi.fn(),
        // #251 — the guarded claim that decides whether THIS call takes the
        // completion back. `count: 1` = it did.
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        deleteMany: vi.fn().mockResolvedValue({ count: 1 }),
        count: vi.fn().mockResolvedValue(0),
      },
      task: {
        deleteMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      // #251 — the done steps this delete destroys, and therefore the number of
      // `step_done` rows it owes back.
      step: {
        count: vi.fn().mockResolvedValue(0),
      },
      $transaction: vi.fn(),
    };
    prismaMock.$transaction.mockImplementation((arg: unknown) =>
      typeof arg === "function"
        ? (arg as (tx: unknown) => unknown)(prismaMock)
        : Promise.all(arg as Promise<unknown>[]),
    );
    return {
      prismaMock,
      revalidatePathMock: vi.fn(),
      currentWorkspaceIdMock: vi.fn().mockResolvedValue("owner"),
    };
  },
);

vi.mock("next/cache", () => ({ revalidatePath: revalidatePathMock }));
vi.mock("@/lib/db", () => ({ prisma: prismaMock }));
vi.mock("@/lib/workspace", () => ({
  currentWorkspaceId: currentWorkspaceIdMock,
  isOwnerRequest: vi.fn().mockResolvedValue(true),
  MissingWorkspaceError: class extends Error {},
}));
vi.mock("@/lib/rewards", () => ({
  maybeAwardInboxZero: vi.fn().mockResolvedValue(undefined),
  maybeAwardTenStepsDay: vi.fn().mockResolvedValue(undefined),
  logReward: vi.fn().mockResolvedValue(undefined),
  awardBadge: vi.fn().mockResolvedValue(undefined),
  touchStreakOnCompletion: vi.fn().mockResolvedValue(null),
  // #251 — the reversal reports what it actually took, which is what gates the
  // badge revocation below. Defaults to "took nothing", so a spec that does not
  // set it up asserts the no-reversal path rather than accidentally the other.
  reverseItemCompletionRewards: vi
    .fn()
    .mockResolvedValue({ stepDone: 0, taskComplete: false }),
  revokeUnqualifiedBadges: vi.fn().mockResolvedValue([]),
}));

beforeEach(async () => {
  vi.clearAllMocks();
  currentWorkspaceIdMock.mockResolvedValue("owner");
  prismaMock.brainDumpItem.updateMany.mockResolvedValue({ count: 1 });
  prismaMock.brainDumpItem.deleteMany.mockResolvedValue({ count: 1 });
  prismaMock.brainDumpItem.count.mockResolvedValue(0);
  prismaMock.step.count.mockResolvedValue(0);
  // #168's rule, not `clearAllMocks`'s: two specs below queue a
  // `mockResolvedValueOnce` on these, and `clearAllMocks` drops recorded calls
  // while leaving the ONCE QUEUE in place — so a spec that fails before
  // consuming its queued value hands it to the next one, which then asserts
  // against a reversal it never set up. `mockReset` is the part that drops the
  // queue, and it clears the default with it, so the default is restored here.
  // (`clearAllMocks` alone does NOT clear a `mockResolvedValue` set in the
  // factory — measured, not assumed, by removing this block and watching all 15
  // specs still pass.)
  const rewards = await import("@/lib/rewards");
  const reverse = rewards.reverseItemCompletionRewards as ReturnType<
    typeof vi.fn
  >;
  const revoke = rewards.revokeUnqualifiedBadges as ReturnType<typeof vi.fn>;
  reverse.mockReset();
  reverse.mockResolvedValue({ stepDone: 0, taskComplete: false });
  revoke.mockReset();
  revoke.mockResolvedValue([]);
});

describe("deleteBrainDumpItem", () => {
  it("no-ops when the item is missing (workspace-scoped)", async () => {
    prismaMock.brainDumpItem.findFirst.mockResolvedValueOnce(null);
    const { deleteBrainDumpItem } = await import("./braindump");

    await deleteBrainDumpItem("nope");

    expect(prismaMock.$transaction).not.toHaveBeenCalled();
    expect(prismaMock.brainDumpItem.deleteMany).not.toHaveBeenCalled();
  });

  it("deletes a single-task item (no linked Task) without touching Task at all", async () => {
    prismaMock.brainDumpItem.findFirst.mockResolvedValueOnce({
      id: "i1",
      taskId: null,
    });
    const { deleteBrainDumpItem } = await import("./braindump");

    await deleteBrainDumpItem("i1");

    expect(prismaMock.brainDumpItem.deleteMany).toHaveBeenCalledWith({
      where: { id: "i1", workspaceId: "owner" },
    });
    expect(prismaMock.brainDumpItem.count).not.toHaveBeenCalled();
    expect(prismaMock.task.deleteMany).not.toHaveBeenCalled();
  });

  it("deletes the linked Task too when it was the last BrainDumpItem referencing it — no orphan left behind (#64)", async () => {
    prismaMock.brainDumpItem.findFirst.mockResolvedValueOnce({
      id: "i1",
      taskId: "t1",
    });
    prismaMock.brainDumpItem.count.mockResolvedValueOnce(0); // no other item still points at t1
    const { deleteBrainDumpItem } = await import("./braindump");

    await deleteBrainDumpItem("i1");

    expect(prismaMock.brainDumpItem.deleteMany).toHaveBeenCalledWith({
      where: { id: "i1", workspaceId: "owner" },
    });
    expect(prismaMock.brainDumpItem.count).toHaveBeenCalledWith({
      where: { taskId: "t1" },
    });
    expect(prismaMock.task.deleteMany).toHaveBeenCalledWith({
      where: { id: "t1", workspaceId: "owner" },
    });
  });

  it("keeps the linked Task when another BrainDumpItem still references it", async () => {
    prismaMock.brainDumpItem.findFirst.mockResolvedValueOnce({
      id: "i1",
      taskId: "t1",
    });
    prismaMock.brainDumpItem.count.mockResolvedValueOnce(1); // another item still points at t1
    const { deleteBrainDumpItem } = await import("./braindump");

    await deleteBrainDumpItem("i1");

    expect(prismaMock.task.deleteMany).not.toHaveBeenCalled();
  });

  it("runs the item delete + task cleanup inside one transaction", async () => {
    prismaMock.brainDumpItem.findFirst.mockResolvedValueOnce({
      id: "i1",
      taskId: "t1",
    });
    prismaMock.brainDumpItem.count.mockResolvedValueOnce(0);
    const { deleteBrainDumpItem } = await import("./braindump");

    await deleteBrainDumpItem("i1");

    expect(prismaMock.$transaction).toHaveBeenCalledTimes(1);
    expect(prismaMock.$transaction.mock.calls[0][0]).toBeInstanceOf(Function);
  });

  it("gives that transaction the shared writer budget rather than Prisma's 5s default", async () => {
    // #251 review — the default is what makes this necessary. This transaction
    // takes the same `BrainDumpItem` row lock as `keepAsTask` and
    // `ensureFocusStep`, both of which are given `TASK_WRITER_TX_BUDGET` (15s)
    // precisely so a loser WAITS instead of dying: measured on real Postgres,
    // a lock held past `timeout` kills the waiter with `P2028 Transaction
    // already closed` and rolls it back, so the user gets "Couldn't delete that
    // just now" and a Retry that will do the same thing — instead of the no-op
    // the guarded writes are documented as giving. Its own work is 14-36ms, so
    // the budget is spent waiting and never working, and nothing slow ever shows
    // up in testing.
    //
    // Asserted here and not by `braindump-to-task-hygiene`: that gate only
    // enrols a transaction containing a conversion-routed `task.create`, and a
    // delete creates no Task, so it is structurally blind to this call.
    prismaMock.brainDumpItem.findFirst.mockResolvedValueOnce({
      id: "i1",
      taskId: null,
    });
    const { deleteBrainDumpItem } = await import("./braindump");

    await deleteBrainDumpItem("i1");

    expect(prismaMock.$transaction).toHaveBeenCalledWith(
      expect.any(Function),
      TASK_WRITER_TX_BUDGET,
    );
  });

  it("does not throw and skips Task cleanup when the item was already deleted concurrently (race between the read and the transaction)", async () => {
    // `existing` was found by the pre-transaction read (so we know its taskId),
    // but by the time the transaction's deleteMany runs, a concurrent
    // deleteBrainDumpItem call already removed the row — deleteMany matches
    // 0 rows instead of throwing (unlike `delete`, which would P2025 here).
    prismaMock.brainDumpItem.findFirst.mockResolvedValueOnce({
      id: "i1",
      taskId: "t1",
    });
    prismaMock.brainDumpItem.deleteMany.mockResolvedValueOnce({ count: 0 });
    const { deleteBrainDumpItem } = await import("./braindump");

    await expect(deleteBrainDumpItem("i1")).resolves.toBeUndefined();

    expect(prismaMock.brainDumpItem.count).not.toHaveBeenCalled();
    expect(prismaMock.task.deleteMany).not.toHaveBeenCalled();
  });

  it("still awards inbox-zero + revalidates after cleanup", async () => {
    // #251 review — the fixture now states the three columns the award's gate
    // reads (`countsTowardInboxZero`), because the gate is the queue's own
    // predicate rather than a proxy for one third of it. A row that names only
    // `taskId` is not a row this action can meet, and leaving it that way would
    // have made this control pass or fail on `undefined`.
    prismaMock.brainDumpItem.findFirst.mockResolvedValueOnce({
      id: "i1",
      taskId: null,
      status: "inbox",
      completedAt: null,
      snoozedUntil: null,
    });
    // Explicit, not inherited from the file default: this case is an UNTRIAGED
    // row, whose removal genuinely can empty the queue `maybeAwardInboxZero`
    // measures. The default is `count: 1` (a completion was claimed), which is
    // the other case entirely — see the test below.
    prismaMock.brainDumpItem.updateMany.mockResolvedValueOnce({ count: 0 });
    const { deleteBrainDumpItem } = await import("./braindump");
    const rewards = await import("@/lib/rewards");

    await deleteBrainDumpItem("i1");

    expect(rewards.maybeAwardInboxZero).toHaveBeenCalledWith("owner");
    expect(revalidatePathMock).toHaveBeenCalledWith("/");
    // #251 — the Done tab renders these rows and the dashboard renders the score
    // this call may have just reduced.
    expect(revalidatePathMock).toHaveBeenCalledWith("/library");
    expect(revalidatePathMock).toHaveBeenCalledWith("/dashboard");
  });

  it("does not award inbox-zero when the delete took a completion, but still revalidates", async () => {
    // #251 — the mirror of the case above, and the reason it had to become
    // explicit. `maybeAwardInboxZero` counts `status: Inbox, completedAt: null`,
    // so a completed row was never in that count and deleting it cannot lower
    // it. Awarding here re-pays an inbox zero the workspace already held — +15
    // points and a badge, on the call whose job was to take points back.
    //
    // The revalidations are asserted in the same test on purpose: the gate must
    // narrow the award only, and a regression that moved the whole tail behind
    // it would leave the Done tab and the dashboard showing a stale score.
    prismaMock.brainDumpItem.findFirst.mockResolvedValueOnce({
      id: "i1",
      taskId: null,
    });
    prismaMock.brainDumpItem.updateMany.mockResolvedValueOnce({ count: 1 });
    const { deleteBrainDumpItem } = await import("./braindump");
    const rewards = await import("@/lib/rewards");

    await deleteBrainDumpItem("i1");

    expect(rewards.maybeAwardInboxZero).not.toHaveBeenCalled();
    expect(revalidatePathMock).toHaveBeenCalledWith("/");
    expect(revalidatePathMock).toHaveBeenCalledWith("/library");
    expect(revalidatePathMock).toHaveBeenCalledWith("/dashboard");
  });

  it("does not award inbox-zero when this call removed nothing", async () => {
    // #251 — the race path, and the hole in the first version of this gate.
    // The LOSER of a concurrent double-delete claims no completion (the winner
    // already cleared it), so `tookCompletion` reads 0 — indistinguishable from
    // an untriaged delete — and its `deleteMany` then matches nothing, so the
    // transaction returns early having removed no row at all. Gating the award on
    // `tookCompletion` alone waved it straight through, which put "+15 points and
    // an inbox_zero badge for deleting a demo item" back on exactly the double-tap
    // path this file's own doc comment calls real.
    //
    // The award's precondition is a REMOVAL, not a claim: `maybeAwardInboxZero`
    // asks whether the untriaged queue is empty, and a call that deleted nothing
    // cannot have emptied it.
    prismaMock.brainDumpItem.findFirst.mockResolvedValueOnce({
      id: "i1",
      taskId: null,
    });
    prismaMock.brainDumpItem.updateMany.mockResolvedValueOnce({ count: 0 });
    prismaMock.brainDumpItem.deleteMany.mockResolvedValueOnce({ count: 0 });
    const { deleteBrainDumpItem } = await import("./braindump");
    const rewards = await import("@/lib/rewards");

    await deleteBrainDumpItem("i1");

    expect(rewards.maybeAwardInboxZero).not.toHaveBeenCalled();
  });

  it("still revalidates when it removed nothing — another caller changed the list", async () => {
    // The gate narrows the AWARD only. A concurrent delete really did remove the
    // row, so this request's rendered lists are stale exactly as if it had done
    // the removing itself, and skipping the revalidations would leave the Done
    // tab showing a row that is gone.
    prismaMock.brainDumpItem.findFirst.mockResolvedValueOnce({
      id: "i1",
      taskId: null,
    });
    prismaMock.brainDumpItem.updateMany.mockResolvedValueOnce({ count: 0 });
    prismaMock.brainDumpItem.deleteMany.mockResolvedValueOnce({ count: 0 });
    const { deleteBrainDumpItem } = await import("./braindump");

    await deleteBrainDumpItem("i1");

    expect(revalidatePathMock).toHaveBeenCalledWith("/");
    expect(revalidatePathMock).toHaveBeenCalledWith("/library");
    expect(revalidatePathMock).toHaveBeenCalledWith("/dashboard");
  });
});

// ── #251 — the reward reversal's wiring ────────────────────────────────────
//
// The arithmetic itself is proved against real Postgres in
// delete-completed-item.integration.test.ts, because every guarantee it makes is
// a property of the row locks. What is asserted here is the part a mock CAN see
// and the integration test cannot isolate: which numbers the action derives, that
// they come from the writes rather than from the pre-transaction read, and that
// both reward calls are handed the transaction client rather than the singleton.
describe("deleteBrainDumpItem — reward reversal wiring (#251)", () => {
  const found = (taskId: string | null) =>
    prismaMock.brainDumpItem.findFirst.mockResolvedValueOnce({
      id: "i1",
      taskId,
    });

  it("claims the completion with a guarded updateMany before deleting the row", async () => {
    found(null);
    const { deleteBrainDumpItem } = await import("./braindump");

    await deleteBrainDumpItem("i1");

    // The `completedAt: { not: null }` precondition is the whole gate: it is what
    // makes a second concurrent delete report 0 and reverse nothing.
    expect(prismaMock.brainDumpItem.updateMany).toHaveBeenCalledWith({
      where: { id: "i1", workspaceId: "owner", completedAt: { not: null } },
      data: { completedAt: null },
    });
    const claimOrder =
      prismaMock.brainDumpItem.updateMany.mock.invocationCallOrder[0];
    const deleteOrder =
      prismaMock.brainDumpItem.deleteMany.mock.invocationCallOrder[0];
    expect(claimOrder).toBeLessThan(deleteOrder);
  });

  it("owes one step_done per done step it destroys, plus the task_complete it claimed", async () => {
    found("t1");
    prismaMock.brainDumpItem.count.mockResolvedValueOnce(0); // last item on t1
    prismaMock.step.count.mockResolvedValueOnce(4);
    const { deleteBrainDumpItem } = await import("./braindump");
    const rewards = await import("@/lib/rewards");

    await deleteBrainDumpItem("i1");

    expect(prismaMock.step.count).toHaveBeenCalledWith({
      where: { taskId: "t1", done: true, task: { workspaceId: "owner" } },
    });
    expect(rewards.reverseItemCompletionRewards).toHaveBeenCalledWith(
      "owner",
      { stepDone: 4, includeTaskComplete: true },
      // The transaction client, not the module singleton — a reversal that
      // committed independently would survive the rollback.
      prismaMock,
    );
  });

  it("counts the steps before the Task goes, or the cascade would have taken them", async () => {
    found("t1");
    prismaMock.brainDumpItem.count.mockResolvedValueOnce(0);
    prismaMock.step.count.mockResolvedValueOnce(2);
    const { deleteBrainDumpItem } = await import("./braindump");

    await deleteBrainDumpItem("i1");

    expect(prismaMock.step.count.mock.invocationCallOrder[0]).toBeLessThan(
      prismaMock.task.deleteMany.mock.invocationCallOrder[0],
    );
  });

  it("owes no step_done when the Task survives — its steps are still paid for", async () => {
    found("t1");
    prismaMock.brainDumpItem.count.mockResolvedValueOnce(1); // another item holds t1
    const { deleteBrainDumpItem } = await import("./braindump");
    const rewards = await import("@/lib/rewards");

    await deleteBrainDumpItem("i1");

    expect(prismaMock.step.count).not.toHaveBeenCalled();
    expect(rewards.reverseItemCompletionRewards).toHaveBeenCalledWith(
      "owner",
      { stepDone: 0, includeTaskComplete: true },
      prismaMock,
    );
  });

  it("does not claim a task_complete when the row was not carrying a completion", async () => {
    found(null);
    prismaMock.brainDumpItem.updateMany.mockResolvedValueOnce({ count: 0 });
    const { deleteBrainDumpItem } = await import("./braindump");
    const rewards = await import("@/lib/rewards");

    await deleteBrainDumpItem("i1");

    expect(rewards.reverseItemCompletionRewards).toHaveBeenCalledWith(
      "owner",
      { stepDone: 0, includeTaskComplete: false },
      prismaMock,
    );
  });

  it("reverses nothing at all when the row was already deleted concurrently", async () => {
    found("t1");
    prismaMock.brainDumpItem.deleteMany.mockResolvedValueOnce({ count: 0 });
    const { deleteBrainDumpItem } = await import("./braindump");
    const rewards = await import("@/lib/rewards");

    await deleteBrainDumpItem("i1");

    expect(rewards.reverseItemCompletionRewards).not.toHaveBeenCalled();
    expect(rewards.revokeUnqualifiedBadges).not.toHaveBeenCalled();
  });

  it("revokes badges only when the reversal actually took something back", async () => {
    found(null);
    const { deleteBrainDumpItem } = await import("./braindump");
    const rewards = await import("@/lib/rewards");
    const reverse = rewards.reverseItemCompletionRewards as ReturnType<
      typeof vi.fn
    >;

    // Took nothing: the workspace may already be sitting on an unqualified
    // badge (a reopen leaves exactly that), and this delete has no claim on it.
    reverse.mockResolvedValueOnce({ stepDone: 0, taskComplete: false });
    await deleteBrainDumpItem("i1");
    expect(rewards.revokeUnqualifiedBadges).not.toHaveBeenCalled();

    // Took a task_complete: the badges it could have supported are re-checked,
    // in the same transaction.
    found(null);
    reverse.mockResolvedValueOnce({ stepDone: 0, taskComplete: true });
    await deleteBrainDumpItem("i1");
    // `reversed` is handed on, not just used as a gate: the per-badge gates in
    // that function need it, because a step-only reversal must not reach
    // `task_complete` and a completion-only one must not reach `ten_steps_day`.
    expect(rewards.revokeUnqualifiedBadges).toHaveBeenCalledWith(
      "owner",
      { stepDone: 0, taskComplete: true },
      prismaMock,
    );
  });

  it("re-checks badges when only step points came back", async () => {
    found("t1");
    prismaMock.brainDumpItem.count.mockResolvedValueOnce(0);
    prismaMock.step.count.mockResolvedValueOnce(3);
    const { deleteBrainDumpItem } = await import("./braindump");
    const rewards = await import("@/lib/rewards");
    (
      rewards.reverseItemCompletionRewards as ReturnType<typeof vi.fn>
    ).mockResolvedValueOnce({ stepDone: 3, taskComplete: false });

    await deleteBrainDumpItem("i1");

    // ten_steps_day is the badge this case exists for: three step_done rows
    // fewer today can drop the day back under its threshold. `task_complete` is
    // not, and the reversal it is handed is what says so.
    expect(rewards.revokeUnqualifiedBadges).toHaveBeenCalledWith(
      "owner",
      { stepDone: 3, taskComplete: false },
      prismaMock,
    );
  });
});
