"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import { getLLM } from "@/lib/llm";
import { resolveUtilityModel } from "@/lib/models";
import { patchGoogleTask } from "@/lib/google";
import {
  actingUserGoogleToken,
  completeGoogleTaskForTask,
  completeGoogleTaskForStep,
  reopenGoogleTaskForStep,
} from "@/lib/google-task-sync";
import {
  BadgeKey,
  FocusOutcome,
  RewardType,
  TaskStatus,
} from "@/lib/constants";
import { isGuestWorkspace } from "@/lib/workspace-kind";
import {
  awardBadge,
  logReward,
  rewardStepDone,
  reverseStepCompletionRewards,
} from "@/lib/rewards";
import { currentWorkspaceId } from "@/lib/workspace";
import { bestEffort } from "@/lib/best-effort";
import { remainingSecForSession } from "@/lib/focus-timer-clock";

/**
 * Start a focus session on a step. Returns the session id.
 *
 * #27 — resume-aware: any OPEN session already sitting on this step (paused,
 * or just abandoned mid-run by a closed tab) is retired first, as a
 * "gaveup"/abandoned close. Without this, re-entering a step left a *second*
 * (or third…) row permanently open — the setup screen offers a real "Resume"
 * CTA for a truly-paused session (see /focus/[stepId]/page.tsx +
 * `resumeFocus` below); beginFocus is only reached when the user picks
 * "Start fresh" (or there was nothing to resume), so it always means
 * "abandon whatever was open, start clean."
 */
export async function beginFocus(
  stepId: string,
  plannedMin: number,
): Promise<string | null> {
  const workspaceId = await currentWorkspaceId();
  const step = await prisma.step.findFirst({
    where: { id: stepId, task: { workspaceId } },
  });
  if (!step) return null;

  // Retire stale open session(s) before creating a fresh one. Actual elapsed
  // active time for an abandoned-never-paused session isn't known (it was
  // never explicitly paused/stamped), so this is a best-effort 0 — the point
  // is closing the row, not stats precision for a session the user walked
  // away from.
  await prisma.focusSession.updateMany({
    where: { stepId: step.id, workspaceId, endedAt: null },
    data: {
      endedAt: new Date(),
      outcome: FocusOutcome.GaveUp,
      durationMin: 0,
    },
  });

  const session = await prisma.focusSession.create({
    data: {
      stepId: step.id,
      taskId: step.taskId,
      plannedMin: Math.max(1, Math.round(plannedMin)),
      workspaceId,
    },
  });
  // First focus — awarded the first time a focus session begins (idempotent).
  //
  // Best-effort (#257): the session row above is committed and its id is what
  // the caller navigates with, so a badge insert that failed must not report the
  // start as failed. The retry cost is what makes this reachable rather than
  // tidy — the `updateMany` above retires every open session on this step BEFORE
  // creating the new one, so a person pressing Start again after a false failure
  // abandons the session that is actually running and opens another, once per
  // press. The badge is once-ever and idempotent, so the next start earns it.
  await bestEffort("first_focus_badge_failed", workspaceId, () =>
    awardBadge(workspaceId, BadgeKey.FirstFocus),
  );
  return session.id;
}

/**
 * Pause an in-progress focus session: stamps `pausedAt` and bakes the
 * caller's current adjusted total (`totalSec`, including any ±time taps made
 * before this pause) into `plannedMin`, so a resume — even after a reload or
 * from another device — restores the same total the user was looking at.
 * Idempotent: pausing an already-paused session is a no-op success (guards
 * against a double click / race).
 */
export async function pauseFocus(
  sessionId: string,
  opts: { totalSec: number },
): Promise<{ ok: boolean }> {
  const workspaceId = await currentWorkspaceId();
  const session = await prisma.focusSession.findFirst({
    where: { id: sessionId, workspaceId, endedAt: null },
  });
  if (!session) return { ok: false };
  if (session.pausedAt) return { ok: true };

  await prisma.focusSession.update({
    where: { id: sessionId },
    data: {
      pausedAt: new Date(),
      plannedMin: Math.max(1, Math.round(opts.totalSec / 60)),
    },
  });
  return { ok: true };
}

export type ResumeResult = {
  ok: boolean;
  remainingSec: number;
  totalSec: number;
  plannedMin: number;
};

const FAILED_RESUME: ResumeResult = {
  ok: false,
  remainingSec: 0,
  totalSec: 0,
  plannedMin: 0,
};

/**
 * Resume a paused focus session — REUSES the existing row (no new
 * FocusSession is created; this is the fix for the "double session" bug
 * where re-entering a step silently opened a second one). Folds the just-
 * ended pause interval into `accumulatedPausedMs`, clears `pausedAt`, and
 * returns the remaining time computed at that exact instant (so it matches
 * what the user saw right before pausing, modulo any earlier active time).
 */
export async function resumeFocus(sessionId: string): Promise<ResumeResult> {
  const workspaceId = await currentWorkspaceId();
  const session = await prisma.focusSession.findFirst({
    where: { id: sessionId, workspaceId, endedAt: null },
  });
  if (!session || !session.pausedAt) return FAILED_RESUME;

  const now = new Date();
  const accumulatedPausedMs =
    session.accumulatedPausedMs + (now.getTime() - session.pausedAt.getTime());

  await prisma.focusSession.update({
    where: { id: sessionId },
    data: { pausedAt: null, accumulatedPausedMs },
  });

  const remainingSec = remainingSecForSession(
    {
      plannedMin: session.plannedMin,
      startedAt: session.startedAt.getTime(),
      pausedAt: null,
      accumulatedPausedMs,
    },
    now.getTime(),
  );
  return {
    ok: true,
    remainingSec,
    totalSec: session.plannedMin * 60,
    plannedMin: session.plannedMin,
  };
}

async function closeSession(
  sessionId: string,
  workspaceId: string,
  outcome: string,
  durationMin: number,
  addedMin: number,
) {
  return prisma.focusSession.update({
    // #35 — `workspaceId` is in the FILTER, not just a parameter this helper
    // happens to receive. Every caller verifies ownership first, but a private
    // helper that ignores the scope it was handed is one careless call away
    // from closing somebody else's session (found by the scoping harness).
    where: { id: sessionId, workspaceId },
    data: {
      endedAt: new Date(),
      durationMin: Math.max(0, Math.round(durationMin)),
      addedMin: Math.max(0, Math.round(addedMin)),
      outcome,
    },
    include: { step: true },
  });
}

/**
 * Mark a task and its linked inbox item(s) completed, and award the
 * task-complete reward+badge. Returns whether the task's OWN Google Task was
 * patched — `completeFocus` folds that into the `googleSynced` it reports, so
 * the return value is UI-visible rather than bookkeeping (see the call site).
 *
 * The payout is BEST-EFFORT (#257). Both callers reach this line with their own
 * write already committed, and the two writes at the top of this helper commit
 * before the payout as well — so a `logReward`/`awardBadge` fault here would
 * report a completion as failed over a task that is Done and inbox rows that are
 * stamped. In `completeStep` it also skipped the three `revalidatePath` calls,
 * leaving the person's own tab showing the to-do as open.
 *
 * The residual is one `task_complete` payout. The badge is once-ever and
 * idempotent, so the next completion earns it; the points for this one are lost.
 * Google is patched either way — it is best-effort already and for the same
 * reason.
 *
 * ## Two calls, not one thunk
 *
 * The rule is on `bestEffort` (`src/lib/best-effort.ts`). Local to this site:
 * `awardBadge` is a once-ever `findUnique` + `skipDuplicates` insert that never
 * reads `RewardEvent`, so neither payout reads what the other wrote and each is
 * safe alone. Note the residual stated above is per-payout **because** of that
 * split — bundled, one fault cost both.
 */
async function markTaskCompleted(
  workspaceId: string,
  taskId: string,
): Promise<boolean> {
  const task = await prisma.task.update({
    // Scoped for the same reason as closeSession above: the helper is given a
    // workspaceId, so it must filter on it rather than trust its callers.
    where: { id: taskId, workspaceId },
    data: { status: TaskStatus.Done },
  });
  await prisma.brainDumpItem.updateMany({
    where: { taskId, workspaceId },
    data: { completedAt: new Date() },
  });
  await bestEffort("task_complete_points_failed", workspaceId, () =>
    logReward(workspaceId, RewardType.TaskComplete),
  );
  await bestEffort("task_complete_badge_failed", workspaceId, () =>
    awardBadge(workspaceId, BadgeKey.TaskComplete),
  );
  // #195 — a task can carry its OWN Google id, from having been scheduled while
  // it was still stepless (`scheduleSingleTask`). `ensureFocusStep` then creates
  // a step the moment it is focused, and that step has no id of its own, so the
  // step patch above finds nothing and the task-level Google task would stay
  // open forever. Reuses the update's return value rather than re-reading the
  // row, and runs last: it is best-effort and must not precede the local writes.
  return completeGoogleTaskForTask(task);
}

/**
 * ── The step-grain Google helpers moved to `@/lib/google-task-sync` (#209) ───
 *
 * `!288` left `completeGoogleTaskForStep` and `reopenGoogleTaskForStep` here
 * because this file was their only caller, and predicted #209 would move them
 * when `braindump.ts` needed one. It does: completing a multi-step to-do from
 * the inbox has to close each step's Google task, and a `"use server"` module
 * cannot lend a private helper out — exporting one would put a raw "patch this
 * Google task" endpoint on the wire.
 *
 * Their contract is unchanged for this file's callers, with one exception worth
 * knowing about here: the reopen twin swallows its own failures now, so the
 * try/catch {@link uncompleteStep} used to wrap it in is gone rather than
 * duplicated. What the swallow leaves behind is a local change Google never
 * heard about that nothing will ever repair — the app only writes TO Google and
 * never reads back. That INBOUND gap is #194's, and is deliberately not #196
 * (Duo review, !288, asked): #196 is an outbound patch, the `needsAction` call
 * `reopenItem` never made.
 */

/**
 * Complete a step directly (no focus session). Awards StepDone; finishes the
 * task on the last step.
 *
 * ## The payout is BEST-EFFORT, and here it is a data-integrity fix (#257)
 *
 * The step write commits on its own, and the guard at the top is
 * `if (!step || step.done) return` — so once that write has landed, **every later
 * press of THIS action returns before reaching anything below it**. A
 * `rewardStepDone` that propagated therefore did not merely report a false
 * failure: it aborted the request in front of `markTaskCompleted`, leaving the
 * task **Active with zero open steps**, plus the three revalidations unrun — so
 * the person's own tab goes on rendering the step as open, and the task page
 * shows every step ticked beside a task that is not complete.
 *
 * **Not permanent, and the earlier claim that it was is withdrawn** (`!339`
 * review): `completeStep` is not the only writer of `TaskStatus.Done`. Two other
 * presses still reach one — `completeItem` (`braindump.ts`) sets it
 * unconditionally inside its transaction once it takes the completion, and its
 * own guard (`if (!item || item.completedAt) return`) does NOT bar the way here,
 * because the `BrainDumpItem.completedAt` stamp is written by `markTaskCompleted`
 * and that is precisely what did not run; and `completeFocus` reaches
 * `markTaskCompleted` whenever `openCount === 0`, which is what the stuck state
 * is. So the honest severity is a **silently wrong render plus a lost
 * `task_complete` payout, recoverable only by a different press than the obvious
 * one** — and for a task with no linked `BrainDumpItem` (`taskId` is nullable, so
 * a task can have none) the inbox route does not exist at all. That is still
 * worth fixing here rather than filing as a nit, but it is not unrecoverable.
 * Swallowing the payout is what lets the state write behind it run.
 *
 * The residual is the `step_done` points, the ten-steps-in-a-day badge check and
 * this engagement's streak credit for the day — see `src/lib/best-effort.ts` and
 * `confirmBreakdown` for why the streak's per-day boolean makes that recoverable
 * by any other engagement the same day.
 */
export async function completeStep(stepId: string) {
  const workspaceId = await currentWorkspaceId();
  const step = await prisma.step.findFirst({
    where: { id: stepId, task: { workspaceId } },
    include: { task: { include: { steps: true } } },
  });
  if (!step || step.done) return;

  await completeGoogleTaskForStep(step);
  await prisma.step.update({ where: { id: stepId }, data: { done: true } });
  await bestEffort("step_done_bookkeeping_failed", workspaceId, () =>
    rewardStepDone(workspaceId),
  );

  const stillOpen = step.task.steps.filter((s) => s.id !== stepId && !s.done);
  if (stillOpen.length === 0) await markTaskCompleted(workspaceId, step.taskId);

  revalidatePath(`/tasks/${step.taskId}`);
  revalidatePath("/");
  revalidatePath("/dashboard");
}

/**
 * Un-complete a step (#198) — the inverse of {@link completeStep}, and the only
 * recovery path in the app for a step that was completed by accident.
 *
 * It has to exist as its own action because `reopenItem`
 * (src/app/actions/braindump.ts) — the one un-complete route that already
 * existed — takes a **BrainDumpItem** id, so it is unreachable until the whole
 * item is complete and sitting in the inbox Done view. A step completed while
 * its task still had other open steps could not be undone anywhere, which is
 * exactly the state #197's button placement kept producing.
 *
 * Three things differ from `completeStep` on purpose:
 *
 *  1. **The Google patch happens LAST, and cannot throw out of this action.**
 *     Completing patches Google first, so a step is never marked done locally
 *     while Google still shows it open. Undoing has the opposite priority: the
 *     user has asked to get their work back, and an unreachable Google must not be
 *     able to refuse them.
 *
 *     The ordering is load-bearing, not stylistic (Duo review round 2). The guard
 *     above is `if (!step.done) return`, so anything that throws *after* the step
 *     write has committed is unrecoverable: the retry sees a step that is already
 *     not-done and returns immediately, silently skipping whatever had not run.
 *     That made a transient Google error permanently strand the reward reversal
 *     while showing a notice that falsely said the step was still done. So the
 *     reversal runs BEFORE the Google call, and the Google call is wrapped — which
 *     is what makes the word "best-effort" true of the code rather than only of
 *     the comment.
 *
 *     **Round 4: ordering was necessary and not sufficient, because the reversal
 *     can throw too.** Moving it earlier only relocated the unrecoverable window
 *     — `reverseLatestReward` reads the newest row then deletes it, so two
 *     concurrent undos raced and the loser got P2025 (now fixed at source with
 *     `deleteMany`, but a dead connection can still fail the write). With the step
 *     already committed, that failure skipped the Google patch and all three
 *     revalidations, told the user "it is still marked done" — false by then — and
 *     turned every retry into a silent no-op via the guard. The points stayed
 *     banked for work that had been un-done, permanently.
 *
 *     The fix is therefore **atomicity, not ordering**: the local writes and the
 *     reversal share one `$transaction`, so a failed reversal rolls the step write
 *     back and leaves the undo exactly as retryable as it was before it was
 *     pressed — and the failure notice's claim becomes true again. The Google call
 *     and the revalidations stay OUTSIDE it: a Google failure must still not fail
 *     the undo (that is this whole point), and revalidating a transaction that
 *     went on to abort would publish a rollback.
 *  2. **The parent task is reopened if THIS step had closed it**, along with its
 *     inbox item(s) — otherwise the step is open inside a task the Done view
 *     still renders as finished.
 *  3. **The rewards that could otherwise be earned twice are taken back**, so
 *     complete → un-complete → complete cannot pay for one piece of work twice.
 *     `step_done` always; `task_complete` only when this undo actually reopened a
 *     task that was closed. `session_finished` is deliberately kept — it pays for
 *     time genuinely spent focusing, and re-completing through the timer needs a
 *     *new* session to do it. `reverseStepCompletionRewards` carries the full rule
 *     and the two review rounds that shaped it.
 */
export async function uncompleteStep(stepId: string) {
  const workspaceId = await currentWorkspaceId();
  const step = await prisma.step.findFirst({
    where: { id: stepId, task: { workspaceId } },
    include: { task: true },
  });
  if (!step || !step.done) return;

  // Whether this undo actually reopened a CLOSED task is the gate for the
  // task-level reward below, so it is recorded as a fact rather than re-derived.
  // Read outside the transaction on purpose: it describes the state the undo is
  // correcting, so re-reading it inside would only invite it to change.
  const reopenedTask = step.task?.status === TaskStatus.Done;

  // One transaction, for the reason in (1) above: if the reward reversal fails,
  // the step must still be `done` when the user retries. Every write in here runs
  // on `tx` — one left on `prisma` would commit independently and survive the
  // rollback, which is the original bug wearing this fix's clothes.
  const applied = await prisma.$transaction(async (tx) => {
    // The `!step.done` guard above is read OUTSIDE this transaction and takes no
    // lock, so it cannot stop two undos of the same step — a double-click that
    // outruns the button's own `disabled`, or the step open in two tabs, and both
    // pass it before either commits (review round 10). A second pass through here
    // is not harmlessly idempotent: `reverseLatestReward` takes back *the newest
    // `step_done` in the workspace*, not one tied to this step, so the loser
    // reverses an UNRELATED step's reward. One press, two rewards gone.
    //
    // So the precondition moves INTO the write, which is the same guarded-bulk
    // shape `reverseLatestReward` itself adopted in round 4 and for the same
    // reason: Postgres re-evaluates an UPDATE's WHERE after the row lock it was
    // waiting on is released, so the loser matches nothing and reports
    // `count: 0` rather than quietly overwriting. `count: 0` means "another
    // caller has already done all of this", which is a no-op, not an error —
    // nothing may be raised at a user who merely clicked twice.
    //
    // Scoped by `task.workspaceId` as well as by id: `updateMany` is a bulk write,
    // and `scoping.harness.test.ts` requires those to carry the scope in their own
    // arguments rather than inherit it from a read further up. `Step` has no
    // `workspaceId` column of its own, so the scope comes through its task.
    const { count } = await tx.step.updateMany({
      where: { id: stepId, done: true, task: { workspaceId } },
      data: { done: false },
    });
    if (count === 0) return false;

    // Round 11 — the same hole one level up, and it does NOT contend on the step
    // guard above: two undos of *different* steps of the same completed task touch
    // different `Step` rows, so both sail through and both carry the
    // `reopenedTask` snapshot read before either transaction opened. The task
    // transitions Done→Active once, but the reversal would run twice, and
    // `reverseLatestReward` takes back the newest `task_complete` in the
    // WORKSPACE — so the second reaches an unrelated, already-settled task's
    // reward. One reopening, two rewards gone.
    //
    // Note this is a different defect from the "which `step_done` row goes is
    // unobservable" argument in (1): that is about not caring *which* of N
    // equivalent rows is removed for one correctly-counted reversal. Here the
    // COUNT is wrong, and a count is very much observable.
    //
    // So the same guarded-write shape again, and `reopenedNow` — did THIS call
    // perform the transition — replaces the snapshot as the gate on the reward.
    let reopenedNow = false;
    if (reopenedTask) {
      const { count: reopened } = await tx.task.updateMany({
        where: { id: step.taskId, workspaceId, status: TaskStatus.Done },
        data: { status: TaskStatus.Active },
      });
      reopenedNow = reopened > 0;
      // Deliberately NOT gated on `reopenedNow`. Clearing `completedAt` is
      // idempotent, and the loser of the race wants it cleared just as much as the
      // winner did — while a task that some other path had already set Active
      // could still be carrying a completed inbox item, and gating here would stop
      // reopening it. The bug being fixed is a miscounted reward, not this write.
      await tx.brainDumpItem.updateMany({
        where: { taskId: step.taskId, workspaceId },
        data: { completedAt: null },
      });
    }

    // `markTaskCompleted` logs `task_complete` whenever a step closes its task,
    // and nothing stops it running again when the step is re-completed —
    // `awardBadge` is idempotent, `logReward` is not. So reopening a task has to
    // take that reward back, or the farm this action exists to close is simply
    // moved one level up (review round 3).
    //
    // Gated on `reopenedNow` rather than the `reopenedTask` snapshot (round 11):
    // "this call reopened the task" is the only thing that earns a reversal. The
    // snapshot means "the task looked closed when I read it", which two concurrent
    // undos of different steps both see and only one of them acts on.
    await reverseStepCompletionRewards(
      workspaceId,
      { includeTaskComplete: reopenedNow },
      tx,
    );
    return true;
  });

  // Last, and swallowed: see (1) above. A Google failure must not fail an undo
  // the user asked for, and must not strand anything behind it — there is
  // nothing behind it.
  //
  // The try/catch that used to sit here is gone, not dropped: #209 moved this
  // helper into `@/lib/google-task-sync`, where the swallow is inside it and
  // therefore true for every caller. Leaving a second one here would say the
  // contract is a caller's job, which is the shape that let `reopenItem` be
  // written without one (#196).
  //
  // Skipped when this call lost the race above: the winner has already reopened
  // the Google task, and a second PATCH would be a redundant round trip to an
  // API this app is rate-limited against. `revalidatePath` below is NOT skipped —
  // each request still has to refresh its own render, whoever did the write.
  if (applied) await reopenGoogleTaskForStep(step);

  revalidatePath(`/tasks/${step.taskId}`);
  revalidatePath("/");
  revalidatePath("/dashboard");
}

/**
 * Rename a step's text from the TaskSteps inline "Edit step title" editor.
 * Workspace-scoped; trims and ignores empty/unchanged titles.
 */
export async function renameStep(stepId: string, title: string) {
  const workspaceId = await currentWorkspaceId();
  const step = await prisma.step.findFirst({
    where: { id: stepId, task: { workspaceId } },
  });
  if (!step) return;
  const trimmed = title.trim();
  if (!trimmed || trimmed === step.text) return;

  await prisma.step.update({ where: { id: stepId }, data: { text: trimmed } });
  revalidatePath(`/tasks/${step.taskId}`);
  revalidatePath("/");
}

/**
 * Update a step's time estimate from the TaskSteps inline "Edit time estimate"
 * editor. Workspace-scoped; rounds and clamps to 1..480 minutes.
 */
export async function updateStepEstimate(stepId: string, minutes: number) {
  const workspaceId = await currentWorkspaceId();
  const step = await prisma.step.findFirst({
    where: { id: stepId, task: { workspaceId } },
  });
  if (!step) return;
  const estMinutes = Math.min(480, Math.max(1, Math.round(minutes)));

  await prisma.step.update({ where: { id: stepId }, data: { estMinutes } });
  revalidatePath(`/tasks/${step.taskId}`);
  revalidatePath("/");
}

export type CompleteResult = {
  ok: boolean;
  nextStepId: string | null;
  points: number;
  googleSynced: boolean;
  streak: number | null;
  freshStart: boolean;
};

/** Finish a session as completed: mark the step done, complete its linked Google Task, log rewards. */
export async function completeFocus(
  sessionId: string,
  opts: { durationMin: number; addedMin: number },
): Promise<CompleteResult> {
  const workspaceId = await currentWorkspaceId();
  // Verify session ownership before closing
  const sessionCheck = await prisma.focusSession.findFirst({
    where: { id: sessionId, workspaceId },
  });
  if (!sessionCheck) {
    return {
      ok: false,
      nextStepId: null,
      points: 0,
      googleSynced: false,
      streak: null,
      freshStart: false,
    };
  }

  const session = await closeSession(
    sessionId,
    workspaceId,
    FocusOutcome.Completed,
    opts.durationMin,
    opts.addedMin,
  );
  const step = session.step;
  if (!step)
    return {
      ok: false,
      nextStepId: null,
      points: 0,
      googleSynced: false,
      streak: null,
      freshStart: false,
    };

  let googleSynced = await completeGoogleTaskForStep(step);

  // Guard step ownership before update
  const stepCheck = await prisma.step.findFirst({
    where: { id: step.id, task: { workspaceId } },
  });
  if (stepCheck) {
    await prisma.step.update({ where: { id: step.id }, data: { done: true } });
  }

  // Points + streak + badges (dashboard reads these).
  //
  // Both best-effort (#257): the session is closed and the step is marked done,
  // both committed, so no payout fault may report the session as unfinished. A
  // retry here is not idempotent either — `sessionCheck` matches a session that
  // is already closed, so a second press re-closes it and banks a SECOND
  // `step_done` and `session_finished` for one stretch of work. Throwing did not
  // preserve anything; it invited the double-pay.
  //
  // Two calls and two tags — the rule is on `bestEffort`. Local to this site:
  // `session_finished` pays for time that was really spent and is the one reward
  // an undo does not take back (`reverseStepCompletionRewards`), so a failed step
  // payout must not silently cost it, and a failed bonus must not hide a streak
  // that did advance. The residual is at most one of the two, never both.
  const streak = await bestEffort("focus_step_reward_failed", workspaceId, () =>
    rewardStepDone(workspaceId),
  );
  await bestEffort("focus_session_bonus_failed", workspaceId, () =>
    logReward(workspaceId, RewardType.SessionFinished),
  );

  const next = await prisma.step.findFirst({
    where: {
      taskId: step.taskId,
      done: false,
      order: { gt: step.order },
      task: { workspaceId },
    },
    orderBy: { order: "asc" },
  });

  const openCount = await prisma.step.count({
    where: { taskId: step.taskId, done: false, task: { workspaceId } },
  });
  if (openCount === 0) {
    // Duo review (!288): OR, not overwrite. `googleSynced` drives a
    // user-visible "marked complete in Google Tasks ✅" line, and the two
    // grains are independent — a broken-down task syncs at the step, a stepless
    // one that `ensureFocusStep` gave a step syncs only here. Reading either
    // one alone reports "not synced" for a completion that did reach Google.
    googleSynced =
      (await markTaskCompleted(workspaceId, step.taskId)) || googleSynced;
  }

  // #139 — `/` unconditionally. This used to sit inside the branch above, so
  // finishing the LAST step of a task refreshed the list and finishing any
  // earlier one did not — even though every completion marks a step done and
  // changes the task's remaining minutes, both of which the list renders. Same
  // omission as `requeueFocus`, just wearing an `if`; `revalidation-hygiene`
  // now checks the position of the call, not merely its presence.
  revalidatePath(`/tasks/${step.taskId}`);
  revalidatePath("/");
  revalidatePath("/dashboard");
  return {
    ok: true,
    nextStepId: next?.id ?? null,
    points: 15,
    googleSynced,
    streak: streak?.current ?? null,
    freshStart: streak?.freshStart ?? false,
  };
}

/** Finish a session as given-up (no guilt, no step change). */
export async function giveUpFocus(
  sessionId: string,
  opts: { durationMin: number; addedMin: number },
) {
  const workspaceId = await currentWorkspaceId();
  const sessionCheck = await prisma.focusSession.findFirst({
    where: { id: sessionId, workspaceId },
  });
  if (!sessionCheck) return { ok: false };
  await closeSession(
    sessionId,
    workspaceId,
    FocusOutcome.GaveUp,
    opts.durationMin,
    opts.addedMin,
  );
  return { ok: true };
}

/** Finish as "not yet": requeue the step with a new estimate. */
export async function requeueFocus(
  sessionId: string,
  opts: { durationMin: number; addedMin: number; newEstMinutes: number },
) {
  const workspaceId = await currentWorkspaceId();
  const sessionCheck = await prisma.focusSession.findFirst({
    where: { id: sessionId, workspaceId },
  });
  if (!sessionCheck) return { ok: false };

  const session = await closeSession(
    sessionId,
    workspaceId,
    FocusOutcome.Requeued,
    opts.durationMin,
    opts.addedMin,
  );
  const step = session.step;
  if (!step) return { ok: false };

  // Guard step ownership before update
  const stepCheck = await prisma.step.findFirst({
    where: { id: step.id, task: { workspaceId } },
  });
  if (!stepCheck) return { ok: false };

  // Guard the stored history: corrupt/malformed JSON (or a non-array value)
  // must not break requeue — fall back to an empty history and carry on (#21 P5.4).
  let history: number[] = [];
  if (step.estimateHistory) {
    try {
      const parsed = JSON.parse(step.estimateHistory);
      if (Array.isArray(parsed)) history = parsed as number[];
    } catch {
      // history stays [] — fall back to empty on corrupt JSON
    }
  }
  history.push(step.estMinutes);
  const newEst = Math.max(1, Math.round(opts.newEstMinutes));

  await prisma.step.update({
    where: { id: step.id },
    data: { estMinutes: newEst, estimateHistory: JSON.stringify(history) },
  });

  // Best-effort: update the Google Task's duration syntax so Reclaim
  // reschedules. The try/catch is what makes that comment true — until !288 a
  // network error or a failed token refresh threw straight out of the action,
  // so the user got an error for an estimate that HAD been saved, and the
  // revalidation trio below never ran, leaving `/` rendering the old number.
  // That is #139's exact failure mode arriving by another route.
  if (step.googleTaskId && step.googleTaskListId) {
    try {
      const token = await actingUserGoogleToken();
      if (token) {
        const task = await prisma.task.findFirst({
          where: { id: step.taskId, workspaceId },
        });
        const emoji = task?.parentEmoji ? `${task.parentEmoji} ` : "";
        const sub = step.subtaskEmoji ? `${step.subtaskEmoji} ` : "";
        const title = `${emoji}${task?.title ?? ""}: ${step.order} of ${step.total} ${sub}${step.text} (duration:${newEst}m)`;
        await patchGoogleTask(token, step.googleTaskListId, step.googleTaskId, {
          title,
        });
      }
    } catch {
      // The estimate is saved and the requeue stands; only the Google title
      // drifts, which the next schedule or requeue rewrites anyway.
    }
  }

  // #139 — `/` is where the estimate is actually displayed, and this action
  // used to be the ONE mutation in this file that didn't invalidate it: the new
  // estimate was written (verified in the production database) while the list
  // kept rendering the old one, so a working feature looked broken. The trio
  // below matches `completeFocus`; `revalidation-hygiene.test.ts` now fails the
  // build if any mutating action here drifts back off `/`.
  revalidatePath(`/tasks/${step.taskId}`);
  revalidatePath("/");
  revalidatePath("/dashboard");
  return { ok: true };
}

/** Ask Claude for a fresh, kinder estimate when a step wasn't finished in time. */
export async function proposeNewEstimate(stepId: string): Promise<number> {
  const workspaceId = await currentWorkspaceId();
  const step = await prisma.step.findFirst({
    where: { id: stepId, task: { workspaceId } },
  });
  if (!step) return 15;
  if (await isGuestWorkspace(workspaceId)) return step.estMinutes + 10;
  try {
    const { text } = await getLLM().generate({
      model: resolveUtilityModel(),
      maxTokens: 200,
      hints: { effort: "low" },
      messages: [
        {
          role: "user",
          content: `A focus step wasn't finished in its estimated time.
Step: "${step.text}"
Original estimate: ${step.estMinutes} minutes.
Suggest a realistic, kind new estimate (a bit more time, not punishing). Reply with ONLY a JSON object: {"minutes": <integer>}.`,
        },
      ],
    });
    const m = text.match(/\{[\s\S]*\}/);
    if (m) {
      const parsed = JSON.parse(m[0]) as { minutes?: number };
      if (typeof parsed.minutes === "number" && parsed.minutes > 0) {
        return Math.round(parsed.minutes);
      }
    }
  } catch {
    // fall through
  }
  return step.estMinutes + 10;
}

/** Live focus stats for today (server-local day). */
export async function focusStatsToday(): Promise<{
  focusMin: number;
  sessions: number;
}> {
  const workspaceId = await currentWorkspaceId();
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const sessions = await prisma.focusSession.findMany({
    where: { workspaceId, startedAt: { gte: start }, endedAt: { not: null } },
    select: { durationMin: true },
  });
  return {
    focusMin: sessions.reduce((n, s) => n + (s.durationMin ?? 0), 0),
    sessions: sessions.length,
  };
}
