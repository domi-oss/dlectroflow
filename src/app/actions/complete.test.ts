import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { prismaMock, txClient, revalidatePathMock, currentWorkspaceIdMock } =
  vi.hoisted(() => {
    const prismaMock = {
      brainDumpItem: {
        findFirst: vi.fn(),
        update: vi.fn().mockResolvedValue({}),
        // `{ count: 1 }` — the guarded write matched, which is the normal case.
        // #196 round 12: `reopenItem`'s un-complete carries a
        // `completedAt: { not: null }` precondition and gates the `task_complete`
        // reversal on this count, so `{ count: 0 }` is how a test says "a
        // concurrent reopen got there first".
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      step: {
        // `{ count: 1 }` — the write matched its row, which is the normal case and
        // the one `uncompleteStep` now branches on (review round 10: its `done`
        // precondition moved INTO the write, so `count: 0` means "another caller
        // got there first" and is a no-op). `completeItem` ignores the count, so
        // this default is inert for it.
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        // #196 round 12 — `reopenItem`'s step write returns the ROWS it changed,
        // not a count, because Google has to be told which steps reopened and the
        // reward reversal has to be counted off the same list. Defaulted to `[]`
        // (nothing reopened) so every test that cares states its own, and the
        // ones that don't cannot accidentally lean on a shared fixture.
        updateManyAndReturn: vi.fn().mockResolvedValue([]),
        update: vi.fn(),
        findFirst: vi.fn(),
        count: vi.fn(),
      },
      task: {
        update: vi.fn().mockResolvedValue({}),
        // Round 11 — the Done→Active transition is a guarded bulk write now, and
        // `uncompleteStep` branches on its count: only the caller that actually
        // performed the transition may reverse `task_complete`.
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      rewardEvent: {
        create: vi.fn().mockResolvedValue({}),
        count: vi.fn().mockResolvedValue(0),
      },
      badge: {
        findUnique: vi.fn().mockResolvedValue(null),
        createMany: vi.fn().mockResolvedValue({ count: 1 }),
        // Mocked only so a regression that starts revoking badges on a reopen
        // has something to be caught by — #196 decided they stand.
        deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
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
  // #196 — the same rule at whole-to-do arity, for `reopenItem`.
  reverseItemCompletionRewards: vi
    .fn()
    .mockResolvedValue({ stepDone: 1, taskComplete: false }),
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
import { TASK_WRITER_TX_BUDGET } from "@/lib/constants";

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

/**
 * #195 — a STEPLESS to-do's scheduling unit is the TASK, so `scheduleSingleTask`
 * stores the Google id on `Task.googleTaskId`. Only the step twin ever patched
 * `status: "completed"`, so completing such an item in the app left the Google
 * task open and Reclaim kept the calendar block.
 *
 * The guard keys off **`Task.googleTaskId` being set**, NOT off "the task has no
 * steps". They are different conditions and the id is the correct one: an item
 * scheduled while stepless keeps its task-level Google task forever, and steps
 * added afterwards (by a breakdown, or lazily by `ensureFocusStep`) get their
 * OWN Google tasks from a separate `upsertGoogleTask` call. Keying off the step
 * count would strand exactly that task-level one, which is the bug this fixes.
 */
describe("completeItem — Google Task sync (#195)", () => {
  it("PATCHes a stepless item's Task.googleTaskId to completed", async () => {
    const google = await import("@/lib/google");
    (
      google.getValidAccessToken as ReturnType<typeof vi.fn>
    ).mockResolvedValueOnce("tok");
    prismaMock.brainDumpItem.findFirst.mockResolvedValueOnce({
      id: "i1",
      completedAt: null,
      task: {
        id: "t1",
        steps: [],
        googleTaskId: "g-task",
        googleTaskListId: "l1",
      },
    });
    const { completeItem } = await import("./braindump");
    await completeItem("i1");
    expect(google.patchGoogleTask).toHaveBeenCalledWith("tok", "l1", "g-task", {
      status: "completed",
    });
  });

  it("still PATCHes when the task HAS steps — the guard is the id, not the step count", async () => {
    const google = await import("@/lib/google");
    (
      google.getValidAccessToken as ReturnType<typeof vi.fn>
    ).mockResolvedValueOnce("tok");
    prismaMock.brainDumpItem.findFirst.mockResolvedValueOnce({
      id: "i2",
      completedAt: null,
      task: {
        id: "t1",
        steps: [{ id: "s1", done: false }],
        googleTaskId: "g-task",
        googleTaskListId: "l1",
      },
    });
    const { completeItem } = await import("./braindump");
    await completeItem("i2");
    expect(google.patchGoogleTask).toHaveBeenCalledWith("tok", "l1", "g-task", {
      status: "completed",
    });
  });

  it("skips silently when the task carries no Google id", async () => {
    const google = await import("@/lib/google");
    prismaMock.brainDumpItem.findFirst.mockResolvedValueOnce({
      id: "i3",
      completedAt: null,
      task: {
        id: "t1",
        steps: [],
        googleTaskId: null,
        googleTaskListId: null,
      },
    });
    const { completeItem } = await import("./braindump");
    await completeItem("i3");
    expect(google.getValidAccessToken).not.toHaveBeenCalled();
    expect(google.patchGoogleTask).not.toHaveBeenCalled();
    expect(prismaMock.brainDumpItem.update).toHaveBeenCalled();
  });

  it("skips silently when the acting account has no Google credential", async () => {
    const google = await import("@/lib/google");
    (
      google.getValidAccessToken as ReturnType<typeof vi.fn>
    ).mockResolvedValueOnce(null);
    prismaMock.brainDumpItem.findFirst.mockResolvedValueOnce({
      id: "i4",
      completedAt: null,
      task: {
        id: "t1",
        steps: [],
        googleTaskId: "g-task",
        googleTaskListId: "l1",
      },
    });
    const { completeItem } = await import("./braindump");
    await completeItem("i4");
    expect(google.patchGoogleTask).not.toHaveBeenCalled();
    expect(prismaMock.brainDumpItem.update).toHaveBeenCalled();
  });

  it("a thrown Google error never fails the completion (best-effort contract)", async () => {
    const google = await import("@/lib/google");
    (
      google.getValidAccessToken as ReturnType<typeof vi.fn>
    ).mockResolvedValueOnce("tok");
    (google.patchGoogleTask as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error("network down"),
    );
    prismaMock.brainDumpItem.findFirst.mockResolvedValueOnce({
      id: "i5",
      completedAt: null,
      task: {
        id: "t1",
        steps: [],
        googleTaskId: "g-task",
        googleTaskListId: "l1",
      },
    });
    const { completeItem } = await import("./braindump");
    await expect(completeItem("i5")).resolves.toBeUndefined();
    const upd = prismaMock.brainDumpItem.update.mock.calls[0][0];
    expect(upd.data.completedAt).toBeInstanceOf(Date);
    expect(logReward).toHaveBeenCalledWith("owner", "task_complete");
  });

  it("a token lookup that throws never fails the completion either", async () => {
    const google = await import("@/lib/google");
    (
      google.getValidAccessToken as ReturnType<typeof vi.fn>
    ).mockRejectedValueOnce(new Error("refresh failed"));
    prismaMock.brainDumpItem.findFirst.mockResolvedValueOnce({
      id: "i6",
      completedAt: null,
      task: {
        id: "t1",
        steps: [],
        googleTaskId: "g-task",
        googleTaskListId: "l1",
      },
    });
    const { completeItem } = await import("./braindump");
    await expect(completeItem("i6")).resolves.toBeUndefined();
    expect(prismaMock.brainDumpItem.update).toHaveBeenCalled();
  });
});

/**
 * #209 — the STEP half of the same gap, and a different code path from #195's.
 *
 * `completeItem` closes every step in one `updateMany`, so the per-step patch
 * `completeStep` performs never happens. In Google Tasks all of them stayed
 * open and Reclaim kept every block. Completing the same steps one at a time
 * through the focus timer always worked, which is why this survived #195.
 */
describe("completeItem — step-level Google Task sync (#209)", () => {
  /** A multi-step to-do, every step scheduled, the task itself not. */
  function multiStepItem(steps: Record<string, unknown>[]) {
    return {
      id: "i1",
      completedAt: null,
      task: {
        id: "t1",
        googleTaskId: null,
        googleTaskListId: null,
        steps,
      },
    };
  }

  let google_: typeof import("@/lib/google");

  function patchedIds() {
    return (google_.patchGoogleTask as ReturnType<typeof vi.fn>).mock.calls.map(
      (c) => c[2],
    );
  }

  // `vi.clearAllMocks()` in the outer `beforeEach` clears CALLS but not
  // implementations, so a `mockResolvedValue` set here would leak into every
  // later test in the file. Both are restored to the module mock's defaults
  // afterwards, which is what the rest of this file is written against.
  beforeEach(async () => {
    google_ = await import("@/lib/google");
    (google_.getValidAccessToken as ReturnType<typeof vi.fn>).mockResolvedValue(
      "tok",
    );
  });

  afterEach(() => {
    (google_.getValidAccessToken as ReturnType<typeof vi.fn>).mockResolvedValue(
      null,
    );
    (google_.patchGoogleTask as ReturnType<typeof vi.fn>).mockResolvedValue(
      undefined,
    );
  });

  it("completes every step's own Google Task", async () => {
    prismaMock.brainDumpItem.findFirst.mockResolvedValueOnce(
      multiStepItem([
        { id: "s1", done: false, googleTaskId: "g1", googleTaskListId: "l1" },
        { id: "s2", done: false, googleTaskId: "g2", googleTaskListId: "l1" },
      ]),
    );
    const { completeItem } = await import("./braindump");
    await completeItem("i1");
    for (const g of ["g1", "g2"]) {
      expect(google_.patchGoogleTask).toHaveBeenCalledWith("tok", "l1", g, {
        status: "completed",
      });
    }
  });

  // "Skip steps that were already done before this call — they were patched
  // when they were completed, and re-patching costs a request per step for no
  // change" (#209). The count is the assertion: a request that changes nothing
  // is still a request against a rate-limited API.
  it("skips steps that were already done before this call", async () => {
    prismaMock.brainDumpItem.findFirst.mockResolvedValueOnce(
      multiStepItem([
        { id: "s1", done: true, googleTaskId: "g1", googleTaskListId: "l1" },
        { id: "s2", done: false, googleTaskId: "g2", googleTaskListId: "l1" },
      ]),
    );
    const { completeItem } = await import("./braindump");
    await completeItem("i1");
    expect(patchedIds()).toEqual(["g2"]);
  });

  // Both grains, and neither implies the other: a to-do scheduled while stepless
  // that was later broken down carries an id on the task AND on its steps.
  it("completes the task's own Google Task alongside its steps", async () => {
    prismaMock.brainDumpItem.findFirst.mockResolvedValueOnce({
      id: "i2",
      completedAt: null,
      task: {
        id: "t1",
        googleTaskId: "g-task",
        googleTaskListId: "l1",
        steps: [
          { id: "s1", done: false, googleTaskId: "g1", googleTaskListId: "l1" },
        ],
      },
    });
    const { completeItem } = await import("./braindump");
    await completeItem("i2");
    expect(patchedIds().sort()).toEqual(["g-task", "g1"]);
  });

  it("does not reach for a credential when nothing is scheduled", async () => {
    prismaMock.brainDumpItem.findFirst.mockResolvedValueOnce(
      multiStepItem([
        { id: "s1", done: false, googleTaskId: null, googleTaskListId: null },
      ]),
    );
    const { completeItem } = await import("./braindump");
    await completeItem("i1");
    expect(google_.getValidAccessToken).not.toHaveBeenCalled();
    expect(google_.patchGoogleTask).not.toHaveBeenCalled();
  });

  // "One slow or failing step must not abandon the rest" (#209), and none of
  // them may cost the user the completion they asked for.
  it("one failing step neither fails the completion nor abandons the others", async () => {
    (google_.patchGoogleTask as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error("network down"),
    );
    prismaMock.brainDumpItem.findFirst.mockResolvedValueOnce(
      multiStepItem([
        { id: "s1", done: false, googleTaskId: "g1", googleTaskListId: "l1" },
        { id: "s2", done: false, googleTaskId: "g2", googleTaskListId: "l1" },
        { id: "s3", done: false, googleTaskId: "g3", googleTaskListId: "l1" },
      ]),
    );
    const { completeItem } = await import("./braindump");
    await expect(completeItem("i1")).resolves.toBeUndefined();
    expect(patchedIds().sort()).toEqual(["g1", "g2", "g3"]);
    expect(prismaMock.brainDumpItem.update).toHaveBeenCalled();
  });

  // The ordering invariant `!288` pinned in the lib module's doc: the local
  // writes land first, so an unreachable Google can never cost the completion.
  it("patches only after the local writes have landed", async () => {
    const order: string[] = [];
    prismaMock.brainDumpItem.update.mockImplementationOnce(async () => {
      order.push("local");
      return {};
    });
    (
      google_.patchGoogleTask as ReturnType<typeof vi.fn>
    ).mockImplementationOnce(async () => {
      order.push("google");
      return true;
    });
    prismaMock.brainDumpItem.findFirst.mockResolvedValueOnce(
      multiStepItem([
        { id: "s1", done: false, googleTaskId: "g1", googleTaskListId: "l1" },
      ]),
    );
    const { completeItem } = await import("./braindump");
    await completeItem("i1");
    expect(order).toEqual(["local", "google"]);
  });
});

describe("reopenItem", () => {
  // The shape both writes carry since #196 round 12: the precondition that makes
  // a losing concurrent reopen a no-op lives IN the write, so it is asserted
  // here rather than left to the integration test to discover.
  const STEP_SELECT = { googleTaskId: true, googleTaskListId: true };

  it("clears completedAt for a single-task item, only while it is set", async () => {
    prismaMock.brainDumpItem.findFirst.mockResolvedValueOnce({
      id: "i1",
      task: null,
    });
    const { reopenItem } = await import("./braindump");
    await reopenItem("i1");
    expect(prismaMock.brainDumpItem.updateMany).toHaveBeenCalledWith({
      where: { id: "i1", workspaceId: "owner", completedAt: { not: null } },
      data: { completedAt: null },
    });
  });

  it("reopens a multi-step task: reactivates + resets the selected steps that were done", async () => {
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
    expect(prismaMock.step.updateManyAndReturn).toHaveBeenCalledWith({
      where: {
        id: { in: ["s2"] },
        done: true,
        task: { workspaceId: "owner" },
      },
      data: { done: false },
      select: STEP_SELECT,
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
    expect(prismaMock.step.updateManyAndReturn).toHaveBeenCalledWith({
      where: {
        id: { in: ["a", "b"] },
        done: true,
        task: { workspaceId: "owner" },
      },
      data: { done: false },
      select: STEP_SELECT,
    });
  });

  it("gives its transaction the shared writer budget rather than Prisma's 5s default", async () => {
    // #251 review — the same gap `deleteBrainDumpItem` had, on the transaction
    // beside it. Both take the `BrainDumpItem` row lock that `keepAsTask` and
    // `ensureFocusStep` take, and both are documented as answering a second
    // caller with `count: 0` rather than an error; at Prisma's 5s default a
    // loser that waits longer than that for the lock is killed with `P2028
    // Transaction already closed` and rolled back instead, which converts the
    // promised no-op into an error raised at somebody who pressed Reopen twice.
    // One defect class, so one fix — this is not a second issue.
    prismaMock.brainDumpItem.findFirst.mockResolvedValueOnce({
      id: "i1",
      task: null,
    });
    const { reopenItem } = await import("./braindump");
    await reopenItem("i1");
    expect(prismaMock.$transaction).toHaveBeenCalledWith(
      expect.any(Function),
      TASK_WRITER_TX_BUDGET,
    );
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
    const call = prismaMock.step.updateManyAndReturn.mock.calls[0][0];
    expect(call.data).toEqual({ done: false });
    expect(call.where.id.in).toContain("b"); // last step forced not-done
  });
});

/**
 * #196 — the reverse direction. `reopenItem` cleared `completedAt`, set the task
 * Active and flipped steps back to `done: false`, and never told Google
 * anything. In the app the work was open again; in Google Tasks every task was
 * still `completed`, no later action ever un-completed them, and Reclaim never
 * re-booked the time. `needsAction` is a value `patchGoogleTask` has always
 * accepted and this path had never sent.
 */
describe("reopenItem — Google Task sync (#196)", () => {
  let google_: typeof import("@/lib/google");

  function patchedIds() {
    return (google_.patchGoogleTask as ReturnType<typeof vi.fn>).mock.calls.map(
      (c) => c[2],
    );
  }

  /** A completed multi-step to-do, scheduled at both grains. */
  function completedItem(overrides: Record<string, unknown> = {}) {
    return {
      id: "i1",
      completedAt: new Date(),
      task: {
        id: "t1",
        googleTaskId: "g-task",
        googleTaskListId: "l1",
        steps: [
          { id: "s1", done: true, googleTaskId: "g1", googleTaskListId: "l1" },
          { id: "s2", done: true, googleTaskId: "g2", googleTaskListId: "l1" },
        ],
      },
      ...overrides,
    };
  }

  /**
   * What the guarded step write reports back — the rows it actually flipped, and
   * since round 12 the ONLY thing Google is told about. Stated per test rather
   * than derived from the snapshot on purpose: the whole defect was two undos
   * counted off two different sources of truth, so a fixture that quietly kept
   * them in step would hide the property under test.
   */
  function writeReopens(...googleTaskIds: (string | null)[]) {
    prismaMock.step.updateManyAndReturn.mockResolvedValueOnce(
      googleTaskIds.map((googleTaskId) => ({
        googleTaskId,
        googleTaskListId: googleTaskId ? "l1" : null,
      })),
    );
  }

  beforeEach(async () => {
    google_ = await import("@/lib/google");
    (google_.getValidAccessToken as ReturnType<typeof vi.fn>).mockResolvedValue(
      "tok",
    );
  });

  afterEach(() => {
    (google_.getValidAccessToken as ReturnType<typeof vi.fn>).mockResolvedValue(
      null,
    );
    (google_.patchGoogleTask as ReturnType<typeof vi.fn>).mockResolvedValue(
      undefined,
    );
  });

  it("patches every reopened step, and the task's own Google Task, to needsAction", async () => {
    prismaMock.brainDumpItem.findFirst.mockResolvedValueOnce(completedItem());
    writeReopens("g1", "g2");
    const { reopenItem } = await import("./braindump");
    await reopenItem("i1");
    expect(patchedIds().sort()).toEqual(["g-task", "g1", "g2"]);
    for (const call of (google_.patchGoogleTask as ReturnType<typeof vi.fn>)
      .mock.calls) {
      expect(call[3]).toEqual({ status: "needsAction" });
    }
  });

  it("patches only the steps the caller selected", async () => {
    prismaMock.brainDumpItem.findFirst.mockResolvedValueOnce(completedItem());
    writeReopens("g2");
    const { reopenItem } = await import("./braindump");
    await reopenItem("i1", ["s2"]);
    expect(patchedIds().sort()).toEqual(["g-task", "g2"]);
    // The selection reaches Google via the WRITE's `id in` filter, not via a
    // second pass over the snapshot — that is the round-12 shape.
    expect(
      prismaMock.step.updateManyAndReturn.mock.calls[0][0].where.id.in,
    ).toEqual(["s2"]);
  });

  // A step that was already open is already `needsAction` in Google. Re-patching
  // it costs a request against a rate-limited API and changes nothing — the same
  // rule the completion direction follows for steps already done (#209).
  //
  // Round 12 moved the filter from a `.filter(s => s.done)` over the snapshot
  // into the write's own `done: true`, so the already-open step is absent from
  // what comes back and Google never hears of it.
  it("does not re-patch a selected step that was already open", async () => {
    prismaMock.brainDumpItem.findFirst.mockResolvedValueOnce(
      completedItem({
        task: {
          id: "t1",
          googleTaskId: null,
          googleTaskListId: null,
          steps: [
            {
              id: "s1",
              done: false,
              googleTaskId: "g1",
              googleTaskListId: "l1",
            },
            {
              id: "s2",
              done: true,
              googleTaskId: "g2",
              googleTaskListId: "l1",
            },
          ],
        },
      }),
    );
    writeReopens("g2"); // `done: true` excluded s1 before the update ran
    const { reopenItem } = await import("./braindump");
    await reopenItem("i1", ["s1", "s2"]);
    expect(patchedIds()).toEqual(["g2"]);
    expect(
      prismaMock.step.updateManyAndReturn.mock.calls[0][0].where.done,
    ).toBe(true);
  });

  // The ≥1-not-done guard can add a step the caller did not select. If that step
  // was done, it is genuinely being reopened and Google has to hear about it.
  it("patches the step the ≥1-not-done guard forces open", async () => {
    prismaMock.brainDumpItem.findFirst.mockResolvedValueOnce(
      completedItem({
        task: {
          id: "t1",
          googleTaskId: null,
          googleTaskListId: null,
          steps: [
            {
              id: "s1",
              done: true,
              googleTaskId: "g1",
              googleTaskListId: "l1",
            },
            {
              id: "s2",
              done: true,
              googleTaskId: "g2",
              googleTaskListId: "l1",
            },
          ],
        },
      }),
    );
    writeReopens("g2");
    const { reopenItem } = await import("./braindump");
    await reopenItem("i1", ["missing"]); // selects nothing real → last step forced
    expect(patchedIds()).toEqual(["g2"]);
  });

  /**
   * Round 12 — the losing side of a double-tap sends nothing.
   *
   * Both guarded writes report that they changed nothing, so this call reopened
   * neither the item nor any step: the winner has already patched Google, and a
   * second round of PATCHes would buy an identical remote state at the cost of
   * requests against an API this app is rate-limited against. The credential is
   * never even resolved, which is the observable form of "nothing was queued".
   */
  it("sends nothing to Google when a concurrent reopen already did the work", async () => {
    prismaMock.brainDumpItem.updateMany.mockResolvedValueOnce({ count: 0 });
    prismaMock.brainDumpItem.findFirst.mockResolvedValueOnce(completedItem());
    writeReopens(); // the `done: true` precondition matched no rows
    const { reopenItem } = await import("./braindump");
    await reopenItem("i1");
    expect(google_.getValidAccessToken).not.toHaveBeenCalled();
    expect(google_.patchGoogleTask).not.toHaveBeenCalled();
    // Still revalidated: this request has to re-render whoever did the write.
    expect(revalidatePathMock).toHaveBeenCalledWith("/");
  });

  /**
   * The ordering `!288` pinned in the lib module's doc, and the one #196's
   * checklist calls out: the patch runs AFTER the `$transaction` and outside it.
   * A patch awaited inside would roll a reopen the user asked for back on a
   * network blip — and a transaction that aborts must leave Google untouched,
   * because there is no longer any local change for it to mirror.
   */
  it("never patches when the transaction aborts", async () => {
    prismaMock.$transaction.mockRejectedValueOnce(new Error("deadlock"));
    prismaMock.brainDumpItem.findFirst.mockResolvedValueOnce(completedItem());
    const { reopenItem } = await import("./braindump");
    await expect(reopenItem("i1")).rejects.toThrow("deadlock");
    expect(google_.patchGoogleTask).not.toHaveBeenCalled();
    expect(revalidatePathMock).not.toHaveBeenCalled();
  });

  it("a thrown Google patch never fails the reopen", async () => {
    (google_.patchGoogleTask as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("network down"),
    );
    prismaMock.brainDumpItem.findFirst.mockResolvedValueOnce(completedItem());
    writeReopens("g1", "g2");
    const { reopenItem } = await import("./braindump");
    await expect(reopenItem("i1")).resolves.toBeUndefined();
    expect(prismaMock.step.updateManyAndReturn).toHaveBeenCalled();
    expect(revalidatePathMock).toHaveBeenCalledWith("/");
  });

  it("skips the sync entirely for a to-do that was never scheduled", async () => {
    prismaMock.brainDumpItem.findFirst.mockResolvedValueOnce({
      id: "i9",
      completedAt: new Date(),
      task: {
        id: "t1",
        googleTaskId: null,
        googleTaskListId: null,
        steps: [
          { id: "s1", done: true, googleTaskId: null, googleTaskListId: null },
        ],
      },
    });
    writeReopens(null); // reopened, but it addresses no Google task
    const { reopenItem } = await import("./braindump");
    await reopenItem("i9");
    expect(google_.getValidAccessToken).not.toHaveBeenCalled();
    expect(google_.patchGoogleTask).not.toHaveBeenCalled();
  });
});

/**
 * #196, second defect — `reopenItem` re-awards points.
 *
 * `completeItem` logs one `step_done` per step it closes plus a
 * `task_complete`, and reopening took none of it back, so complete → reopen →
 * complete has always banked every one of them twice for one piece of work. It
 * is the same farm `!286` closed for `uncompleteStep` (#198), one route along,
 * and the rule is the one `reverseStepCompletionRewards` already documents: a
 * reward comes back when the same work could otherwise be paid for twice.
 */
describe("reopenItem — reward reversal (#196)", () => {
  function reopened(overrides: Record<string, unknown> = {}) {
    return {
      id: "i1",
      completedAt: new Date(),
      task: {
        id: "t1",
        googleTaskId: null,
        googleTaskListId: null,
        steps: [
          { id: "s1", done: true },
          { id: "s2", done: true },
          { id: "s3", done: false },
        ],
      },
      ...overrides,
    };
  }

  /** How many rows the guarded step write reports it flipped done → not-done. */
  function writeReopened(n: number) {
    prismaMock.step.updateManyAndReturn.mockResolvedValueOnce(
      Array.from({ length: n }, () => ({
        googleTaskId: null,
        googleTaskListId: null,
      })),
    );
  }

  it("takes back one step_done per step it actually un-completed", async () => {
    const rewards = await import("@/lib/rewards");
    prismaMock.brainDumpItem.findFirst.mockResolvedValueOnce(reopened());
    // s3 was already open, so the write's `done: true` never matched it and no
    // `step_done` was ever banked for it to reverse.
    writeReopened(2);
    const { reopenItem } = await import("./braindump");
    await reopenItem("i1");
    expect(rewards.reverseItemCompletionRewards).toHaveBeenCalledWith(
      "owner",
      { stepDone: 2, includeTaskComplete: true },
      txClient,
    );
  });

  it("counts only the selected steps", async () => {
    const rewards = await import("@/lib/rewards");
    prismaMock.brainDumpItem.findFirst.mockResolvedValueOnce(reopened());
    writeReopened(1);
    const { reopenItem } = await import("./braindump");
    await reopenItem("i1", ["s1"]);
    expect(rewards.reverseItemCompletionRewards).toHaveBeenCalledWith(
      "owner",
      { stepDone: 1, includeTaskComplete: true },
      txClient,
    );
    expect(
      prismaMock.step.updateManyAndReturn.mock.calls[0][0].where.id.in,
    ).toEqual(["s1"]);
  });

  // The gate is what the write DID, never what the read saw (round 12). An item
  // that was not completed fails the `completedAt: { not: null }` precondition,
  // so the write reports `count: 0` — and it never earned a `task_complete`, so
  // reversing one here would take points from a different, finished to-do.
  it("does NOT reverse task_complete for an item that was not completed", async () => {
    const rewards = await import("@/lib/rewards");
    prismaMock.brainDumpItem.updateMany.mockResolvedValueOnce({ count: 0 });
    prismaMock.brainDumpItem.findFirst.mockResolvedValueOnce(
      reopened({ completedAt: null }),
    );
    writeReopened(2);
    const { reopenItem } = await import("./braindump");
    await reopenItem("i1");
    expect(rewards.reverseItemCompletionRewards).toHaveBeenCalledWith(
      "owner",
      { stepDone: 2, includeTaskComplete: false },
      txClient,
    );
  });

  /**
   * Round 12 — the losing side of a double-tap reverses nothing at all.
   *
   * Both guarded writes report they changed nothing, which is the only honest
   * reading of "another caller has already done all of this". Reversing on the
   * pre-transaction snapshot instead is the defect: `reverseLatestReward` takes
   * back the newest row of a type in the WORKSPACE, so a second reversal for one
   * reopen reaches unrelated, already-settled work.
   */
  it("reverses nothing when both guarded writes report they changed nothing", async () => {
    const rewards = await import("@/lib/rewards");
    prismaMock.brainDumpItem.updateMany.mockResolvedValueOnce({ count: 0 });
    prismaMock.brainDumpItem.findFirst.mockResolvedValueOnce(reopened());
    writeReopened(0);
    const { reopenItem } = await import("./braindump");
    await reopenItem("i1");
    expect(rewards.reverseItemCompletionRewards).toHaveBeenCalledWith(
      "owner",
      { stepDone: 0, includeTaskComplete: false },
      txClient,
    );
  });

  // The two gates are independent, and a partial overlap has to be counted
  // partially: this caller lost the item but still reopened a step the winner
  // had not selected.
  it("reverses the step_done it won without the task_complete it lost", async () => {
    const rewards = await import("@/lib/rewards");
    prismaMock.brainDumpItem.updateMany.mockResolvedValueOnce({ count: 0 });
    prismaMock.brainDumpItem.findFirst.mockResolvedValueOnce(reopened());
    writeReopened(1);
    const { reopenItem } = await import("./braindump");
    await reopenItem("i1");
    expect(rewards.reverseItemCompletionRewards).toHaveBeenCalledWith(
      "owner",
      { stepDone: 1, includeTaskComplete: false },
      txClient,
    );
  });

  it("reverses task_complete alone for a stepless to-do", async () => {
    const rewards = await import("@/lib/rewards");
    prismaMock.brainDumpItem.findFirst.mockResolvedValueOnce({
      id: "i2",
      completedAt: new Date(),
      task: null,
    });
    const { reopenItem } = await import("./braindump");
    await reopenItem("i2");
    expect(rewards.reverseItemCompletionRewards).toHaveBeenCalledWith(
      "owner",
      { stepDone: 0, includeTaskComplete: true },
      txClient,
    );
    // No task, so no step write to gate on — and nothing to gate.
    expect(prismaMock.step.updateManyAndReturn).not.toHaveBeenCalled();
  });

  /**
   * Atomicity, for the reason review round 4 established on `uncompleteStep`: a
   * reversal that fails must roll the local writes back with it, or the to-do is
   * reopened with the points still banked and nothing will ever take them.
   */
  it("runs the reversal inside the reopen's own transaction", async () => {
    prismaMock.brainDumpItem.findFirst.mockResolvedValueOnce(reopened());
    const { reopenItem } = await import("./braindump");
    await reopenItem("i1");
    expect(prismaMock.$transaction).toHaveBeenCalledTimes(1);
    expect(typeof prismaMock.$transaction.mock.calls[0][0]).toBe("function");
  });

  it("a failing reversal aborts the reopen rather than committing half of one", async () => {
    const rewards = await import("@/lib/rewards");
    (
      rewards.reverseItemCompletionRewards as ReturnType<typeof vi.fn>
    ).mockRejectedValueOnce(new Error("P1001"));
    prismaMock.brainDumpItem.findFirst.mockResolvedValueOnce(reopened());
    const { reopenItem } = await import("./braindump");
    await expect(reopenItem("i1")).rejects.toThrow("P1001");
    expect(revalidatePathMock).not.toHaveBeenCalled();
  });

  // Badges are NOT reversed, and that is a decision rather than an oversight
  // (#196's checklist asked for it in writing): they are once-ever achievements,
  // `awardBadge` is idempotent so re-completing cannot earn a second one, and
  // revoking one would make the collection lie about the past.
  it("never revokes the TaskComplete badge", async () => {
    prismaMock.brainDumpItem.findFirst.mockResolvedValueOnce(reopened());
    const { reopenItem } = await import("./braindump");
    await reopenItem("i1");
    expect(prismaMock.badge.deleteMany).not.toHaveBeenCalled();
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
    expect(prismaMock.task.updateMany).not.toHaveBeenCalled();
    expect(prismaMock.task.update).not.toHaveBeenCalled();
  });

  it("reopens the task and its inbox item when THAT step had closed the task", async () => {
    prismaMock.step.findFirst.mockResolvedValueOnce(
      doneStep({ task: { id: "t1", status: "done" } }),
    );
    const { uncompleteStep } = await import("./focus");
    await uncompleteStep("s1");
    // `status: "done"` in the WHERE is the round-11 fix: it makes the transition
    // itself the thing that decides whether a `task_complete` reversal is owed, so
    // two undos of two different steps of one task cannot reverse it twice.
    expect(prismaMock.task.updateMany).toHaveBeenCalledWith({
      where: { id: "t1", workspaceId: "owner", status: "done" },
      data: { status: "active" },
    });
    expect(prismaMock.task.update).not.toHaveBeenCalled();
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
    expect(prismaMock.task.updateMany).not.toHaveBeenCalled();
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

/**
 * #195, second route — `ensureFocusStep` lazily creates a step for a STEPLESS
 * item the moment it is focused, and that step carries no `googleTaskId`. So
 * finishing it patches nothing, while the task-level Google task written by
 * `scheduleSingleTask` is still open. `markTaskCompleted` is where a task stops
 * being open, so it is where the task-level patch belongs.
 */
describe("markTaskCompleted — task-level Google Task sync (#195)", () => {
  it("completes Task.googleTaskId when the last step finishes", async () => {
    const google = await import("@/lib/google");
    (
      google.getValidAccessToken as ReturnType<typeof vi.fn>
    ).mockResolvedValueOnce("tok");
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
    prismaMock.step.count.mockResolvedValueOnce(0);
    prismaMock.task.update.mockResolvedValueOnce({
      id: "t1",
      googleTaskId: "g-task",
      googleTaskListId: "l1",
    });
    const { completeFocus } = await import("./focus");
    await completeFocus("sess", { durationMin: 25, addedMin: 0 });
    expect(google.patchGoogleTask).toHaveBeenCalledWith("tok", "l1", "g-task", {
      status: "completed",
    });
  });

  it("does not patch a task that was never scheduled as a stepless unit", async () => {
    const google = await import("@/lib/google");
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
    prismaMock.step.count.mockResolvedValueOnce(0);
    prismaMock.task.update.mockResolvedValueOnce({
      id: "t1",
      googleTaskId: null,
      googleTaskListId: null,
    });
    const { completeFocus } = await import("./focus");
    await completeFocus("sess", { durationMin: 25, addedMin: 0 });
    expect(google.patchGoogleTask).not.toHaveBeenCalled();
  });

  // Duo review (!288): `googleSynced` is not bookkeeping — the focus timer
  // prints "· marked complete in Google Tasks ✅" off it. Computing it from the
  // STEP patch alone told the user "not synced" in precisely the case #195
  // fixes, because a lazily-stepped stepless item syncs at the task grain.
  it("reports googleSynced=true when only the TASK-level patch synced", async () => {
    const google = await import("@/lib/google");
    (
      google.getValidAccessToken as ReturnType<typeof vi.fn>
    ).mockResolvedValueOnce("tok");
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
    prismaMock.step.count.mockResolvedValueOnce(0);
    prismaMock.task.update.mockResolvedValueOnce({
      id: "t1",
      googleTaskId: "g-task",
      googleTaskListId: "l1",
    });
    (google.patchGoogleTask as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      true,
    );
    const { completeFocus } = await import("./focus");
    const res = await completeFocus("sess", { durationMin: 25, addedMin: 0 });
    expect(res.googleSynced).toBe(true);
  });

  it("keeps googleSynced=false when neither grain synced", async () => {
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
    prismaMock.step.count.mockResolvedValueOnce(0);
    prismaMock.task.update.mockResolvedValueOnce({
      id: "t1",
      googleTaskId: null,
      googleTaskListId: null,
    });
    const { completeFocus } = await import("./focus");
    const res = await completeFocus("sess", { durationMin: 25, addedMin: 0 });
    expect(res.googleSynced).toBe(false);
  });
});

/**
 * Duo review (!288) — the best-effort contract has to hold at BOTH grains, or
 * it is not a contract. `actingUserGoogleToken` is now shared, and it throws
 * when a token refresh fails; the step twin had no try/catch, so a stale
 * refresh token would have failed the whole step completion.
 */
describe("completeGoogleTaskForStep — best-effort at the step grain (#195)", () => {
  it("a thrown PATCH still marks the step done", async () => {
    const google = await import("@/lib/google");
    (
      google.getValidAccessToken as ReturnType<typeof vi.fn>
    ).mockResolvedValueOnce("tok");
    (google.patchGoogleTask as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error("network down"),
    );
    prismaMock.step.findFirst.mockResolvedValueOnce({
      id: "s1",
      taskId: "t1",
      done: false,
      googleTaskId: "g1",
      googleTaskListId: "l1",
      task: { id: "t1", steps: [{ id: "s1", done: false }] },
    });
    const { completeStep } = await import("./focus");
    await expect(completeStep("s1")).resolves.toBeUndefined();
    expect(prismaMock.step.update).toHaveBeenCalledWith({
      where: { id: "s1" },
      data: { done: true },
    });
  });

  it("a thrown token refresh still marks the step done", async () => {
    const google = await import("@/lib/google");
    (
      google.getValidAccessToken as ReturnType<typeof vi.fn>
    ).mockRejectedValueOnce(new Error("refresh failed"));
    prismaMock.step.findFirst.mockResolvedValueOnce({
      id: "s1",
      taskId: "t1",
      done: false,
      googleTaskId: "g1",
      googleTaskListId: "l1",
      task: { id: "t1", steps: [{ id: "s1", done: false }] },
    });
    const { completeStep } = await import("./focus");
    await expect(completeStep("s1")).resolves.toBeUndefined();
    expect(prismaMock.step.update).toHaveBeenCalledWith({
      where: { id: "s1" },
      data: { done: true },
    });
  });
});
