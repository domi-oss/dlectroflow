/**
 * Action tests for ensureFocusStep (▶ Focus on a single to-do).
 *
 * The focus timer is step-based, so the action guarantees the item has a
 * task with at least one step (created idempotently, mirroring the item's
 * text, 10-minute default) and returns the first not-done step id.
 *
 * Mirrors the vi.mock shape used in request-breakdown.test.ts.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const { prismaMock, revalidatePathMock, currentWorkspaceIdMock } = vi.hoisted(
  () => {
    const prismaMock = {
      brainDumpItem: {
        findFirst: vi.fn(),
        update: vi.fn().mockResolvedValue({}),
        // #225 — the guarded link write. `count: 1` is "this caller won the row
        // and the link landed"; `0` is the lost-race path.
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      task: {
        create: vi.fn().mockResolvedValue({ id: "t-new" }),
        delete: vi.fn().mockResolvedValue({}),
      },
      step: {
        // #245 — `createManyAndReturn` + `skipDuplicates`, the `ON CONFLICT DO
        // NOTHING` shape `src/lib/db.ts` prescribes, now that
        // `Step_taskId_order_key` gives it something to conflict on. `findFirst`
        // is the loser's re-read. Both are here rather than only the one this
        // file's happy paths take, because a mocked delegate that is missing a
        // method fails with `is not a function` and says nothing about the test.
        createManyAndReturn: vi.fn().mockResolvedValue([{ id: "s-new" }]),
        findFirst: vi.fn().mockResolvedValue(null),
      },
      // Pass-through, matching `request-breakdown.test.ts`: the callback gets
      // the same delegates, so the shape assertions below read the same mocks
      // whether the write is inside a transaction or not. What a mock cannot
      // show is the row lock the #225 guard depends on — that is
      // `braindump-task-writers.integration.test.ts`, against real Postgres.
      $transaction: vi.fn(<T>(fn: (tx: unknown) => Promise<T>) =>
        fn(prismaMock),
      ),
    };
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
}));

beforeEach(() => {
  vi.clearAllMocks();
  currentWorkspaceIdMock.mockResolvedValue("owner");
  prismaMock.task.create.mockResolvedValue({ id: "t-new" });
  prismaMock.step.createManyAndReturn.mockResolvedValue([{ id: "s-new" }]);
  prismaMock.step.findFirst.mockResolvedValue(null);
  prismaMock.brainDumpItem.updateMany.mockResolvedValue({ count: 1 });
});

describe("ensureFocusStep", () => {
  it("returns null when the item is missing", async () => {
    prismaMock.brainDumpItem.findFirst.mockResolvedValueOnce(null);
    const { ensureFocusStep } = await import("./braindump");
    expect(await ensureFocusStep("nope")).toBeNull();
    expect(prismaMock.step.createManyAndReturn).not.toHaveBeenCalled();
  });

  it("carries the item's note and schedule intent onto the new task (#179)", async () => {
    // ▶ Focus is a triage in everything but name: it is the moment a `Task` row
    // first exists. Before #179 this path built its own object literal, so a note
    // captured inline (`call the bank {ref 4471}`) was silently dropped by
    // whichever conversion site nobody had tested — and a dropped note is
    // indistinguishable from working. `braindump-to-task-hygiene` fails the build
    // if this stops going through the shared helper; this asserts the VALUE
    // actually crosses.
    const dueAt = new Date("2026-08-10T09:00:00.000Z");
    prismaMock.brainDumpItem.findFirst.mockResolvedValueOnce({
      id: "i1",
      text: "call the bank",
      notes: "ref 4471",
      scheduleDueAt: dueAt,
      schedulePriority: "high",
      scheduleHours: "work",
      taskId: null,
      task: null,
    });
    const { ensureFocusStep } = await import("./braindump");
    await ensureFocusStep("i1");
    expect(prismaMock.task.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        title: "call the bank",
        notes: "ref 4471",
        scheduleDueAt: dueAt,
        schedulePriority: "high",
        scheduleHours: "work",
      }),
    });
  });

  it("item with no task: creates task + one 10-minute step mirroring the text", async () => {
    prismaMock.brainDumpItem.findFirst.mockResolvedValueOnce({
      id: "i1",
      text: "call the bank",
      taskId: null,
      task: null,
    });
    const { ensureFocusStep } = await import("./braindump");
    const stepId = await ensureFocusStep("i1");

    expect(prismaMock.task.create).toHaveBeenCalledTimes(1);
    // #225 — the link is a GUARDED write now, and the two terms in its `where`
    // are the point: `taskId: null` is what makes a second caller match zero
    // rows instead of repointing the item at a duplicate Task, and
    // `workspaceId` keeps the scope on the write rather than inherited from the
    // read above it. Asserted as the whole call so dropping either term fails
    // here rather than only against real Postgres.
    expect(prismaMock.brainDumpItem.updateMany).toHaveBeenCalledWith({
      where: { id: "i1", workspaceId: "owner", taskId: null },
      data: { taskId: "t-new" },
    });
    expect(prismaMock.step.createManyAndReturn).toHaveBeenCalledWith({
      data: [
        {
          taskId: "t-new",
          text: "call the bank",
          order: 1,
          total: 1,
          estMinutes: 10,
        },
      ],
      skipDuplicates: true,
    });
    expect(stepId).toBe("s-new");
    expect(revalidatePathMock).toHaveBeenCalledWith("/");
  });

  it("item with a task but no steps: creates only the step", async () => {
    prismaMock.brainDumpItem.findFirst.mockResolvedValueOnce({
      id: "i1",
      text: "call the bank",
      taskId: "t1",
      task: { id: "t1", steps: [] },
    });
    const { ensureFocusStep } = await import("./braindump");
    const stepId = await ensureFocusStep("i1");
    expect(prismaMock.task.create).not.toHaveBeenCalled();
    expect(prismaMock.step.createManyAndReturn).toHaveBeenCalledWith({
      data: [
        {
          taskId: "t1",
          text: "call the bank",
          order: 1,
          total: 1,
          estMinutes: 10,
        },
      ],
      skipDuplicates: true,
    });
    expect(stepId).toBe("s-new");
  });

  it("item with existing steps: idempotent — returns the first not-done step, creates nothing", async () => {
    prismaMock.brainDumpItem.findFirst.mockResolvedValueOnce({
      id: "i1",
      text: "x",
      taskId: "t1",
      task: {
        id: "t1",
        steps: [
          { id: "s1", done: true },
          { id: "s2", done: false },
        ],
      },
    });
    const { ensureFocusStep } = await import("./braindump");
    expect(await ensureFocusStep("i1")).toBe("s2");
    expect(prismaMock.step.createManyAndReturn).not.toHaveBeenCalled();
    expect(prismaMock.task.create).not.toHaveBeenCalled();
  });
});

/**
 * #225 — the lost-race arm, at the shape level.
 *
 * The behavioural proof is `braindump-task-writers.integration.test.ts`, which
 * holds a real row lock. What a mock CAN pin is that a link matching zero rows
 * makes the action discard the Task it had speculatively built and adopt the
 * winner's, rather than carrying on with a row nothing points at — a `count: 0`
 * treated as success is the whole defect wearing a guard.
 */
describe("ensureFocusStep — losing the race for the row (#225)", () => {
  it("discards its own Task and adopts the winner's", async () => {
    prismaMock.brainDumpItem.findFirst
      .mockResolvedValueOnce({
        id: "i1",
        text: "call the bank",
        taskId: null,
        task: null,
      })
      // The re-read after the guard refused: by now the winner has committed.
      .mockResolvedValueOnce({
        id: "i1",
        text: "call the bank",
        taskId: "t-winner",
        task: { steps: [{ id: "s-winner", done: false }] },
      });
    prismaMock.brainDumpItem.updateMany.mockResolvedValueOnce({ count: 0 });
    const { ensureFocusStep } = await import("./braindump");

    const stepId = await ensureFocusStep("i1");

    expect(prismaMock.task.delete).toHaveBeenCalledWith({
      where: { id: "t-new" },
    });
    // The winner's step, and no second one built beside it.
    expect(stepId).toBe("s-winner");
    expect(prismaMock.step.createManyAndReturn).not.toHaveBeenCalled();
  });

  it("creates the step when the winner's Task has none yet", async () => {
    prismaMock.brainDumpItem.findFirst
      .mockResolvedValueOnce({
        id: "i1",
        text: "call the bank",
        taskId: null,
        task: null,
      })
      .mockResolvedValueOnce({
        id: "i1",
        text: "call the bank",
        taskId: "t-winner",
        task: { steps: [] },
      });
    prismaMock.brainDumpItem.updateMany.mockResolvedValueOnce({ count: 0 });
    const { ensureFocusStep } = await import("./braindump");

    expect(await ensureFocusStep("i1")).toBe("s-new");
    // On the ADOPTED task, never on the discarded one.
    expect(prismaMock.step.createManyAndReturn).toHaveBeenCalledWith({
      data: [
        {
          taskId: "t-winner",
          text: "call the bank",
          order: 1,
          total: 1,
          estMinutes: 10,
        },
      ],
      skipDuplicates: true,
    });
  });

  /**
   * #245 — the step-level loser, in shape. `skipDuplicates` means an empty array
   * rather than a `P2002`, which is a RESULT to read and not an error to catch:
   * `src/lib/db.ts` keeps `log: ["error"]` truthful, and a caught P2002 prints
   * before any `catch` runs (#156, #158).
   *
   * The behaviour this buys needs the real index and is proved in
   * `ensure-focus-step.integration.test.ts`; a mocked `createManyAndReturn`
   * returns whatever this file tells it to.
   */
  it("adopts the step a concurrent press landed when its own insert is skipped", async () => {
    prismaMock.brainDumpItem.findFirst.mockResolvedValueOnce({
      id: "i1",
      text: "call the bank",
      taskId: "t1",
      task: { id: "t1", steps: [] },
    });
    // ON CONFLICT DO NOTHING: nothing inserted, nothing raised.
    prismaMock.step.createManyAndReturn.mockResolvedValueOnce([]);
    prismaMock.step.findFirst.mockResolvedValueOnce({ id: "s-winner" });
    const { ensureFocusStep } = await import("./braindump");

    expect(await ensureFocusStep("i1")).toBe("s-winner");
    // The re-read is scoped on the WRITE's own terms rather than inheriting the
    // scope of the read at the top of the transaction, and takes the lowest
    // order — the step a single-step task has and the first of a breakdown.
    expect(prismaMock.step.findFirst).toHaveBeenCalledWith({
      where: { taskId: "t1", task: { workspaceId: "owner" } },
      // The SAME rule the non-empty branch applies in JS — first open step, else
      // the lowest-ordered one. Asserted as the whole `orderBy` so the two
      // branches cannot drift into answering the question differently.
      orderBy: [{ done: "asc" }, { order: "asc" }],
    });
    // NOT revalidated: this call wrote nothing, and the winner revalidated for
    // its own write. Firing here would be a cache invalidation with no cause.
    expect(revalidatePathMock).not.toHaveBeenCalled();
  });

  it("returns null when the winner's step is deleted between its commit and the re-read", async () => {
    // An eject or a re-plan in that window. There is nothing to open the timer
    // on, and `null` is the answer this action already gives for an item it
    // cannot resolve — not an error raised at somebody who pressed ▶ twice.
    prismaMock.brainDumpItem.findFirst.mockResolvedValueOnce({
      id: "i1",
      text: "call the bank",
      taskId: "t1",
      task: { id: "t1", steps: [] },
    });
    prismaMock.step.createManyAndReturn.mockResolvedValueOnce([]);
    prismaMock.step.findFirst.mockResolvedValueOnce(null);
    const { ensureFocusStep } = await import("./braindump");

    expect(await ensureFocusStep("i1")).toBeNull();
    expect(revalidatePathMock).not.toHaveBeenCalled();
  });

  it("returns null rather than guessing when the row has gone entirely", async () => {
    prismaMock.brainDumpItem.findFirst
      .mockResolvedValueOnce({
        id: "i1",
        text: "call the bank",
        taskId: null,
        task: null,
      })
      .mockResolvedValueOnce(null);
    prismaMock.brainDumpItem.updateMany.mockResolvedValueOnce({ count: 0 });
    const { ensureFocusStep } = await import("./braindump");

    expect(await ensureFocusStep("i1")).toBeNull();
    expect(prismaMock.step.createManyAndReturn).not.toHaveBeenCalled();
    expect(revalidatePathMock).not.toHaveBeenCalled();
  });
});
