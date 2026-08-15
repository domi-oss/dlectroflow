/**
 * #257 — bookkeeping that fails AFTER the write it belongs to has committed.
 *
 * The rule, reached on `!330`'s review and quoted by the issue: **the `try`
 * governs the WRITE; anything after it is a consequence of success and cannot
 * un-write the row.** `writeCapture` (`!334`) applied it to the capture path;
 * this file pins the five sites in `breakdown.ts` and `focus.ts` that had the
 * same shape.
 *
 * Every block below is the same pair of assertions, deliberately:
 *
 *  * the consequence fails, and the action still reports SUCCESS — because the
 *    row is in the database, so the caller must be told the row is in the
 *    database, and the revalidations are owed either way (`reopenItem`'s rule:
 *    "each request still has to refresh its own render, whoever did the write");
 *  * **the control** — the WRITE itself fails, and the action still rejects.
 *    Without that second half a suite passes an implementation that swallows
 *    everything, which is a worse bug than the one being fixed. It is green
 *    throughout, by design, exactly as `!334`'s was.
 *
 * Prisma and `@/lib/rewards` are mocked: what is under test is which statement
 * may abort a request, not what any of them write. The reward primitives have
 * their own tests, and `rewards.integration.test.ts` proves the streak
 * transaction against real Postgres.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const {
  prismaMock,
  revalidatePathMock,
  currentWorkspaceIdMock,
  logRewardMock,
  awardBadgeMock,
  rewardStepDoneMock,
  touchStreakOnEngagementMock,
  itemIdForTaskMock,
  completeGoogleTaskForStepMock,
  completeGoogleTaskForTaskMock,
} = vi.hoisted(() => {
  const prismaMock = {
    task: { findFirst: vi.fn(), update: vi.fn() },
    step: {
      findFirst: vi.fn(),
      update: vi.fn(),
      deleteMany: vi.fn(),
      createMany: vi.fn(),
      count: vi.fn(),
    },
    brainDumpItem: { updateMany: vi.fn() },
    focusSession: {
      findFirst: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
    },
    $transaction: vi.fn(),
  };
  return {
    prismaMock,
    revalidatePathMock: vi.fn(),
    currentWorkspaceIdMock: vi.fn(),
    logRewardMock: vi.fn(),
    awardBadgeMock: vi.fn(),
    rewardStepDoneMock: vi.fn(),
    touchStreakOnEngagementMock: vi.fn(),
    itemIdForTaskMock: vi.fn().mockResolvedValue(null),
    completeGoogleTaskForStepMock: vi.fn(),
    completeGoogleTaskForTaskMock: vi.fn(),
  };
});

vi.mock("next/cache", () => ({ revalidatePath: revalidatePathMock }));
vi.mock("@/lib/db", () => ({ prisma: prismaMock }));
vi.mock("@/lib/workspace", () => ({
  currentWorkspaceId: currentWorkspaceIdMock,
  MissingWorkspaceError: class extends Error {},
}));
vi.mock("@/lib/workspace-kind", () => ({
  isGuestWorkspace: vi.fn().mockResolvedValue(false),
}));
vi.mock("@/lib/llm", () => ({ getLLM: () => ({ generate: vi.fn() }) }));
vi.mock("@/lib/models", () => ({ resolveUtilityModel: () => "model" }));
vi.mock("@/lib/google", () => ({ patchGoogleTask: vi.fn() }));
vi.mock("@/lib/google-task-sync", () => ({
  actingUserGoogleToken: vi.fn().mockResolvedValue(null),
  completeGoogleTaskForStep: completeGoogleTaskForStepMock,
  completeGoogleTaskForTask: completeGoogleTaskForTaskMock,
  reopenGoogleTaskForStep: vi.fn(),
}));
vi.mock("@/lib/rewards", () => ({
  logReward: logRewardMock,
  awardBadge: awardBadgeMock,
  rewardStepDone: rewardStepDoneMock,
  touchStreakOnEngagement: touchStreakOnEngagementMock,
  // #233 — resolved INSIDE the `bestEffort` thunk at both sites, so its swallow
  // covers this read too. `null` is the ordinary answer for a task with no inbox
  // item behind it, and is what makes an engagement credit permanent.
  itemIdForTask: itemIdForTaskMock,
  reverseStepCompletionRewards: vi.fn(),
}));

import {
  BadgeKey,
  RewardPoints,
  RewardType,
  TaskStatus,
} from "@/lib/constants";

const WS = "ws-1";
/** #233 — what a breakdown-confirm's streak credit carries. `itemId` is `null`
 *  here because `itemIdForTaskMock` answers `null`: this file's question is what
 *  happens when a post-commit payout FAILS, not attribution, and an unattributed
 *  credit is the conservative shape to default to. */
const ENGAGEMENT = { kind: "breakdown_confirmed", itemId: null };
const BOOM = "reward store went away";
/** A write that never reached the database — the control's failure. */
const DEAD = "connection refused";

/** The one open step of a one-step task, so a completion also finishes it. */
const STEP = {
  id: "step-1",
  taskId: "task-1",
  text: "Write the intro",
  order: 1,
  total: 1,
  done: false,
  estMinutes: 20,
  estimateHistory: null,
  subtaskEmoji: null,
  googleTaskId: null,
  googleTaskListId: null,
};

let errorLog: ReturnType<typeof vi.spyOn>;

type LoggedLine = { tag: string; workspaceId: string; message: string };

/**
 * The nth structured line a swallow left behind, parsed. Defaults to the first,
 * which is the only one most cases produce.
 *
 * `calls` is annotated rather than inferred: `errorLog` is typed as the general
 * `ReturnType<typeof vi.spyOn>`, so its call tuples come through as implicit
 * `any` and `noImplicitAny` rejects an un-annotated read.
 */
const loggedLine = (i = 0) =>
  JSON.parse(String((errorLog.mock.calls as unknown[][])[i][0])) as LoggedLine;

/** Duo review (`!339`): the two index-0 helpers were the same parse twice. */
const loggedTag = () => loggedLine().tag;

/**
 * The tags of EVERY line logged, in call order — for a site whose payouts are
 * split into separate `bestEffort` calls and must therefore be distinguishable
 * from each other. The index-0 helpers above cannot see a second line at all,
 * which is how a suite passes an implementation that logs one tag N times.
 */
const loggedTags = () =>
  (errorLog.mock.calls as unknown[][]).map((_, i) => loggedLine(i).tag);

beforeEach(() => {
  vi.clearAllMocks();
  errorLog = vi.spyOn(console, "error").mockImplementation(() => {});

  currentWorkspaceIdMock.mockResolvedValue(WS);
  logRewardMock.mockResolvedValue(undefined);
  awardBadgeMock.mockResolvedValue(true);
  rewardStepDoneMock.mockResolvedValue(null);
  touchStreakOnEngagementMock.mockResolvedValue(null);
  completeGoogleTaskForStepMock.mockResolvedValue(false);
  completeGoogleTaskForTaskMock.mockResolvedValue(false);

  prismaMock.task.findFirst.mockResolvedValue({ id: "task-1" });
  prismaMock.task.update.mockResolvedValue({ id: "task-1" });
  prismaMock.step.findFirst.mockResolvedValue({
    ...STEP,
    task: { id: "task-1", steps: [STEP] },
  });
  prismaMock.step.update.mockResolvedValue({});
  prismaMock.step.deleteMany.mockResolvedValue({ count: 0 });
  prismaMock.step.createMany.mockResolvedValue({ count: 1 });
  prismaMock.step.count.mockResolvedValue(1);
  prismaMock.brainDumpItem.updateMany.mockResolvedValue({ count: 1 });
  prismaMock.focusSession.findFirst.mockResolvedValue({ id: "sess-1" });
  prismaMock.focusSession.updateMany.mockResolvedValue({ count: 0 });
  prismaMock.focusSession.create.mockResolvedValue({ id: "sess-1" });
  prismaMock.focusSession.update.mockResolvedValue({
    id: "sess-1",
    plannedMin: 25,
    step: STEP,
  });
  // The array form is the only one `confirmBreakdown` uses; the callback form is
  // here so this mock stays honest if a caller changes shape.
  prismaMock.$transaction.mockImplementation((arg: unknown) =>
    typeof arg === "function"
      ? (arg as (tx: unknown) => unknown)(prismaMock)
      : Promise.all(arg as Promise<unknown>[]),
  );
});

afterEach(() => errorLog.mockRestore());

// ── confirmBreakdown ────────────────────────────────────────────────────────
describe("confirmBreakdown — a payout that fails after the steps committed", () => {
  const PROPOSAL = {
    parentEmoji: "🚀",
    steps: [{ text: "step one", estMinutes: 10, subtaskEmoji: "📝" }],
  };
  const confirm = async () => {
    const { confirmBreakdown } = await import("./breakdown");
    return confirmBreakdown("task-1", PROPOSAL);
  };

  // THE interaction, in the issue's own words: a user presses Confirm, the steps
  // commit, the streak touch fails, and the UI must NOT say the breakdown did
  // not save over steps that are in the database.
  it("resolves, because the steps are committed", async () => {
    touchStreakOnEngagementMock.mockRejectedValueOnce(new Error(BOOM));
    await expect(confirm()).resolves.toBeUndefined();
    // Also proves the queued rejection was consumed — an unconsumed `Once`
    // shifts every later test in the file by one.
    expect(touchStreakOnEngagementMock).toHaveBeenCalledExactlyOnceWith(
      WS,
      ENGAGEMENT,
    );
  });

  // Not an early return: the caller's own tab renders these two surfaces, and
  // skipping the invalidation leaves it showing a task with no steps.
  it("still revalidates the task page and the inbox", async () => {
    touchStreakOnEngagementMock.mockRejectedValueOnce(new Error(BOOM));
    await confirm();
    expect(revalidatePathMock).toHaveBeenCalledWith("/tasks/task-1");
    expect(revalidatePathMock).toHaveBeenCalledWith("/");
  });

  it("says so in the log, with a greppable tag and the workspace", async () => {
    touchStreakOnEngagementMock.mockRejectedValueOnce(new Error(BOOM));
    await confirm();
    expect(errorLog).toHaveBeenCalledTimes(1);
    expect(loggedLine().tag).toBe("breakdown_streak_touch_failed");
    expect(loggedLine().workspaceId).toBe(WS);
    expect(loggedLine().message).toContain(BOOM);
  });

  // The streak touch is the one the issue names, and it is the LAST of three
  // post-commit statements. Fixing only that one would leave the two in front of
  // it able to un-report the same commit.
  it("covers the points and the badge, not only the streak touch", async () => {
    logRewardMock.mockRejectedValueOnce(new Error(BOOM));
    await expect(confirm()).resolves.toBeUndefined();
    expect(loggedTag()).toBe("breakdown_points_failed");
    expect(revalidatePathMock).toHaveBeenCalledWith("/");

    vi.clearAllMocks();
    awardBadgeMock.mockRejectedValueOnce(new Error(BOOM));
    await expect(confirm()).resolves.toBeUndefined();
    expect(loggedTag()).toBe("breakdown_badge_failed");
    expect(revalidatePathMock).toHaveBeenCalledWith("/");
  });

  /**
   * ── The three payouts are INDEPENDENT of each other (Duo review, `!339`) ───
   *
   * The functional half, and why the finding is more than a naming nit. The three
   * consequences used to sit sequentially inside ONE `bestEffort` thunk, so the
   * first rejection **silently cancelled the two behind it**: a `logReward` fault
   * cost the FirstBreakdown badge and the day's streak credit as well as the
   * points, and one tag could not say which of the three was lost.
   *
   * Splitting is safe here, unlike `rewardStepDone` — which must stay one thunk
   * because `maybeAwardTenStepsDay` counts the `RewardEvent` that `logReward` has
   * just written. These three read nothing each other writes: `awardBadge` is a
   * once-ever `findUnique` + `skipDuplicates` insert, and
   * `touchStreakOnEngagement` reads `Settings` and `Streak` only. Neither goes
   * near `RewardEvent`.
   *
   * The assertion the old suite lacked: it checked only that the action RESOLVED
   * and revalidated, and both stayed true while two payouts were being dropped.
   */
  it("still pays the badge and the streak when the points fail", async () => {
    logRewardMock.mockRejectedValueOnce(new Error(BOOM));
    await expect(confirm()).resolves.toBeUndefined();
    expect(awardBadgeMock).toHaveBeenCalledExactlyOnceWith(
      WS,
      BadgeKey.FirstBreakdown,
    );
    expect(touchStreakOnEngagementMock).toHaveBeenCalledExactlyOnceWith(
      WS,
      ENGAGEMENT,
    );
  });

  // The middle one failing must not cost the last one either.
  it("still touches the streak when the badge fails", async () => {
    awardBadgeMock.mockRejectedValueOnce(new Error(BOOM));
    await expect(confirm()).resolves.toBeUndefined();
    expect(logRewardMock).toHaveBeenCalledWith(
      WS,
      RewardType.BreakdownConfirmed,
    );
    expect(touchStreakOnEngagementMock).toHaveBeenCalledExactlyOnceWith(
      WS,
      ENGAGEMENT,
    );
  });

  it("emits three DIFFERENT tags when all three payouts fail", async () => {
    logRewardMock.mockRejectedValueOnce(new Error(BOOM));
    awardBadgeMock.mockRejectedValueOnce(new Error(BOOM));
    touchStreakOnEngagementMock.mockRejectedValueOnce(new Error(BOOM));

    await expect(confirm()).resolves.toBeUndefined();

    // Ordered: points, badge, streak — the call order, which is what a reader of
    // the log reconstructs from it.
    expect(loggedTags()).toEqual([
      "breakdown_points_failed",
      "breakdown_badge_failed",
      "breakdown_streak_touch_failed",
    ]);
    // Three lines, because all three RAN despite all three failing. The bundled
    // version logged once and abandoned the other two.
    expect(errorLog).toHaveBeenCalledTimes(3);
    expect(new Set(loggedTags()).size).toBe(3);
  });

  // THE CONTROL. Green before the fix and after it: the steps did not save, so
  // the person must hear about it and press Confirm again.
  it("CONTROL: a step write that fails still rejects", async () => {
    prismaMock.$transaction.mockRejectedValueOnce(new Error(DEAD));
    await expect(confirm()).rejects.toThrow(DEAD);
    expect(touchStreakOnEngagementMock).not.toHaveBeenCalled();
    expect(revalidatePathMock).not.toHaveBeenCalled();
  });
});

// ── completeStep ────────────────────────────────────────────────────────────
describe("completeStep — a payout that fails after the step committed", () => {
  const complete = async () => {
    const { completeStep } = await import("./focus");
    return completeStep("step-1");
  };

  it("resolves, because the step is committed", async () => {
    rewardStepDoneMock.mockRejectedValueOnce(new Error(BOOM));
    await expect(complete()).resolves.toBeUndefined();
    expect(rewardStepDoneMock).toHaveBeenCalledExactlyOnceWith(WS, null);
  });

  /**
   * The reason this site is worse than a false failure message, and the reason
   * it is in this sweep rather than deferred.
   *
   * `completeStep` guards on `if (!step || step.done) return`, so once the step
   * write has landed a retry of THIS action returns before reaching
   * `markTaskCompleted`. A `rewardStepDone` that propagated therefore left the
   * task **Active with zero open steps**, with the three revalidations unrun — so
   * the tab that pressed it goes on showing the step open.
   *
   * **"Permanently" is withdrawn** (`!339` review): `completeItem` and
   * `completeFocus` both still reach a `TaskStatus.Done` write from that state, so
   * the damage is a wrong render plus a lost `task_complete` payout that only an
   * unobvious different press repairs — not an unrecoverable row. The docblock on
   * `completeStep` carries the full argument and the one case with no inbox route.
   */
  it("still finishes the task, so a done step cannot leave it Active", async () => {
    rewardStepDoneMock.mockRejectedValueOnce(new Error(BOOM));
    await complete();
    expect(prismaMock.task.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { status: TaskStatus.Done } }),
    );
    expect(revalidatePathMock).toHaveBeenCalledWith("/dashboard");
  });

  it("says so in the log, with a greppable tag and the workspace", async () => {
    rewardStepDoneMock.mockRejectedValueOnce(new Error(BOOM));
    await complete();
    expect(errorLog).toHaveBeenCalledTimes(1);
    expect(loggedLine().tag).toBe("step_done_bookkeeping_failed");
    expect(loggedLine().workspaceId).toBe(WS);
  });

  it("CONTROL: a step write that fails still rejects", async () => {
    prismaMock.step.update.mockRejectedValueOnce(new Error(DEAD));
    await expect(complete()).rejects.toThrow(DEAD);
    expect(rewardStepDoneMock).not.toHaveBeenCalled();
    expect(revalidatePathMock).not.toHaveBeenCalled();
  });

  // `markTaskCompleted` is the third site, reached from here and from
  // `completeFocus`. Its two payouts sit after a `Task` update and a
  // `BrainDumpItem` stamp that are both already committed.
  it("survives the task-complete payout failing, and still patches Google", async () => {
    logRewardMock.mockRejectedValueOnce(new Error(BOOM));
    await expect(complete()).resolves.toBeUndefined();
    expect(loggedTag()).toBe("task_complete_points_failed");
    // #195 — the task-grain patch runs last and is what closes a Google task
    // belonging to a to-do that was scheduled while it was still stepless.
    expect(completeGoogleTaskForTaskMock).toHaveBeenCalledTimes(1);
    expect(revalidatePathMock).toHaveBeenCalledWith("/");
  });

  /**
   * ── `markTaskCompleted`'s two payouts are independent too (Duo, 3rd round) ──
   *
   * The same defect class as `confirmBreakdown`, found a third time and in the
   * one place the sweep that "passed" could not see: the two payouts were bundled
   * in ONE thunk under one tag, so a `logReward` fault silently cost the
   * TaskComplete badge as well, with no way to tell which had failed.
   *
   * Splitting is correct here by the rule, checked rather than assumed:
   * `awardBadge(TaskComplete)` is a once-ever `findUnique` + `skipDuplicates`
   * insert that never reads `RewardEvent`, so nothing here reads what the other
   * wrote. Contrast `rewardStepDone`, which stays bundled — see its docblock.
   */
  it("still awards the badge when the task-complete points fail", async () => {
    logRewardMock.mockRejectedValueOnce(new Error(BOOM));
    await expect(complete()).resolves.toBeUndefined();
    expect(awardBadgeMock).toHaveBeenCalledWith(WS, BadgeKey.TaskComplete);
  });

  it("still logs the points when the task-complete badge fails", async () => {
    awardBadgeMock.mockRejectedValueOnce(new Error(BOOM));
    await expect(complete()).resolves.toBeUndefined();
    expect(loggedTag()).toBe("task_complete_badge_failed");
    expect(logRewardMock).toHaveBeenCalledWith(WS, RewardType.TaskComplete);
  });

  it("emits two DIFFERENT tags when both task-complete payouts fail", async () => {
    logRewardMock.mockRejectedValueOnce(new Error(BOOM));
    awardBadgeMock.mockRejectedValueOnce(new Error(BOOM));
    await expect(complete()).resolves.toBeUndefined();

    expect(loggedTags()).toEqual([
      "task_complete_points_failed",
      "task_complete_badge_failed",
    ]);
    expect(new Set(loggedTags()).size).toBe(2);
  });

  it("CONTROL: the task's own Done write failing still rejects", async () => {
    prismaMock.task.update.mockRejectedValueOnce(new Error(DEAD));
    await expect(complete()).rejects.toThrow(DEAD);
  });
});

// ── completeFocus ───────────────────────────────────────────────────────────
describe("completeFocus — a payout that fails after the session closed", () => {
  const finish = async () => {
    const { completeFocus } = await import("./focus");
    return completeFocus("sess-1", { durationMin: 25, addedMin: 0 });
  };

  /**
   * A retry here is not idempotent, which is the second reason not to throw:
   * `sessionCheck` matches a session that is already closed, so a second press
   * re-closes it and banks a second `step_done` and a second
   * `session_finished` for one stretch of work.
   */
  it("reports ok, with no streak to show", async () => {
    rewardStepDoneMock.mockRejectedValueOnce(new Error(BOOM));
    await expect(finish()).resolves.toMatchObject({
      ok: true,
      streak: null,
      freshStart: false,
    });
  });

  // Independence, the property `awardFirstSchedule` uses `allSettled` for: the
  // session bonus pays for time that was really spent, and a failed step payout
  // must not silently take it away as well.
  it("still banks the session bonus when the step payout failed", async () => {
    rewardStepDoneMock.mockRejectedValueOnce(new Error(BOOM));
    await finish();
    expect(logRewardMock).toHaveBeenCalledWith(WS, RewardType.SessionFinished);
  });

  // The other direction of the same independence: a streak that DID advance is
  // still reported, so the toast the person earned is not lost to an unrelated
  // failure one line later.
  it("still reports a streak that advanced when the bonus failed", async () => {
    rewardStepDoneMock.mockResolvedValueOnce({
      current: 3,
      freshStart: false,
      continued: true,
    });
    logRewardMock.mockRejectedValueOnce(new Error(BOOM));
    await expect(finish()).resolves.toMatchObject({ ok: true, streak: 3 });
    expect(loggedTag()).toBe("focus_session_bonus_failed");
  });

  it("says so in the log, with a greppable tag and the workspace", async () => {
    rewardStepDoneMock.mockRejectedValueOnce(new Error(BOOM));
    await finish();
    expect(errorLog).toHaveBeenCalledTimes(1);
    expect(loggedLine().tag).toBe("focus_step_reward_failed");
    expect(loggedLine().workspaceId).toBe(WS);
  });

  /**
   * ── The timer may only claim points that actually banked (Duo, `!339`) ─────
   *
   * `points` was the literal `15` — `step_done` (10) plus `session_finished` (5)
   * — returned whatever the payouts did. The swallow this MR added is what made
   * that reachable: before it, a failing payout threw and the client never saw a
   * success at all. After it, `completeFocus` could resolve
   * `{ ok: true, points: 15 }` over rewards that were never written, and
   * `focus-timer.tsx` renders `+{result.points} points` on the done screen.
   *
   * The user action is ordinary: finish a focus session while the reward write is
   * having a bad moment. The person is told "+15 points" and the dashboard total
   * does not move — a smaller lie than #257's, in the opposite direction, but the
   * same kind.
   *
   * **The figure is now derived per payout, from `RewardPoints` rather than a
   * literal**, because the two payouts are two independent `bestEffort` calls and
   * either can fail alone. So all four combinations are truthful, and the
   * hardcoded total can no longer drift from the map it was copied out of.
   *
   * **Deriving it from `streak === null` was not available, and that is the whole
   * reason `bestEffort` grew a discriminated result.** `rewardStepDone` returns
   * `StreakUpdate | null`, and `null` is a SUCCESS value — the day was already
   * credited. Duo suggested "0 when the underlying `bestEffort` call returned
   * `null`", which would have zeroed the points of every second session of the
   * day; the CONTROL below is the case that catches it.
   *
   * The residual, stated rather than implied: `rewardStepDone` is a legitimate
   * bundle, so a rejection means "something in the bundle failed", not "nothing
   * banked" — if `logReward` succeeded and the streak touch then threw, 10 points
   * did land and are not claimed. Under-claiming is the direction that cannot lie
   * to someone about their own data, so that is the direction taken.
   */
  it("does not claim the step points when the step payout failed", async () => {
    rewardStepDoneMock.mockRejectedValueOnce(new Error(BOOM));
    await expect(finish()).resolves.toMatchObject({
      ok: true,
      // The bonus banked and is still claimed; the step payout's 10 is not.
      points: RewardPoints[RewardType.SessionFinished],
    });
  });

  it("does not claim the bonus when only the bonus failed", async () => {
    logRewardMock.mockRejectedValueOnce(new Error(BOOM));
    await expect(finish()).resolves.toMatchObject({
      ok: true,
      points: RewardPoints[RewardType.StepDone],
    });
  });

  it("claims nothing at all when both payouts failed", async () => {
    rewardStepDoneMock.mockRejectedValueOnce(new Error(BOOM));
    logRewardMock.mockRejectedValueOnce(new Error(BOOM));
    // Zero, so the done screen shows the session as finished with no points
    // line — rather than a figure nobody was credited.
    await expect(finish()).resolves.toMatchObject({ ok: true, points: 0 });
  });

  /**
   * THE CONTROL, and the case that made the old `T | null` shape look reasonable:
   * a second session on a day the streak already credited. `rewardStepDone`
   * resolves `null` there, which is a success, and both payouts banked — so the
   * full figure is owed and `streak: null` means "no streak update to show",
   * not "the write failed".
   *
   * This is green before and after the change by design. It is not vacuous: it is
   * the assertion that reds under the naive fix of reading the payout's value
   * instead of its outcome, which was the suggested one.
   */
  it("CONTROL: a day already credited still claims the full figure", async () => {
    rewardStepDoneMock.mockResolvedValueOnce(null);
    await expect(finish()).resolves.toMatchObject({
      ok: true,
      points:
        RewardPoints[RewardType.StepDone] +
        RewardPoints[RewardType.SessionFinished],
      streak: null,
      freshStart: false,
    });
    // Nothing failed, so nothing was logged — the other half of "this is success".
    expect(errorLog).not.toHaveBeenCalled();
  });

  /**
   * ── The two payouts carry DIFFERENT tags (Duo review, `!339`) ─────────────
   *
   * These two calls were deliberately split so a failure in one is independent
   * of the other, and `best-effort.ts` states the invariant that makes the split
   * legible: **"the tag is the entire value of the log line"**. One tag on both
   * sites throws that away at the only place anyone reads it — a log or an alert
   * filtered on the tag cannot say WHICH of the two independent consequences was
   * lost without parsing the free-text `message`, so the split buys the code
   * independence the operator cannot see.
   *
   * Asserting the **exact tag per site** is the whole point. The two tests above
   * used to assert one shared literal, which is how a suite passes an
   * implementation whose log lines are indistinguishable: a check that only says
   * "a line was logged" is satisfied by one tag used twice.
   */
  it("emits two DIFFERENT tags when both payouts fail in one call", async () => {
    rewardStepDoneMock.mockRejectedValueOnce(new Error(BOOM));
    logRewardMock.mockRejectedValueOnce(new Error(BOOM));
    await expect(finish()).resolves.toMatchObject({ ok: true, streak: null });

    const tags = loggedTags();
    // Ordered, because the order is the call order and a reader of the log needs
    // it: the step payout runs first, the session bonus second.
    expect(tags).toEqual([
      "focus_step_reward_failed",
      "focus_session_bonus_failed",
    ]);
    // The property the shared tag lost, asserted as a property rather than as
    // two literals — this is what an alert filtered on one tag relies on.
    expect(new Set(tags).size).toBe(2);
  });

  /**
   * ── What `points` COVERS, so "only what banked" stays true (`!339` review) ──
   *
   * The figure is the SESSION's own two payouts. It is not everything the request
   * banked: finishing the LAST step of a task also reaches `markTaskCompleted`,
   * whose `task_complete` payout is worth 25 and sits outside the figure — as it
   * did before #257, when this was the literal `15`.
   *
   * So the under-claim the return statement documents has **two** cases, not the
   * one it named, and this is the second. Pinned rather than changed: the
   * direction is the safe one, and widening the figure would move a number the
   * done screen shows on every task completion, which is a product decision and
   * not a review's to take. What the two tests below buy is that nobody reads
   * "only what banked" as "all of what banked" and turns an under-claim into an
   * over-claim — the same misreading of a completeness claim that cost this MR
   * two earlier rounds.
   */
  it("counts the session's own payouts only, not the task-complete bonus", async () => {
    // The only gate on `markTaskCompleted` — see the note on the branch test
    // below for why `step.findFirst` must stay on its default here.
    prismaMock.step.count.mockResolvedValueOnce(0);

    await expect(finish()).resolves.toMatchObject({
      ok: true,
      points:
        RewardPoints[RewardType.StepDone] +
        RewardPoints[RewardType.SessionFinished],
    });
    // The 25 DID bank. It is excluded from the figure, not lost.
    expect(logRewardMock).toHaveBeenCalledWith(WS, RewardType.TaskComplete);
    expect(errorLog).not.toHaveBeenCalled();
  });

  // The corner the exclusion is most visible in: both session payouts fail on a
  // task-finishing session, so the screen shows no points line at all while the
  // task-complete payout behind it banked 25.
  it("reports no points when only the task-complete payout banked", async () => {
    prismaMock.step.count.mockResolvedValueOnce(0);
    rewardStepDoneMock.mockRejectedValueOnce(new Error(BOOM));
    // The FIRST `logReward` of the request is the session bonus; the
    // task-complete one behind it takes the default and resolves.
    logRewardMock.mockRejectedValueOnce(new Error(BOOM));

    await expect(finish()).resolves.toMatchObject({ ok: true, points: 0 });
    expect(logRewardMock).toHaveBeenCalledWith(WS, RewardType.TaskComplete);
  });

  /**
   * The recovery route that makes `completeStep`'s "permanently stuck" reading
   * wrong, pinned rather than asserted in prose (`!339` review).
   *
   * `openCount === 0` IS the state a `completeStep` whose payout threw leaves
   * behind: the step is done, the task is still Active. Neither this action's
   * `sessionCheck` nor `beginFocus`'s guard filters on `step.done`, so the state
   * is still reachable from a session — and when it is reached, this branch writes
   * the `Done` that `completeStep` never got to. Worth a test of its own because
   * the file's other `completeFocus` cases run with one step still open, so none
   * of them enters this branch at all.
   */
  it("finishes the task when no open steps remain, even if the payout failed", async () => {
    // `step.count` is the ONLY thing that gates the branch. `step.findFirst` is
    // deliberately left on its default: this action calls it twice (the ownership
    // check, then the next-step lookup), so a `…Once` here would land on the
    // first and silently skip the step's own `done` write instead.
    prismaMock.step.count.mockResolvedValueOnce(0);
    rewardStepDoneMock.mockRejectedValueOnce(new Error(BOOM));

    await expect(finish()).resolves.toMatchObject({ ok: true, streak: null });
    expect(prismaMock.task.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { status: TaskStatus.Done } }),
    );
  });

  it("CONTROL: closing the session failing still rejects", async () => {
    prismaMock.focusSession.update.mockRejectedValueOnce(new Error(DEAD));
    await expect(finish()).rejects.toThrow(DEAD);
    expect(rewardStepDoneMock).not.toHaveBeenCalled();
  });

  it("CONTROL: the step's own done write failing still rejects", async () => {
    prismaMock.step.update.mockRejectedValueOnce(new Error(DEAD));
    await expect(finish()).rejects.toThrow(DEAD);
    expect(rewardStepDoneMock).not.toHaveBeenCalled();
  });
});

// ── beginFocus ──────────────────────────────────────────────────────────────
describe("beginFocus — the badge awarded after the session row landed", () => {
  const begin = async () => {
    const { beginFocus } = await import("./focus");
    return beginFocus("step-1", 25);
  };

  /**
   * The retry cost that makes this reachable rather than tidy: `beginFocus`
   * retires every open session on the step BEFORE creating its own, so a press
   * reported as failed over a session that exists leaves the person pressing
   * Start again — and each press abandons the live session and opens another.
   */
  it("returns the session id, because the session row is committed", async () => {
    awardBadgeMock.mockRejectedValueOnce(new Error(BOOM));
    await expect(begin()).resolves.toBe("sess-1");
    expect(awardBadgeMock).toHaveBeenCalledExactlyOnceWith(
      WS,
      BadgeKey.FirstFocus,
    );
  });

  it("says so in the log, with a greppable tag and the workspace", async () => {
    awardBadgeMock.mockRejectedValueOnce(new Error(BOOM));
    await begin();
    expect(errorLog).toHaveBeenCalledTimes(1);
    expect(loggedLine().tag).toBe("first_focus_badge_failed");
    expect(loggedLine().workspaceId).toBe(WS);
  });

  it("CONTROL: a session that fails to open still rejects", async () => {
    prismaMock.focusSession.create.mockRejectedValueOnce(new Error(DEAD));
    await expect(begin()).rejects.toThrow(DEAD);
    expect(awardBadgeMock).not.toHaveBeenCalled();
  });
});
