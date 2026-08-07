import { describe, it, expect, vi, beforeEach } from "vitest";

const { prismaMock, txClient, revalidatePathMock, currentWorkspaceIdMock } =
  vi.hoisted(() => {
    const prismaMock = {
      brainDumpItem: {
        findFirst: vi.fn(),
        update: vi.fn().mockResolvedValue({}),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      step: {
        // `{ count: 1 }` — the write matched its row, which is the normal case and
        // the one `uncompleteStep` now branches on (review round 10: its `done`
        // precondition moved INTO the write, so `count: 0` means "another caller
        // got there first" and is a no-op). `completeItem` and `reopenItem` ignore
        // the count, so this default is inert for them.
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        update: vi.fn(),
        findFirst: vi.fn(),
        count: vi.fn(),
      },
      task: { update: vi.fn().mockResolvedValue({}) },
      rewardEvent: {
        create: vi.fn().mockResolvedValue({}),
        count: vi.fn().mockResolvedValue(0),
      },
      badge: {
        findUnique: vi.fn().mockResolvedValue(null),
        createMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      focusSession: { findFirst: vi.fn(), update: vi.fn() },
      streak: {},
      settings: {},
      streakRecord: {},
      $transaction: vi.fn(),
    };
    // Review round 4 — `uncompleteStep` now runs its local writes AND the reward
    // reversal in one interactive transaction. The client handed to the callback
    // is a distinct object from `prismaMock`, sharing the very same model
    // delegates so every existing assertion still sees the calls. The only thing
    // the separate identity buys is that a test can tell "this ran inside the
    // transaction" from "this ran on the module singleton" — which is exactly the
    // difference between the atomicity fix working and looking like it works.
    const txClient = { ...prismaMock };
    prismaMock.$transaction.mockImplementation((arg: unknown) =>
      typeof arg === "function"
        ? (arg as (tx: unknown) => unknown)(txClient)
        : Promise.all(arg as Promise<unknown>[]),
    );
    return {
      prismaMock,
      txClient,
      revalidatePathMock: vi.fn(),
      currentWorkspaceIdMock: vi.fn().mockResolvedValue("owner"),
    };
  });
vi.mock("next/cache", () => ({ revalidatePath: revalidatePathMock }));
vi.mock("@/lib/db", () => ({ prisma: prismaMock }));
vi.mock("@/lib/workspace", () => ({
  currentWorkspaceId: currentWorkspaceIdMock,
  isOwnerRequest: vi.fn().mockResolvedValue(true),
  // #118 Phase C — the best-effort Google sync resolves the ACTING account's own
  // credential now (focus.ts's actingUserGoogleToken), so this file needs a
  // signed-in account rather than an instance-wide one.
  currentUser: vi.fn().mockResolvedValue({
    id: "user-owner",
    role: "owner",
    workspaceId: "owner",
    provider: "gitlab",
    handle: "owner",
  }),
  MissingWorkspaceError: class extends Error {},
}));
// keep reward side-effects simple + observable
vi.mock("@/lib/rewards", () => ({
  logReward: vi.fn().mockResolvedValue(undefined),
  awardBadge: vi.fn().mockResolvedValue(true),
  rewardStepDone: vi.fn().mockResolvedValue(null),
  reverseStepCompletionRewards: vi
    .fn()
    .mockResolvedValue({ stepDone: true, taskComplete: false }),
  touchStreakOnCompletion: vi.fn().mockResolvedValue(null),
  maybeAwardInboxZero: vi.fn().mockResolvedValue(undefined),
  maybeAwardTenStepsDay: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/google", () => ({
  getValidAccessToken: vi.fn().mockResolvedValue(null),
  patchGoogleTask: vi.fn().mockResolvedValue(undefined),
}));
import {
  logReward,
  awardBadge,
  maybeAwardTenStepsDay,
  maybeAwardInboxZero,
} from "@/lib/rewards";

beforeEach(() => {
  vi.clearAllMocks();
  currentWorkspaceIdMock.mockResolvedValue("owner");
});

describe("completeItem", () => {
  it("no-ops when the item is missing or already completed", async () => {
    prismaMock.brainDumpItem.findFirst.mockResolvedValueOnce(null);
    const { completeItem } = await import("./braindump");
    await completeItem("x");
    expect(prismaMock.brainDumpItem.update).not.toHaveBeenCalled();

    prismaMock.brainDumpItem.findFirst.mockResolvedValueOnce({
      id: "i1",
      completedAt: new Date(),
      task: null,
    });
    await completeItem("i1");
    expect(prismaMock.brainDumpItem.update).not.toHaveBeenCalled();
  });

  it("stamps completedAt + awards TaskComplete for a single-task item (no task)", async () => {
    prismaMock.brainDumpItem.findFirst.mockResolvedValueOnce({
      id: "i1",
      completedAt: null,
      task: null,
    });
    const { completeItem } = await import("./braindump");
    await completeItem("i1");
    const upd = prismaMock.brainDumpItem.update.mock.calls[0][0];
    expect(upd.where).toEqual({ id: "i1" });
    expect(upd.data.completedAt).toBeInstanceOf(Date);
    expect(logReward).toHaveBeenCalledWith("owner", "task_complete");
    expect(awardBadge).toHaveBeenCalledWith("owner", "task_complete");
    expect(maybeAwardInboxZero).toHaveBeenCalledWith("owner");
  });

  it("completes a multi-step task: all steps + task done, credits StepDone per not-done step", async () => {
    prismaMock.brainDumpItem.findFirst.mockResolvedValueOnce({
      id: "i2",
      completedAt: null,
      task: {
        id: "t1",
        steps: [
          { id: "s1", done: true },
          { id: "s2", done: false },
          { id: "s3", done: false },
        ],
      },
    });
    const { completeItem } = await import("./braindump");
    await completeItem("i2");
    expect(prismaMock.step.updateMany).toHaveBeenCalledWith({
      where: { taskId: "t1" },
      data: { done: true },
    });
    expect(prismaMock.task.update).toHaveBeenCalledWith({
      where: { id: "t1" },
      data: { status: "done" },
    });
    // 2 not-done steps → 2 StepDone + 1 TaskComplete
    const stepDoneCalls = (
      logReward as unknown as ReturnType<typeof vi.fn>
    ).mock.calls.filter((c) => c[1] === "step_done");
    expect(stepDoneCalls).toHaveLength(2);
    expect(logReward).toHaveBeenCalledWith("owner", "task_complete");
    expect(maybeAwardTenStepsDay).toHaveBeenCalledWith("owner");
    expect(revalidatePathMock).toHaveBeenCalledWith("/");
  });

  it("is workspace-scoped (findFirst gated on workspaceId)", async () => {
    prismaMock.brainDumpItem.findFirst.mockResolvedValueOnce({
      id: "i1",
      completedAt: null,
      task: null,
    });
    const { completeItem } = await import("./braindump");
    await completeItem("i1");
    expect(prismaMock.brainDumpItem.findFirst.mock.calls[0][0].where).toEqual({
      id: "i1",
      workspaceId: "owner",
    });
  });
});

describe("reopenItem", () => {
  it("clears completedAt for a single-task item", async () => {
    prismaMock.brainDumpItem.findFirst.mockResolvedValueOnce({
      id: "i1",
      task: null,
    });
    const { reopenItem } = await import("./braindump");
    await reopenItem("i1");
    expect(prismaMock.brainDumpItem.update).toHaveBeenCalledWith({
      where: { id: "i1" },
      data: { completedAt: null },
    });
  });

  it("reopens a multi-step task: reactivates + resets selected steps", async () => {
    prismaMock.brainDumpItem.findFirst.mockResolvedValueOnce({
      id: "i2",
      task: {
        id: "t1",
        steps: [
          { id: "s1", done: true },
          { id: "s2", done: true },
        ],
      },
    });
    const { reopenItem } = await import("./braindump");
    await reopenItem("i2", ["s2"]);
    expect(prismaMock.task.update).toHaveBeenCalledWith({
      where: { id: "t1" },
      data: { status: "active" },
    });
    expect(prismaMock.step.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ["s2"] } },
      data: { done: false },
    });
  });

  it("empty stepIds resets ALL steps (whole-task reopen)", async () => {
    prismaMock.brainDumpItem.findFirst.mockResolvedValueOnce({
      id: "i3",
      task: {
        id: "t2",
        steps: [
          { id: "a", done: true },
          { id: "b", done: true },
        ],
      },
    });
    const { reopenItem } = await import("./braindump");
    await reopenItem("i3", []);
    expect(prismaMock.step.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ["a", "b"] } },
      data: { done: false },
    });
  });

  it("guards ≥1 not-done: a subset covering nothing also resets the last step", async () => {
    prismaMock.brainDumpItem.findFirst.mockResolvedValueOnce({
      id: "i4",
      task: {
        id: "t3",
        steps: [
          { id: "a", done: true },
          { id: "b", done: true },
        ],
      },
    });
    const { reopenItem } = await import("./braindump");
    await reopenItem("i4", ["missing"]); // covers no real steps → all still done → add last
    const call = prismaMock.step.updateMany.mock.calls[0][0];
    expect(call.data).toEqual({ done: false });
    expect(call.where.id.in).toContain("b"); // last step forced not-done
  });
});

describe("completeStep", () => {
  it("marks the step done + awards StepDone (not SessionFinished), scoped", async () => {
    const rewards = await import("@/lib/rewards");
    prismaMock.step.findFirst.mockResolvedValueOnce({
      id: "s1",
      taskId: "t1",
      done: false,
      task: {
        id: "t1",
        steps: [
          { id: "s1", done: false },
          { id: "s2", done: false },
        ],
      },
    });
    const { completeStep } = await import("./focus");
    await completeStep("s1");
    expect(prismaMock.step.findFirst.mock.calls[0][0].where).toEqual({
      id: "s1",
      task: { workspaceId: "owner" },
    });
    expect(prismaMock.step.update).toHaveBeenCalledWith({
      where: { id: "s1" },
      data: { done: true },
    });
    expect(rewards.rewardStepDone).toHaveBeenCalledWith("owner");
    expect(rewards.logReward).not.toHaveBeenCalledWith(
      "owner",
      "session_finished",
    );
  });

  it("last step → task done + item stamped + TaskComplete", async () => {
    const rewards = await import("@/lib/rewards");
    prismaMock.step.findFirst.mockResolvedValueOnce({
      id: "s2",
      taskId: "t1",
      done: false,
      task: {
        id: "t1",
        steps: [
          { id: "s1", done: true },
          { id: "s2", done: false },
        ],
      },
    });
    const { completeStep } = await import("./focus");
    await completeStep("s2");
    expect(prismaMock.task.update).toHaveBeenCalledWith({
      where: { id: "t1", workspaceId: "owner" },
      data: { status: "done" },
    });
    expect(prismaMock.brainDumpItem.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { taskId: "t1", workspaceId: "owner" },
      }),
    );
    expect(rewards.logReward).toHaveBeenCalledWith("owner", "task_complete");
    expect(rewards.awardBadge).toHaveBeenCalledWith("owner", "task_complete");
  });

  it("no-ops when already done", async () => {
    prismaMock.step.findFirst.mockResolvedValueOnce({
      id: "s1",
      done: true,
      task: { steps: [] },
    });
    const { completeStep } = await import("./focus");
    await completeStep("s1");
    expect(prismaMock.step.update).not.toHaveBeenCalled();
  });
});

describe("uncompleteStep (#198)", () => {
  // The inverse of completeStep, and the only recovery path in the app for a
  // step completed by accident. Before this, `reopenItem` was the sole
  // un-complete route and it takes a BrainDumpItem id — so it is unreachable
  // until the WHOLE item is complete and sitting in the Done view. A step
  // completed while its task still had other open steps could not be undone
  // anywhere.
  function doneStep(overrides: Record<string, unknown> = {}) {
    return {
      id: "s1",
      taskId: "t1",
      done: true,
      googleTaskId: null,
      googleTaskListId: null,
      task: { id: "t1", status: "active" },
      ...overrides,
    };
  }

  it("flips done back, scoped to the resolved workspace", async () => {
    prismaMock.step.findFirst.mockResolvedValueOnce(doneStep());
    const { uncompleteStep } = await import("./focus");
    await uncompleteStep("s1");
    expect(prismaMock.step.findFirst.mock.calls[0][0].where).toEqual({
      id: "s1",
      task: { workspaceId: "owner" },
    });
    // Round 10 — the `done: true` precondition is part of the WRITE now, not just
    // the read above it, and the write carries its own workspace scope because
    // `updateMany` is a bulk op (`scoping.harness.test.ts`). Both halves are
    // asserted, because either one missing is a real defect: without `done: true`
    // a second concurrent undo reverses an unrelated step's reward, and without
    // the scope the harness rule is silently sidestepped.
    expect(prismaMock.step.updateMany).toHaveBeenCalledWith({
      where: { id: "s1", done: true, task: { workspaceId: "owner" } },
      data: { done: false },
    });
    // And the superseded shape is gone rather than merely unused — an unguarded
    // primary-key `update` left anywhere on this path reopens the hole.
    expect(prismaMock.step.update).not.toHaveBeenCalled();
  });

  it("no-ops on a missing step, and on one that is not done", async () => {
    prismaMock.step.findFirst.mockResolvedValueOnce(null);
    const { uncompleteStep } = await import("./focus");
    await uncompleteStep("nope");
    expect(prismaMock.step.updateMany).not.toHaveBeenCalled();

    prismaMock.step.findFirst.mockResolvedValueOnce(doneStep({ done: false }));
    await uncompleteStep("s1");
    expect(prismaMock.step.updateMany).not.toHaveBeenCalled();
  });

  it("stops dead when the guarded write matches nothing — a lost race is a no-op", async () => {
    // The whole point of moving the precondition into the write: `count: 0` means
    // a concurrent undo already did all of this, so this call must NOT go on to
    // reverse a reward. Before round 10 it did, and `reverseLatestReward` takes
    // back the newest `step_done` in the WORKSPACE — so the loser reversed an
    // unrelated step's reward. Proved against real Postgres in
    // `uncomplete-step.integration.test.ts`; pinned here as the shape.
    prismaMock.step.findFirst.mockResolvedValueOnce(doneStep());
    prismaMock.step.updateMany.mockResolvedValueOnce({ count: 0 });
    const rewards = await import("@/lib/rewards");
    const { uncompleteStep } = await import("./focus");
    await expect(uncompleteStep("s1")).resolves.toBeUndefined();
    expect(prismaMock.step.updateMany).toHaveBeenCalled();
    expect(rewards.reverseStepCompletionRewards).not.toHaveBeenCalled();
    expect(prismaMock.task.update).not.toHaveBeenCalled();
  });

  it("reopens the task and its inbox item when THAT step had closed the task", async () => {
    prismaMock.step.findFirst.mockResolvedValueOnce(
      doneStep({ task: { id: "t1", status: "done" } }),
    );
    const { uncompleteStep } = await import("./focus");
    await uncompleteStep("s1");
    expect(prismaMock.task.update).toHaveBeenCalledWith({
      where: { id: "t1", workspaceId: "owner" },
      data: { status: "active" },
    });
    // Otherwise the step is open inside a task the Done view still shows as
    // finished — the divergence this issue is about, moved one level up.
    expect(prismaMock.brainDumpItem.updateMany).toHaveBeenCalledWith({
      where: { taskId: "t1", workspaceId: "owner" },
      data: { completedAt: null },
    });
  });

  it("leaves an already-active task alone", async () => {
    prismaMock.step.findFirst.mockResolvedValueOnce(doneStep());
    const { uncompleteStep } = await import("./focus");
    await uncompleteStep("s1");
    expect(prismaMock.task.update).not.toHaveBeenCalled();
    expect(prismaMock.brainDumpItem.updateMany).not.toHaveBeenCalled();
  });

  it("patches the linked Google Task back to needsAction", async () => {
    const google = await import("@/lib/google");
    (google.getValidAccessToken as ReturnType<typeof vi.fn>).mockResolvedValue(
      "tok",
    );
    prismaMock.step.findFirst.mockResolvedValueOnce(
      doneStep({ googleTaskId: "g1", googleTaskListId: "l1" }),
    );
    const { uncompleteStep } = await import("./focus");
    await uncompleteStep("s1");
    // `needsAction` had no call site anywhere in the repo before this — the
    // outbound sync only ever went one way, which is #196's other half.
    expect(google.patchGoogleTask).toHaveBeenCalledWith("tok", "l1", "g1", {
      status: "needsAction",
    });
  });

  it("skips the Google patch when the step has no linked task, and still un-completes", async () => {
    const google = await import("@/lib/google");
    prismaMock.step.findFirst.mockResolvedValueOnce(doneStep());
    const { uncompleteStep } = await import("./focus");
    await uncompleteStep("s1");
    expect(google.patchGoogleTask).not.toHaveBeenCalled();
    expect(prismaMock.step.updateMany).toHaveBeenCalled();
  });

  it("takes back the step_done reward, so completing again cannot award twice", async () => {
    const rewards = await import("@/lib/rewards");
    prismaMock.step.findFirst.mockResolvedValueOnce(doneStep());
    const { uncompleteStep } = await import("./focus");
    await uncompleteStep("s1");
    expect(rewards.reverseStepCompletionRewards).toHaveBeenCalledWith(
      "owner",
      { includeTaskComplete: false },
      txClient,
    );
  });

  // Duo review round 3, and it was right: `markTaskCompleted` logs `task_complete`
  // when a step closes its task, and nothing stops it running a second time once
  // the step is re-completed. `awardBadge` is idempotent so the badge is safe, but
  // `logReward` is not — so the exact farm this MR closes for `step_done` was left
  // open one level up, at the task.
  it("also reverses task_complete when it actually reopens a completed task", async () => {
    const rewards = await import("@/lib/rewards");
    prismaMock.step.findFirst.mockResolvedValueOnce(
      doneStep({ task: { id: "t1", status: "done" } }),
    );
    const { uncompleteStep } = await import("./focus");
    await uncompleteStep("s1");
    expect(rewards.reverseStepCompletionRewards).toHaveBeenCalledWith(
      "owner",
      { includeTaskComplete: true },
      txClient,
    );
  });

  it("does NOT reverse task_complete when the task was already open", async () => {
    // No `task_complete` was awarded for a task that never closed, so reversing
    // one would take back points a different, genuinely finished task earned.
    const rewards = await import("@/lib/rewards");
    prismaMock.step.findFirst.mockResolvedValueOnce(doneStep());
    const { uncompleteStep } = await import("./focus");
    await uncompleteStep("s1");
    expect(rewards.reverseStepCompletionRewards).toHaveBeenCalledWith(
      "owner",
      { includeTaskComplete: false },
      txClient,
    );
  });

  // ── Review round 4: the undo is atomic, so a failure is retryable ──────────
  //
  // Round 2 moved the reversal ahead of the Google call and wrapped that call, on
  // the reasoning that "anything that throws after the step write is
  // unrecoverable, because the retry sees `!step.done` and returns". That
  // reasoning was right and the fix was one step short: the REVERSAL itself can
  // throw, and it still ran after the step write had committed. So a P2025 from a
  // concurrent reversal (or any transient DB error) left the step flipped to
  // not-done, skipped the Google patch and all three revalidations, reported
  // `focus.error.undo` — "it is still marked done", which by then was false — and
  // made every retry a silent no-op. The points stayed banked for work that had
  // been un-done, permanently.
  //
  // The property that fixes it is atomicity, not ordering: if the reversal fails,
  // the step write must not have committed. These tests pin the SHAPE that
  // delivers it; `uncomplete-step.integration.test.ts` proves the rollback itself
  // against real Postgres, which a mock cannot do.
  it("puts the local writes and the reward reversal in ONE transaction", async () => {
    const rewards = await import("@/lib/rewards");
    prismaMock.step.findFirst.mockResolvedValueOnce(
      doneStep({ task: { id: "t1", status: "done" } }),
    );
    const { uncompleteStep } = await import("./focus");
    await uncompleteStep("s1");

    expect(prismaMock.$transaction).toHaveBeenCalledTimes(1);
    // An interactive transaction (a callback), not an array: the reversal has to
    // read and then write inside it, which the array form cannot express.
    expect(typeof prismaMock.$transaction.mock.calls[0][0]).toBe("function");
    // All three local writes, and the reversal, on the transaction's client. A
    // write left on the singleton would commit on its own and survive the
    // rollback — the bug wearing the fix's clothes.
    expect(rewards.reverseStepCompletionRewards).toHaveBeenCalledWith(
      "owner",
      { includeTaskComplete: true },
      txClient,
    );
  });

  it("a failing reversal aborts the undo rather than committing half of one", async () => {
    const google = await import("@/lib/google");
    const rewards = await import("@/lib/rewards");
    (
      rewards.reverseStepCompletionRewards as ReturnType<typeof vi.fn>
    ).mockRejectedValueOnce(new Error("P2025"));
    prismaMock.step.findFirst.mockResolvedValueOnce(doneStep());
    const { uncompleteStep } = await import("./focus");

    // It must NOT resolve. `run()` in focus-timer.tsx turns a rejection into the
    // undo failure notice, and that notice's claim — the step is still marked
    // done — is only true if this rolled back.
    await expect(uncompleteStep("s1")).rejects.toThrow("P2025");
    // Nothing downstream of the transaction runs, which is correct: there is no
    // Google state to correct and nothing to revalidate for a write that never
    // landed.
    expect(google.patchGoogleTask).not.toHaveBeenCalled();
    expect(revalidatePathMock).not.toHaveBeenCalled();
  });

  it("and the retry then completes the undo, reward reversal included", async () => {
    const rewards = await import("@/lib/rewards");
    const reverse = rewards.reverseStepCompletionRewards as ReturnType<
      typeof vi.fn
    >;
    reverse.mockRejectedValueOnce(new Error("P2025"));
    prismaMock.step.findFirst.mockResolvedValueOnce(doneStep());
    const { uncompleteStep } = await import("./focus");
    await expect(uncompleteStep("s1")).rejects.toThrow("P2025");

    // The step write rolled back with the reversal, so the guard still sees
    // `done: true` — which is the ONLY reason the retry gets past
    // `if (!step.done) return` and reaches the reversal a second time. Before
    // this fix the retry read a not-done step and returned silently, and the
    // reward was stranded for good.
    prismaMock.step.findFirst.mockResolvedValueOnce(doneStep());
    await expect(uncompleteStep("s1")).resolves.toBeUndefined();

    expect(reverse).toHaveBeenCalledTimes(2);
    expect(prismaMock.step.updateMany).toHaveBeenCalledWith({
      where: { id: "s1", done: true, task: { workspaceId: "owner" } },
      data: { done: false },
    });
    expect(revalidatePathMock).toHaveBeenCalledWith("/dashboard");
  });

  // Duo review round 3 also showed round 2's session_finished fix was the wrong
  // remedy: it inferred "this completion came from a session" from whether ANY
  // completed FocusSession existed for the step, and those rows are never
  // cleared. The inference is gone entirely rather than made cleverer — see
  // `reverseStepCompletionRewards` for why `session_finished` is not reversed at
  // all.
  it("never consults FocusSession — the session reward is not reversed", async () => {
    prismaMock.step.findFirst.mockResolvedValueOnce(doneStep());
    const { uncompleteStep } = await import("./focus");
    await uncompleteStep("s1");
    expect(prismaMock.focusSession.findFirst).not.toHaveBeenCalled();
  });

  // Duo review round 2: the local write commits FIRST, so anything that throws
  // after it left the user with a step already flipped to not-done, a notice
  // falsely claiming it was "still marked done", and — because the guard is
  // `if (!step.done) return` — a retry that no-ops and never reverses the
  // reward. The reversal now happens before the Google call, and the Google
  // call cannot throw out of the action.
  it("a failing Google patch neither fails the undo nor skips the reward reversal", async () => {
    const google = await import("@/lib/google");
    const rewards = await import("@/lib/rewards");
    (google.getValidAccessToken as ReturnType<typeof vi.fn>).mockResolvedValue(
      "tok",
    );
    (google.patchGoogleTask as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error("network"),
    );
    prismaMock.step.findFirst.mockResolvedValueOnce(
      doneStep({ googleTaskId: "g1", googleTaskListId: "l1" }),
    );
    const { uncompleteStep } = await import("./focus");
    await expect(uncompleteStep("s1")).resolves.toBeUndefined();
    expect(prismaMock.step.updateMany).toHaveBeenCalled();
    expect(rewards.reverseStepCompletionRewards).toHaveBeenCalled();
  });

  it("revalidates the three paths that render step state", async () => {
    prismaMock.step.findFirst.mockResolvedValueOnce(doneStep());
    const { uncompleteStep } = await import("./focus");
    await uncompleteStep("s1");
    // Same trio as completeStep — `revalidation-hygiene.test.ts` fails the build
    // if a mutating action in this file drifts off any of them (#139).
    expect(revalidatePathMock).toHaveBeenCalledWith("/tasks/t1");
    expect(revalidatePathMock).toHaveBeenCalledWith("/");
    expect(revalidatePathMock).toHaveBeenCalledWith("/dashboard");
  });
});

describe("completeFocus — task completion", () => {
  it("last step completes the task", async () => {
    const rewards = await import("@/lib/rewards");
    prismaMock.focusSession.findFirst.mockResolvedValueOnce({ id: "sess" });
    prismaMock.focusSession.update.mockResolvedValueOnce({
      step: { id: "s2", taskId: "t1", order: 2 },
    });
    prismaMock.step.findFirst.mockResolvedValueOnce({
      id: "s2",
      taskId: "t1",
      task: { workspaceId: "owner" },
    });
    prismaMock.step.count.mockResolvedValueOnce(0);
    const { completeFocus } = await import("./focus");
    await completeFocus("sess", { durationMin: 25, addedMin: 0 });
    expect(prismaMock.task.update).toHaveBeenCalledWith({
      where: { id: "t1", workspaceId: "owner" },
      data: { status: "done" },
    });
    expect(prismaMock.brainDumpItem.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { taskId: "t1", workspaceId: "owner" },
      }),
    );
    expect(rewards.logReward).toHaveBeenCalledWith("owner", "task_complete");
  });

  it("non-last step does NOT complete the task", async () => {
    const rewards = await import("@/lib/rewards");
    prismaMock.focusSession.findFirst.mockResolvedValueOnce({ id: "sess" });
    prismaMock.focusSession.update.mockResolvedValueOnce({
      step: { id: "s2", taskId: "t1", order: 2 },
    });
    prismaMock.step.findFirst.mockResolvedValueOnce({
      id: "s2",
      taskId: "t1",
      task: { workspaceId: "owner" },
    });
    prismaMock.step.count.mockResolvedValueOnce(2);
    const { completeFocus } = await import("./focus");
    await completeFocus("sess", { durationMin: 25, addedMin: 0 });
    expect(rewards.logReward).not.toHaveBeenCalledWith(
      "owner",
      "task_complete",
    );
    expect(prismaMock.task.update).not.toHaveBeenCalledWith({
      where: { id: "t1", workspaceId: "owner" },
      data: { status: "done" },
    });
  });
});

describe("completeFocus — Google Task sync (#36: reclaimSynced dropped)", () => {
  it("returns googleSynced=true and completes the linked Google Task, without a reclaimSynced write", async () => {
    const google = await import("@/lib/google");
    (
      google.getValidAccessToken as ReturnType<typeof vi.fn>
    ).mockResolvedValueOnce("tok");
    (google.patchGoogleTask as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      true,
    );
    prismaMock.focusSession.findFirst.mockResolvedValueOnce({ id: "sess" });
    prismaMock.focusSession.update.mockResolvedValueOnce({
      step: {
        id: "s1",
        taskId: "t1",
        order: 1,
        googleTaskId: "g1",
        googleTaskListId: "l1",
      },
    });
    prismaMock.step.findFirst.mockResolvedValueOnce({
      id: "s1",
      taskId: "t1",
      task: { workspaceId: "owner" },
    });
    prismaMock.step.count.mockResolvedValueOnce(1);
    const { completeFocus } = await import("./focus");
    const res = await completeFocus("sess", { durationMin: 25, addedMin: 0 });

    expect(res.googleSynced).toBe(true);
    expect(google.patchGoogleTask).toHaveBeenCalledWith("tok", "l1", "g1", {
      status: "completed",
    });
    // The FocusSession.reclaimSynced column is gone — the only focusSession.update
    // is closeSession, which must never write a reclaimSynced field.
    for (const call of prismaMock.focusSession.update.mock.calls) {
      expect(
        (call[0] as { data?: Record<string, unknown> })?.data ?? {},
      ).not.toHaveProperty("reclaimSynced");
    }
  });

  it("returns googleSynced=false when the completed step has no linked Google Task", async () => {
    prismaMock.focusSession.findFirst.mockResolvedValueOnce({ id: "sess" });
    prismaMock.focusSession.update.mockResolvedValueOnce({
      step: {
        id: "s1",
        taskId: "t1",
        order: 1,
        googleTaskId: null,
        googleTaskListId: null,
      },
    });
    prismaMock.step.findFirst.mockResolvedValueOnce({
      id: "s1",
      taskId: "t1",
      task: { workspaceId: "owner" },
    });
    prismaMock.step.count.mockResolvedValueOnce(1);
    const { completeFocus } = await import("./focus");
    const res = await completeFocus("sess", { durationMin: 25, addedMin: 0 });
    expect(res.googleSynced).toBe(false);
  });
});
