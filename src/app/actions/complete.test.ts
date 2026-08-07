import { describe, it, expect, vi, beforeEach } from "vitest";

const { prismaMock, revalidatePathMock, currentWorkspaceIdMock } = vi.hoisted(
  () => {
    const prismaMock = {
      brainDumpItem: {
        findFirst: vi.fn(),
        update: vi.fn().mockResolvedValue({}),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      step: {
        updateMany: vi.fn().mockResolvedValue({ count: 0 }),
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
    .mockResolvedValue({ stepDone: true, sessionFinished: false }),
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
    expect(prismaMock.step.update).toHaveBeenCalledWith({
      where: { id: "s1" },
      data: { done: false },
    });
  });

  it("no-ops on a missing step, and on one that is not done", async () => {
    prismaMock.step.findFirst.mockResolvedValueOnce(null);
    const { uncompleteStep } = await import("./focus");
    await uncompleteStep("nope");
    expect(prismaMock.step.update).not.toHaveBeenCalled();

    prismaMock.step.findFirst.mockResolvedValueOnce(doneStep({ done: false }));
    await uncompleteStep("s1");
    expect(prismaMock.step.update).not.toHaveBeenCalled();
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
    expect(prismaMock.step.update).toHaveBeenCalled();
  });

  it("takes back the step_done reward, so completing again cannot award twice", async () => {
    const rewards = await import("@/lib/rewards");
    prismaMock.step.findFirst.mockResolvedValueOnce(doneStep());
    prismaMock.focusSession.findFirst.mockResolvedValueOnce(null);
    const { uncompleteStep } = await import("./focus");
    await uncompleteStep("s1");
    expect(rewards.reverseStepCompletionRewards).toHaveBeenCalledWith("owner", {
      includeSessionFinished: false,
    });
  });

  // Duo review round 2, and it was right: `completeFocus` logs TWO rewards for
  // one step — `rewardStepDone` AND `RewardType.SessionFinished` — and the undo
  // this MR adds lives on the timer's done screen, i.e. exactly the path that
  // logs the second one. Reversing only `step_done` left the session reward
  // farmable, which is the loophole the MR claims to close.
  it("also reverses the SESSION reward when the completion came through a focus session", async () => {
    const rewards = await import("@/lib/rewards");
    prismaMock.step.findFirst.mockResolvedValueOnce(doneStep());
    prismaMock.focusSession.findFirst.mockResolvedValueOnce({ id: "fs-1" });
    const { uncompleteStep } = await import("./focus");
    await uncompleteStep("s1");
    expect(prismaMock.focusSession.findFirst.mock.calls[0][0].where).toEqual({
      stepId: "s1",
      workspaceId: "owner",
      outcome: "completed",
    });
    expect(rewards.reverseStepCompletionRewards).toHaveBeenCalledWith("owner", {
      includeSessionFinished: true,
    });
  });

  it("does NOT reverse a session reward for a step completed without one", async () => {
    // `completeStep` (the step row's ✓, no timer) awards only `step_done`.
    // Reversing a `session_finished` here would take back points earned by a
    // DIFFERENT, genuinely finished session — the one case where "which row goes
    // is unobservable" stops being true.
    const rewards = await import("@/lib/rewards");
    prismaMock.step.findFirst.mockResolvedValueOnce(doneStep());
    prismaMock.focusSession.findFirst.mockResolvedValueOnce(null);
    const { uncompleteStep } = await import("./focus");
    await uncompleteStep("s1");
    expect(rewards.reverseStepCompletionRewards).toHaveBeenCalledWith("owner", {
      includeSessionFinished: false,
    });
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
    prismaMock.focusSession.findFirst.mockResolvedValueOnce(null);
    const { uncompleteStep } = await import("./focus");
    await expect(uncompleteStep("s1")).resolves.toBeUndefined();
    expect(prismaMock.step.update).toHaveBeenCalled();
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
