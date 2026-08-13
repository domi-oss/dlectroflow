import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import {
  RewardType,
  RewardPoints,
  BadgeKey,
  type RewardType as RewardTypeT,
  type BadgeKey as BadgeKeyT,
} from "@/lib/constants";
import { inboxZeroQueueWhere } from "@/lib/inbox-zero-queue";
import { getSettings, getStreak } from "@/lib/db";

// ── helpers ────────────────────────────────────────────────────────────────
function ymd(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
    d.getDate(),
  ).padStart(2, "0")}`;
}
function startOfToday(): Date {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}
function isoWeekday(d: Date): number {
  const wd = d.getDay(); // 0=Sun..6=Sat
  return wd === 0 ? 7 : wd; // 1=Mon..7=Sun
}
function parseWorkingDays(csv: string): number[] {
  return csv
    .split(",")
    .map((s) => parseInt(s.trim(), 10))
    .filter((n) => n >= 1 && n <= 7);
}

// ── points ───────────────────────────────────────────────────────────────
export async function logReward(
  workspaceId: string,
  type: RewardTypeT,
  points?: number,
) {
  await prisma.rewardEvent.create({
    data: { type, points: points ?? RewardPoints[type], workspaceId },
  });
}

/**
 * When the needs-triage queue just hit empty: award the once-ever Inbox-zero
 * badge (idempotent) and the once/day Inbox-zero points.
 *
 * The queue's definition lives in `inbox-zero-queue.ts` since #251's review, so
 * that `deleteBrainDumpItem` can ask whether the row it removed was in it without
 * restating the three terms — read that module's note for why there are two
 * shapes of one predicate and what keeps them honest.
 */
export async function maybeAwardInboxZero(workspaceId: string) {
  const now = new Date();
  const remaining = await prisma.brainDumpItem.count({
    where: inboxZeroQueueWhere(workspaceId, now),
  });
  if (remaining > 0) return;
  // Inbox-zero badge — once ever, awarded the first time the queue empties.
  await awardBadge(workspaceId, BadgeKey.InboxZero);
  // Inbox-zero points — once/day.
  const already = await prisma.rewardEvent.count({
    where: {
      workspaceId,
      type: RewardType.InboxZero,
      createdAt: { gte: startOfToday() },
    },
  });
  if (already > 0) return;
  await logReward(workspaceId, RewardType.InboxZero);
}

// ── badges ─────────────────────────────────────────────────────────────────
/**
 * Award a badge once. Returns true if it was newly earned, false if it was
 * already held.
 *
 * The findUnique→create pair is a TOCTOU by design: two concurrent awards can
 * both pass the existence check and both write. That used to be handled by
 * catching the resulting P2002, which was correct and still printed — Prisma's
 * client logger fires before our `catch` ever sees the error (#158, and see the
 * note on `log` in src/lib/db.ts). `createMany` + `skipDuplicates` compiles to
 * `INSERT ... ON CONFLICT DO NOTHING`, so the loser inserts nothing and is told
 * so by `count`, rather than raising.
 *
 * `createMany` rather than `!240`'s `createManyAndReturn`: the caller wants the
 * boolean, never the row, so there is nothing to RETURNING. And `count` carries
 * exactly the fact the old `catch` was reconstructing — 1 means this call
 * earned it, 0 means somebody already had.
 *
 * The leading read stays. Most calls are for a badge already held
 * (`maybeAwardTenStepsDay` fires on every step completion past the tenth), and
 * an indexed SELECT is cheaper than a speculative insert that has to be rolled
 * back on conflict.
 */
export async function awardBadge(
  workspaceId: string,
  key: BadgeKeyT,
): Promise<boolean> {
  const existing = await prisma.badge.findUnique({
    where: { workspaceId_key: { workspaceId, key } },
  });
  if (existing) return false;
  const { count } = await prisma.badge.createMany({
    data: { key, workspaceId },
    skipDuplicates: true,
  });
  return count > 0; // 0 = a concurrent award won the race; the badge exists
}

/** Award ten-steps-in-a-day once StepDone count for today reaches 10. */
export async function maybeAwardTenStepsDay(
  workspaceId: string,
): Promise<void> {
  const stepsToday = await prisma.rewardEvent.count({
    where: {
      workspaceId,
      type: RewardType.StepDone,
      createdAt: { gte: startOfToday() },
    },
  });
  if (stepsToday >= 10) await awardBadge(workspaceId, BadgeKey.TenStepsDay);
}

/**
 * Shared "a step got done" reward path — used by finishing a focus session AND
 * by completing a step directly. Logs StepDone, extends the streak, and awards
 * the ten-steps-in-a-day badge. Does NOT log SessionFinished (that is the focus
 * timer's own bonus).
 *
 * ## ⚠️ A DELIBERATE EXCEPTION to the one-call-per-consequence rule
 *
 * Most multi-payout post-commit work in this app is split into one `bestEffort`
 * call per consequence. The rule, and the callee test that decides it, are on
 * `bestEffort` (`src/lib/best-effort.ts`) — **this function is one of the two that
 * legitimately stay bundled** (the other is `touchStreakOnEngagement` below, which
 * this function also calls), and it is flagged here rather than only behind that
 * pointer so a bundled block is never read as an oversight.
 *
 * Note it is reached under **two** tags — `step_done_bookkeeping_failed` and
 * `focus_step_reward_failed` — because `completeStep` and `completeFocus` both wrap
 * it. One exception, two tags; an earlier version of the union marked only one of
 * them, which is what made an "only one exception" count wrong.
 *
 * The local fact that earns the exception: `maybeAwardTenStepsDay` does
 * `rewardEvent.count({ type: StepDone })`, counting the row `logReward` writes two
 * lines above. Split those two and the count is short by one on the tenth step of
 * the day, so the badge is silently not awarded — **wrong rather than merely
 * missing**, which is worse than what splitting fixes.
 *
 * **The residual, stated rather than implied.** `touchStreakOnEngagement` sits
 * between them and IS independent (it reads `Settings` and `Streak` only), so if it
 * rejects, `maybeAwardTenStepsDay` does not run. Reordering does not remove that —
 * it only moves which consequence is cancelled, because `await` sequencing is what
 * carries the dependency. Removing it entirely would mean per-payout swallows
 * *inside* a reward primitive, which `best-effort.ts` rejects by design: the
 * swallow belongs to the caller that committed the write. Both callers already wrap
 * this whole function, so a fault here is logged and cannot report the write as
 * failed; what is lost is at most the remainder of one step's payout.
 */
export async function rewardStepDone(
  workspaceId: string,
): Promise<StreakUpdate | null> {
  await logReward(workspaceId, RewardType.StepDone);
  const streak = await touchStreakOnEngagement(workspaceId); // completion is a qualifying engagement
  await maybeAwardTenStepsDay(workspaceId);
  return streak;
}

/**
 * Take back the points a step completion awarded, because that completion is
 * being undone (#198).
 *
 * ── What gets reversed, and the rule behind it ──────────────────────────────
 *
 * A reward is reversed when **the same work could otherwise be paid for twice**.
 * It is kept when the reward records something that genuinely happened and does
 * not un-happen. Applying that rule to the four types this app awards:
 *
 *  * **`step_done` — reversed.** Awarded once per completion of a step, and a
 *    step can be completed, undone and completed again with no new work in
 *    between. Duplicable, so it comes back.
 *  * **`task_complete` — reversed, but only when this undo actually reopens a
 *    task that was closed.** `markTaskCompleted` logs it whenever a step closes
 *    its task, and nothing stops it running again when that step is re-completed
 *    (`awardBadge` is idempotent; `logReward` is not). Same farm as `step_done`,
 *    one level up — found in review round 3. The gate is real state (the task WAS
 *    `Done` and is now Active), never an inference.
 *  * **`session_finished` — NOT reversed, deliberately.** It pays for *having
 *    focused for a stretch of time*, not for the step being finished, and that
 *    time was really spent. This is the same argument that keeps the streak
 *    below, and it has to be the same or the two are incoherent. It is also not
 *    farmable: re-completing through the timer requires pressing Start, which
 *    calls `beginFocus` and opens a **new** `FocusSession`, so a second
 *    `session_finished` is paid for by a second real session.
 *
 *    Review round 2 flagged the missing reversal and round 3 showed the fix was
 *    the wrong remedy: it inferred "this completion came from a session" from
 *    whether *any* completed `FocusSession` existed for the step, and those rows
 *    are never cleared — so after one timer completion, every later undo claimed
 *    a session and deleted the newest `session_finished` in the workspace, which
 *    could belong to unrelated, legitimately finished work. The inference is gone
 *    rather than made cleverer, because there was nothing correct for it to infer
 *    from.
 *  * **Badges — not reversed by an UNDO.** Once-ever achievements; revoking one
 *    would make the collection lie about the past, and `awardBadge` is
 *    idempotent anyway.
 *
 *    Narrowed from "not reversed" to "not reversed by an undo" in #251, because
 *    a delete is not an undo and the owner decided the two answer differently.
 *    Reopening a to-do leaves it on the board still able to earn the badge back;
 *    **deleting one destroys the evidence it was ever earned**, and a badge whose
 *    qualifying condition no longer holds anywhere in the workspace is not a
 *    record of the past, it is a claim nothing supports. That case has its own
 *    entry point — {@link revokeUnqualifiedBadges} — which every caller here
 *    still declines to use. The rule above is unchanged for undo; it simply no
 *    longer over-claims for delete.
 *
 * ── Why "the newest row of that type" — and where that stopped being enough ──
 *
 * Each reversal removes the most recent row of its type, not "the one this step
 * earned", because there is no such thing: `RewardEvent` carries type, points and
 * workspace and holds no step or task reference (see `prisma/schema.prisma`), so
 * every row of one type in a workspace is an identical `RewardPoints[type]`.
 * Attributing rewards to their source would need a nullable column and a
 * migration.
 *
 * This paragraph used to end "**within a type, which row goes is
 * unobservable**", and #251 falsified that. It was true while every reader of
 * `RewardEvent` summed the whole workspace, and {@link revokeUnqualifiedBadges}
 * is the **first per-day read of `RewardEvent` inside a reversal path**: it
 * recounts `step_done` rows from `startOfToday()` to decide whether
 * `ten_steps_day` still qualifies. The moment a reader groups by day, *which* row
 * goes decides an answer — measured, deleting an item completed yesterday
 * consumed three of today's rows, dropped today's count from ten to seven and
 * revoked a badge earned today by ten steps that still existed.
 *
 * So "newest" is now a **default with an upper bound available**, not an
 * invariant: a caller that knows when the work it is reversing was finished
 * passes that instant and the reversal prefers the newest row not newer than it.
 * The claim is left recorded rather than deleted, because the next per-day reader
 * of this table will be tempted by the same reasoning. `getDashboardData`'s
 * `todayPoints` and `gatherDayData` in `rollup.ts` are two more such readers, and
 * they are why the bound is worth having beyond the badge.
 *
 * That argument holds **within** a type and **not across** types, which is
 * exactly where round 2's fix went wrong: deleting a `session_finished` to
 * compensate for a `step_done` is not a relabelling, it is taking points from
 * different work. Every gate here is therefore a fact about state, not a guess
 * about provenance.
 *
 * Returns what was actually removed, so callers can be tested on it and so
 * "nothing to reverse" is a normal answer rather than an error.
 *
 * ── `db`: why this takes a transaction client ────────────────────────────────
 *
 * `uncompleteStep` (src/app/actions/focus.ts) runs its local writes and this
 * reversal inside ONE `prisma.$transaction`, so that a reversal that fails rolls
 * the step write back with it and the undo stays retryable — read the note there
 * for the failure it closes (review round 4). That only holds if the reversal
 * actually joins the transaction, so the client is a parameter rather than the
 * module-level singleton. It defaults to `prisma`, which keeps every other
 * caller and the unit tests unchanged.
 */
export async function reverseStepCompletionRewards(
  workspaceId: string,
  opts: { includeTaskComplete: boolean },
  db: Prisma.TransactionClient = prisma,
): Promise<{ stepDone: boolean; taskComplete: boolean }> {
  const { stepDone, taskComplete } = await reverseItemCompletionRewards(
    workspaceId,
    { stepDone: 1, includeTaskComplete: opts.includeTaskComplete },
    db,
  );
  return { stepDone: stepDone > 0, taskComplete };
}

/**
 * The same reversal at whole-to-do arity, for `reopenItem` (#196) and — since
 * #251 — for `deleteBrainDumpItem`.
 *
 * ── Why one primitive serves both ───────────────────────────────────────────
 *
 * Deleting a completed to-do owes **what reopening that whole row would owe**:
 * one `step_done` per step that was done, plus a `task_complete` if it was
 * carrying a completion. Stating it as an equality rather than as a second rule
 * is what keeps the two paths from drifting — a user who reopens a to-do and then
 * deletes it must end on the same balance as one who deletes it outright, and
 * they only do if both routes ask this function the same question. The delete's
 * caller therefore counts its arguments off what its own writes destroyed,
 * exactly as `reopenItem` counts them off what its writes changed.
 *
 * The equality is against a **whole-row** reopen, which is the only reopen a
 * delete has an analogue for — there is no partial delete to compare with
 * `reopenItem(id, stepIds)`. It also stops short in the one case the two writes
 * genuinely differ: when another `BrainDumpItem` still references the Task, the
 * delete destroys no steps and so owes no `step_done`, while a reopen would still
 * reverse them because it turns those surviving steps back to not-done. No code
 * path creates a second item on one Task today (see the note at the delete's
 * call site), so this is a boundary being stated rather than a case being
 * handled.
 *
 * ── Why the step count is a parameter ───────────────────────────────────────
 *
 * `uncompleteStep` undoes exactly one step, so
 * {@link reverseStepCompletionRewards} takes back exactly one `step_done`.
 * Reopening a to-do from the inbox Done view undoes as many as the user
 * selected, and `completeItem` banked one per step it closed — so a five-step
 * reopen owes five, and reopening then re-completing paid for the same work
 * twice. That defect was live in production and is what #196 records as its
 * second half.
 *
 * The two counts move **independently**, which is why this is not a loop around
 * the singular version: a stepless to-do earns a `task_complete` and no
 * `step_done` at all, and calling the singular one anyway would take back the
 * newest `step_done` in the WORKSPACE — a row belonging to unrelated work. Same
 * class of error as the `session_finished` inference round 3 removed above.
 *
 * ── Sequential, deliberately ────────────────────────────────────────────────
 *
 * Each reversal reads "the newest row of this type" and then deletes it, so
 * running them concurrently would have every read return the same row and only
 * one delete land — reporting N reversals for one. The loop also stops the
 * moment the workspace runs out: once there is no `step_done` left there will
 * not be one on the next pass either, and each extra request is a wasted round
 * trip inside the caller's open transaction.
 *
 * `stepDone` in the result is a COUNT, not a flag, so a caller can be tested on
 * having asked for the right number.
 *
 * ── `stepDoneNotAfter`: the step rows, and only the step rows (#251 review) ──
 *
 * Read the amended "newest row" note above first. A caller that knows when the
 * work it is reversing was finished passes that instant, and each `step_done`
 * reversal then prefers the newest row not newer than it — so a delete of
 * yesterday's to-do takes yesterday's points and leaves today's count, and the
 * day's badge, alone.
 *
 * **It bounds the step rows only, and that asymmetry is measured rather than
 * chosen.** `completeItem` banks one `step_done` per step it closes and THEN
 * stamps `completedAt`, and logs the `task_complete` after the stamp. Measured on
 * real Postgres against that exact ordering: the step rows land at the stamp or
 * 2ms before it, the completion row 3ms after. So `completedAt` is a correct
 * upper bound for the item's own step rows and an incorrect one for its own
 * completion row — bounding `task_complete` by it would skip the item's row every
 * time and take an older one instead, which is the defect this fixes rather than
 * a fix for it. There is no sound bound available for `task_complete` (the only
 * candidate is "the oldest row at or after the stamp", which inverts the
 * primitive's meaning and breaks under two completions in the same instant), and
 * none is needed: the only per-day reader that reversal feeds is
 * {@link revokeUnqualifiedBadges}'s `task_complete` branch, which recomputes
 * `brainDumpItem` STATE — "is any item still completed" — and never reads
 * `RewardEvent` by day. The unobservability argument still holds for that type.
 *
 * The bound is a **preference, not a filter**: when the workspace holds fewer
 * rows inside it than the caller owes, the reversal falls through to the
 * unbounded set rather than stopping short. Stopping short would leave a payout
 * banked with nothing left that could ever take it, which is the opposite failure
 * from the one the floor guard exists for.
 */
export async function reverseItemCompletionRewards(
  workspaceId: string,
  opts: {
    stepDone: number;
    includeTaskComplete: boolean;
    /** When the work being reversed was finished — see the note above. */
    stepDoneNotAfter?: Date;
  },
  db: Prisma.TransactionClient = prisma,
): Promise<{ stepDone: number; taskComplete: boolean }> {
  let stepDone = 0;
  while (stepDone < opts.stepDone) {
    if (
      !(await reverseLatestReward(
        workspaceId,
        RewardType.StepDone,
        db,
        opts.stepDoneNotAfter,
      ))
    ) {
      break; // nothing left in this workspace to take back
    }
    stepDone += 1;
  }
  const taskComplete = opts.includeTaskComplete
    ? await reverseLatestReward(workspaceId, RewardType.TaskComplete, db)
    : false;
  return { stepDone, taskComplete };
}

/**
 * Revoke every badge whose qualifying condition no longer holds — #251.
 *
 * Called only by `deleteBrainDumpItem`, and only when that delete actually
 * reversed something. A delete destroys the work a badge was awarded for, so
 * unlike an undo it can leave a badge with nothing behind it (see the amended
 * rule on {@link reverseStepCompletionRewards}).
 *
 * ── `reversed`: each badge is gated on the reversal that could un-qualify it ─
 *
 * Not on "the delete reversed *something*". Recomputing a condition and revoking
 * on the answer is only a reversal if this call is what moved that condition;
 * otherwise it is taking away a badge the deleted row had no part in earning, and
 * a workspace can already be sitting on an unqualified badge with no delete
 * involved (reopening the only completed to-do leaves `task_complete` in exactly
 * that state). Both directions were live and both are now covered:
 *
 *  * a **step-only** reversal — the `isFullyDone` route, every step ticked and
 *    `completedAt` never stamped — recomputed "is any item completed" as false and
 *    revoked `task_complete`, which it had not touched;
 *  * a **completion-only** reversal — a stepless to-do — recomputed today's step
 *    count, found it under ten, and revoked `ten_steps_day` without having changed
 *    a single `step_done`.
 *
 * ── Only badges whose condition is RECOMPUTABLE are in scope ────────────────
 *
 * `Badge` records a key, a workspace and `earnedAt`. It records nothing about
 * *what* earned it, and `RewardEvent` carries no link back to a to-do either —
 * so "did this item contribute to this badge" is not a question the schema can
 * answer. What it can answer is "does the condition still hold **now**", and for
 * two of the nine badges that is the same question:
 *
 *  * **`task_complete`** — awarded on a completion (`completeItem`, and
 *    `markTaskCompleted` in focus.ts, which stamps `completedAt` on the linked
 *    items too). It qualifies exactly while some item in the workspace carries a
 *    `completedAt`, so deleting the last one leaves it unsupported.
 *  * **`ten_steps_day`** — awarded when the day's `step_done` count reaches ten.
 *    Recheckable **only for a badge earned today**: the model has no per-day
 *    ledger, so today's count says nothing about the Tuesday it was actually
 *    earned on, and revoking on that basis would be taking away something the
 *    deleted item never contributed to. `earnedAt` is the gate that keeps this a
 *    reversal rather than a guess.
 *
 * The other seven are deliberately out of scope, and for two different reasons
 * rather than one:
 *
 *  * `first_breakdown`, `first_schedule`, `first_focus`, `inbox_zero` — a
 *    completed to-do's deletion cannot un-break-down, un-schedule or un-focus
 *    anything, and it cannot *add* to the needs-triage queue, so none of their
 *    conditions can move in the direction that would un-qualify them.
 *  * `streak_5`, `comeback`, `beat_best_streak` — **not recomputable, and this
 *    is a real gap rather than a judgement that they should stand.** A streak
 *    day is earned by *any* qualifying engagement (`touchStreakOnEngagement`: a
 *    capture, a breakdown-confirm, a step or a task completion), and `Streak`
 *    holds only `current` and `lastActiveWorkday` — no per-day ledger of what
 *    supplied each day. So "would this day still have counted without the
 *    deleted item" has no answer in the schema, and neither reversing nor
 *    keeping can be shown correct. Keeping is the conservative half: it errs
 *    toward a badge the user did earn rather than removing one they did. Closing
 *    it properly needs a per-day engagement record, which is a migration and its
 *    own decision.
 *
 * Returns the keys it revoked, so a caller can be tested on the arithmetic and
 * so "nothing to revoke" is a normal answer rather than an error — the same
 * contract {@link reverseItemCompletionRewards} keeps.
 *
 * `db` is a parameter for the reason that function's note gives at length: the
 * revocation runs inside the delete's own transaction, so a failure rolls the
 * delete back with it rather than leaving a to-do gone and its badge standing.
 */
export async function revokeUnqualifiedBadges(
  workspaceId: string,
  reversed: { stepDone: number; taskComplete: boolean },
  db: Prisma.TransactionClient = prisma,
): Promise<BadgeKeyT[]> {
  const revoked: BadgeKeyT[] = [];

  /** Drop one badge if it is held. `deleteMany` rather than `delete` for the
   *  reason {@link reverseLatestReward} gives: a concurrent revocation of the
   *  same badge must resolve to `count: 0`, not to a P2025 that rolls the
   *  caller's transaction back over work somebody else had already done. */
  const revoke = async (key: BadgeKeyT) => {
    const { count } = await db.badge.deleteMany({
      where: { workspaceId, key },
    });
    if (count > 0) revoked.push(key);
  };

  // Every read below happens AFTER the delete and the points reversal, never off
  // a snapshot taken before them: the question is what the workspace looks like
  // now that this call's writes have landed.
  if (reversed.taskComplete) {
    const completedLeft = await db.brainDumpItem.count({
      where: { workspaceId, completedAt: { not: null } },
    });
    if (completedLeft === 0) await revoke(BadgeKey.TaskComplete);
  }

  const tenStepsDay = reversed.stepDone
    ? await db.badge.findUnique({
        where: { workspaceId_key: { workspaceId, key: BadgeKey.TenStepsDay } },
        select: { earnedAt: true },
      })
    : null;
  if (tenStepsDay && tenStepsDay.earnedAt >= startOfToday()) {
    const stepsToday = await db.rewardEvent.count({
      where: {
        workspaceId,
        type: RewardType.StepDone,
        createdAt: { gte: startOfToday() },
      },
    });
    // The same threshold `maybeAwardTenStepsDay` awards on, read the other way
    // round. Written as `< 10` against that function rather than as its own
    // constant so the two cannot drift apart silently.
    if (stepsToday < 10) await revoke(BadgeKey.TenStepsDay);
  }

  return revoked;
}

/**
 * Remove the newest reward of one type in one workspace. See above for why
 * "newest", and for why the client is a parameter.
 *
 * `deleteMany` on a single id, rather than `delete` — the read and the write are
 * a TOCTOU, the same shape `awardBadge` above has and for the same reason: two
 * concurrent reversals can both see the same newest row, and the loser's
 * `delete` then raises P2025 because the row is already gone (review round 4).
 * `deleteMany` compiles to a plain `DELETE … WHERE id = …` and reports how many
 * rows it matched instead of raising, so a lost race resolves to `count: 0` and
 * is reported as `false` — which is already this function's word for "there was
 * nothing to take back". Fixing it here rather than by catching P2025 at the
 * call site keeps the primitive honest for every caller.
 *
 * A genuine failure (a dead connection, say) still rejects, and must: at the
 * call site it is what rolls the step write back.
 *
 * `notAfter` narrows "newest" to "newest that is not newer than this instant" —
 * see {@link reverseItemCompletionRewards} for what it is for and why only one of
 * the two types passes it. Two queries rather than one `OR`, deliberately: the
 * bounded set must be exhausted BEFORE the unbounded one is considered, and a
 * single ordered query cannot express that preference. Both are served by the
 * `(workspaceId)` and `(createdAt)` indexes on `RewardEvent`, and the second only
 * runs when the first came back empty.
 *
 * The two reads are written out rather than sharing a `where`-taking helper, and
 * that is the scoping harness's rule rather than a style choice: it requires the
 * scope to appear in the call's OWN arguments, so a helper hides exactly the term
 * that matters. Caught by `scoping.harness.test.ts` when this was first written
 * the tidier way.
 */
async function reverseLatestReward(
  workspaceId: string,
  type: RewardTypeT,
  db: Prisma.TransactionClient,
  notAfter?: Date,
): Promise<boolean> {
  const latest =
    (notAfter
      ? await db.rewardEvent.findFirst({
          where: { workspaceId, type, createdAt: { lte: notAfter } },
          orderBy: { createdAt: "desc" },
          select: { id: true },
        })
      : null) ??
    (await db.rewardEvent.findFirst({
      where: { workspaceId, type },
      orderBy: { createdAt: "desc" },
      select: { id: true },
    }));
  if (!latest) return false;
  // `workspaceId` in the filter as well as the id, not because the id is in doubt
  // — it came from the workspace-scoped read directly above — but because
  // `deleteMany` is a BULK operation, and the scoping harness
  // (src/lib/__tests__/scoping.harness.test.ts) requires every bulk write to
  // carry the scope in its own arguments rather than inherit it from a read a few
  // lines up. It is right to: the previous by-id `delete` was accepted only as a
  // primary-key write guarded by that read, and swapping in a bulk op quietly
  // changed which rule applied. Belt and braces either way — a foreign id now
  // resolves to `count: 0` instead of reaching another workspace's row.
  const { count } = await db.rewardEvent.deleteMany({
    where: { id: latest.id, workspaceId },
  });
  return count > 0; // 0 = a concurrent reversal already took this row
}

// ── streak ───────────────────────────────────────────────────────────────
export type StreakUpdate = {
  current: number;
  freshStart: boolean; // restarted after a reset
  continued: boolean; // extended an existing streak
};

/**
 * Record a qualifying engagement toward the working-day streak. Any qualifying
 * action counts (Decision 1): a capture, a breakdown-confirm, or a step/task
 * completion. Consecutive *working days* with ≥1 engagement; non-working days
 * are skipped (don't break it). Missing a working day resets to 1 and files the
 * ended streak into the Top-3 records. Advances at most once per working day —
 * the leading `SELECT … FOR UPDATE` serialises same-day callers.
 *
 * ## ⚠️ A DELIBERATE EXCEPTION to the one-call-per-consequence rule
 *
 * The second of the two, alongside `rewardStepDone` above; the rule and its callee
 * test are on `bestEffort` (`src/lib/best-effort.ts`). This function is **five**
 * consequences, not one: the `StreakRecord` insert and the `Streak` update inside
 * its transaction, then up to three streak badges (Comeback, Streak5,
 * BeatBestStreak).
 *
 * The local fact that earns the exception: the `streakRecord.aggregate` below reads
 * the `StreakRecord` row this function's own transaction may have just written on a
 * reset, so the BeatBestStreak comparison cannot be separated from the write it
 * measures without reading a stale best.
 *
 * **The residual, stated rather than implied.** Comeback and Streak5 are ordinary
 * independent inserts, so if Comeback rejects, Streak5 and BeatBestStreak do not
 * run. That is the same bounded residual `rewardStepDone` carries and it has the
 * same answer: removing it would mean per-payout swallows inside a reward
 * primitive, which `best-effort.ts` rejects by design — the swallow belongs to the
 * caller that committed the write. `awardBadge` is idempotent, so any later
 * qualifying engagement re-attempts every badge missed here.
 *
 * Reached under `breakdown_streak_touch_failed` directly, and transitively via
 * `rewardStepDone` under two more tags.
 */
export async function touchStreakOnEngagement(
  workspaceId: string,
): Promise<StreakUpdate | null> {
  const settings = await getSettings(workspaceId);
  const workingDays = parseWorkingDays(settings.workingDays);
  const now = new Date();
  if (!workingDays.includes(isoWeekday(now))) return null; // non-working day: skip

  const today = ymd(now);

  // Most recent working day strictly before today (pure — no DB access).
  const prev = new Date(now);
  let prevWorkingDay: string | null = null;
  for (let i = 0; i < 14; i++) {
    prev.setDate(prev.getDate() - 1);
    if (workingDays.includes(isoWeekday(prev))) {
      prevWorkingDay = ymd(prev);
      break;
    }
  }

  // Ensure the Streak row exists (race-safe) before we lock it in the txn.
  await getStreak(workspaceId);

  // Read-decide-write in one interactive transaction. The leading
  // `SELECT … FOR UPDATE` serialises concurrent first-completions-of-the-day
  // for this workspace: a second caller blocks until the first commits, then
  // re-reads `lastActiveWorkday === today` and early-returns. So the streak
  // advances at most once and at most one StreakRecord is filed on a reset,
  // instead of the previous read→compute→write TOCTOU that could double both.
  const result = await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT 1 FROM "Streak" WHERE "workspaceId" = ${workspaceId} FOR UPDATE`;
    const streak = await tx.streak.findUnique({ where: { workspaceId } });
    if (!streak) {
      // Ensured above; treat an unexpectedly-missing row as a safe no-op.
      return {
        current: 0,
        freshStart: false,
        continued: false,
        changed: false,
      };
    }

    if (streak.lastActiveWorkday === today) {
      return {
        current: streak.current,
        freshStart: false,
        continued: false,
        changed: false,
      };
    }

    const continues =
      streak.current > 0 && streak.lastActiveWorkday === prevWorkingDay;

    let current: number;
    let freshStart = false;
    if (continues) {
      current = streak.current + 1;
    } else {
      // reset — file the ended streak (if any) into Top-3 records
      if (streak.current > 0) {
        await tx.streakRecord.create({
          data: {
            length: streak.current,
            startedAt: now,
            endedAt: now,
            workspaceId,
          },
        });
      }
      current = 1;
      freshStart = streak.current > 0; // only "fresh start" if there was a prior streak
    }

    await tx.streak.update({
      where: { workspaceId },
      data: { current, lastActiveWorkday: today },
    });

    return { current, freshStart, continued: continues, changed: true };
  });

  // Streak badges — only when the streak actually moved (matches the prior
  // early-return for same-day repeats). awardBadge tolerates a concurrent
  // award without raising (#158).
  const { changed, ...update } = result;
  if (changed) {
    // Comeback — restarted after a gap (a prior streak had ended). No-shame.
    if (update.freshStart) await awardBadge(workspaceId, BadgeKey.Comeback);
    // Full work week — a 5-working-day streak.
    if (update.current >= 5) await awardBadge(workspaceId, BadgeKey.Streak5);
    const best = await prisma.streakRecord.aggregate({
      _max: { length: true },
      where: { workspaceId },
    });
    if (
      (best._max.length ?? 0) > 0 &&
      update.current > (best._max.length ?? 0)
    ) {
      await awardBadge(workspaceId, BadgeKey.BeatBestStreak);
    }
  }

  return update;
}

/**
 * @deprecated A step/task completion is one kind of qualifying engagement.
 * Retained as a thin alias so the completion call sites and existing tests keep
 * working; prefer {@link touchStreakOnEngagement} for new call sites.
 */
export function touchStreakOnCompletion(
  workspaceId: string,
): Promise<StreakUpdate | null> {
  return touchStreakOnEngagement(workspaceId);
}

// ── dashboard aggregation ──────────────────────────────────────────────────
export type DashboardData = {
  todayPoints: number;
  totalPoints: number;
  currentStreak: number;
  topStreaks: { length: number; endedAt: Date }[];
  focusMinToday: number;
  sessionsToday: number;
  stepsDoneToday: number;
  badges: string[];
};

export async function getDashboardData(
  workspaceId: string,
): Promise<DashboardData> {
  const start = startOfToday();
  const [
    todayAgg,
    totalAgg,
    streak,
    topStreaks,
    todaySessions,
    stepsDoneToday,
    badges,
  ] = await Promise.all([
    prisma.rewardEvent.aggregate({
      _sum: { points: true },
      where: { workspaceId, createdAt: { gte: start } },
    }),
    prisma.rewardEvent.aggregate({
      _sum: { points: true },
      where: { workspaceId },
    }),
    getStreak(workspaceId),
    prisma.streakRecord.findMany({
      where: { workspaceId },
      orderBy: { length: "desc" },
      take: 3,
    }),
    prisma.focusSession.findMany({
      where: { workspaceId, startedAt: { gte: start }, endedAt: { not: null } },
      select: { durationMin: true },
    }),
    prisma.rewardEvent.count({
      where: {
        workspaceId,
        type: RewardType.StepDone,
        createdAt: { gte: start },
      },
    }),
    prisma.badge.findMany({
      where: { workspaceId },
      orderBy: { earnedAt: "asc" },
    }),
  ]);

  return {
    todayPoints: todayAgg._sum.points ?? 0,
    totalPoints: totalAgg._sum.points ?? 0,
    currentStreak: streak.current,
    topStreaks: topStreaks.map((r) => ({
      length: r.length,
      endedAt: r.endedAt,
    })),
    focusMinToday: todaySessions.reduce((n, s) => n + (s.durationMin ?? 0), 0),
    sessionsToday: todaySessions.length,
    stepsDoneToday,
    badges: badges.map((b) => b.key),
  };
}
