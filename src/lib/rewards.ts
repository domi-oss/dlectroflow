import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import {
  RewardType,
  RewardPoints,
  BadgeKey,
  EngagementKind,
  type RewardType as RewardTypeT,
  type BadgeKey as BadgeKeyT,
  type EngagementKind as EngagementKindT,
} from "@/lib/constants";
import { inboxZeroQueueWhere } from "@/lib/inbox-zero-queue";
import { getSettings, getStreak } from "@/lib/db";
// #233 — one derivation of "what day is it", shared with the recompute. These
// four were private to this file; they moved rather than being copied, because
// the ledger's `day` column and `Streak.lastActiveWorkday` are compared as
// strings and two derivations differing by an hour would make a streak silently
// unrecomputable. See that module's docblock.
import {
  isoWeekday,
  parseWorkingDays,
  parseYmd,
  recomputeRun,
  runIsFullyLedgered,
  ymd,
} from "@/lib/engagement-ledger";

// ── helpers ────────────────────────────────────────────────────────────────
function startOfToday(): Date {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
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
 * `itemId` is the `BrainDumpItem` this step's work belongs to, resolved by the
 * caller with {@link itemIdForTask} — it is what the engagement ledger attributes
 * the streak credit to (#233). `null` is legitimate and means "this step's task
 * has no inbox item behind it", which makes the credit permanent; see
 * {@link EngagementKind}.
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
 *
 * #233 adds one statement to that bundle — the engagement ledger row, written
 * inside `touchStreakOnEngagement`'s own transaction. It does not change the
 * exception's argument and it does not widen the residual: the row is written
 * BEFORE the streak decides anything, so the ledger is never left behind the
 * counter, which is the only direction that could later revoke a badge somebody
 * still qualifies for.
 */
export async function rewardStepDone(
  workspaceId: string,
  itemId: string | null = null,
): Promise<StreakUpdate | null> {
  await logReward(workspaceId, RewardType.StepDone);
  // A completion is a qualifying engagement.
  const streak = await touchStreakOnEngagement(workspaceId, {
    kind: EngagementKind.StepDone,
    itemId,
  });
  await maybeAwardTenStepsDay(workspaceId);
  return streak;
}

/**
 * The `BrainDumpItem` a `Task`'s work belongs to, for the engagement ledger to
 * attribute a credit to (#233). `null` when the task has no inbox item behind it.
 *
 * ── Why the callers resolve this rather than the ledger ─────────────────────
 *
 * Three of the four engagement call sites hold a `taskId` and not an item id
 * (`completeStep`, `finishSession`, `confirmBreakdown`), and one holds the item
 * directly (`completeItem`, `writeCapture`). Putting the lookup here rather than
 * inside `touchStreakOnEngagement` keeps the `workspaceId` filter in the CALL's
 * own arguments, which is what `scoping.harness.test.ts` requires and what a
 * `where`-taking helper would hide — the same rule `reverseLatestReward` writes
 * out twice rather than sharing.
 *
 * `findFirst` and not `findMany`: the schema permits several items per task and no
 * code path creates a second one (the note at `deleteBrainDumpItem`'s Task cleanup
 * says so and re-proves it). If one ever exists, attributing the credit to the
 * oldest is the same choice the delete makes, and the worst case is a credit that
 * outlives one of two items — conservative, because an over-attached credit
 * prevents a revocation and never causes one.
 */
export async function itemIdForTask(
  workspaceId: string,
  taskId: string,
): Promise<string | null> {
  const item = await prisma.brainDumpItem.findFirst({
    where: { taskId, workspaceId },
    orderBy: { createdAt: "asc" },
    select: { id: true },
  });
  return item?.id ?? null;
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
 *  * `streak_5`, `comeback`, `beat_best_streak` — **moved out of this function
 *    entirely by #233, not left unhandled.** They are now
 *    {@link revokeUnqualifiedStreakBadges}'s, and they are separate because they
 *    are gated on a different fact: this function's two badges are decided by
 *    what the REVERSAL took back, and the streak's three by which ledger days the
 *    delete EMPTIED. Those are different questions with different answers — a
 *    delete can reverse a payout without emptying any day (the item's other
 *    engagements, or another item, still credit it) and can empty a day without
 *    reversing anything.
 *
 *    What that section used to say is worth keeping on the record, because it is
 *    the reason the other function exists: *"a streak day is earned by any
 *    qualifying engagement and `Streak` holds only `current` and
 *    `lastActiveWorkday` — no per-day ledger of what supplied each day, so
 *    'would this day still have counted without the deleted item' has no answer
 *    in the schema."* `EngagementDay` is that ledger. Two of the three are now
 *    recomputable; `comeback` is still kept, and the note there says why that is
 *    now a decision about what the badge MEANS rather than a limit of the schema.
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

/**
 * Record one qualifying engagement in the per-day ledger (#233).
 *
 * A plain `create`, and deliberately not an upsert or a `skipDuplicates`: two step
 * completions of one item on one day are two rows, which is harmless because every
 * reader asks "does this day hold at least one row". `logReward` next door has the
 * same property for the same reason, and a unique key over a NULLable `itemId`
 * would not dedupe the backfill's rows anyway (Postgres treats NULLs as distinct).
 *
 * `itemId` names the `BrainDumpItem` whose continued existence is the EVIDENCE for
 * the credit, and the row cascades with it. `null` means the evidence is not an
 * item, which makes the credit permanent — see {@link EngagementKind} and the
 * model's docblock for why that is the conservative direction.
 */
async function recordEngagement(
  workspaceId: string,
  day: string,
  engagement: { kind: EngagementKindT; itemId?: string | null },
  db: Prisma.TransactionClient = prisma,
): Promise<void> {
  await db.engagementDay.create({
    data: {
      workspaceId,
      day,
      kind: engagement.kind,
      itemId: engagement.itemId ?? null,
    },
  });
}

/**
 * The ledger days one `BrainDumpItem` is the evidence for, read BEFORE it is
 * deleted (#233).
 *
 * Read first because the rows cascade with the item, so after the delete there is
 * nothing left to ask. Pair it with {@link engagementDaysNowEmpty} after the
 * delete: the difference between the two is the set of days that lost their last
 * credit, which is the only input streak-badge revocation needs.
 */
export async function engagementDaysOfItem(
  workspaceId: string,
  itemId: string,
  db: Prisma.TransactionClient = prisma,
): Promise<string[]> {
  const rows = await db.engagementDay.findMany({
    where: { itemId, workspaceId },
    select: { day: true },
    distinct: ["day"],
  });
  return rows.map((r) => r.day);
}

/**
 * Which of `days` now hold NO engagement credit at all — i.e. which days stopped
 * counting toward the streak (#233).
 *
 * One query rather than one per day, and `distinct` rather than a `groupBy`
 * count: the question is membership, not arithmetic.
 */
export async function engagementDaysNowEmpty(
  workspaceId: string,
  days: readonly string[],
  db: Prisma.TransactionClient = prisma,
): Promise<string[]> {
  if (days.length === 0) return [];
  const surviving = await db.engagementDay.findMany({
    where: { workspaceId, day: { in: [...days] } },
    select: { day: true },
    distinct: ["day"],
  });
  const kept = new Set(surviving.map((r) => r.day));
  return days.filter((d) => !kept.has(d));
}

/**
 * Recompute the streak from the ledger and revoke the streak badges whose
 * condition no longer holds — the residual `#251` recorded and could not close
 * (#233).
 *
 * Called only by `deleteBrainDumpItem`, and only with the days its delete actually
 * emptied. A delete is the one action that destroys the evidence a streak day
 * rested on; an UNDO is not, and `reverseStepCompletionRewards`' rule note says
 * why at length — the engagement genuinely happened and does not un-happen, which
 * is the same argument that keeps `session_finished`.
 *
 * ── It refuses to act far more often than it acts, and that is correct ──────
 *
 * Every gate below is a reason to KEEP a badge, because the failure modes are not
 * symmetric: keeping a badge whose work is gone is a cosmetic overstatement, and
 * removing one the person earned is taking away something real. `#251` chose the
 * conservative half deliberately and this function does not reverse that choice —
 * it narrows the set of cases where the conservative answer is the only available
 * one.
 *
 *  1. **No day was emptied** — the delete removed credits from days that still
 *     hold others, so the streak did not move and nothing can be un-qualified.
 *  2. **The recomputed run is not fully ledgered** — see
 *     {@link runIsFullyLedgered}. Rows before `Streak.ledgerFrom` are best-effort
 *     archaeology from surviving `RewardEvent` and `BrainDumpItem` rows, and a
 *     reward row that was later reversed leaves no trace of the engagement it
 *     recorded. So a run beginning before that instant may be shorter than the
 *     real one, and acting on it would revoke on evidence nobody collected. **On
 *     a database that has just run the backfill this is the answer for every
 *     workspace**, and stays the answer until a run begins after the migration —
 *     which is the honest state of affairs, not a defect.
 *  3. **The run was truncated** — `current` is a floor rather than the answer.
 *  4. **The badge predates the run** — `earnedAt` before the run's first day means
 *     an EARLIER run earned it. That run's length is filed in `StreakRecord`,
 *     which this cannot recompute (see the `comeback` note below), so it stands.
 *     This is the same `earnedAt` gate `revokeUnqualifiedBadges` already uses for
 *     `ten_steps_day`, and for the same reason: it is what makes the answer a
 *     reversal rather than a guess.
 *
 * ── ⚠️ The one KNOWN limit that errs the OTHER way (raised in review on !352) ─
 *
 * The recompute walks history with the workspace's **current**
 * `Settings.workingDays`, because that is the only working week the schema stores.
 * A person who has since CHANGED their working week is therefore re-measured
 * against a calendar that was not in force when the run was built — and if the
 * change ADDED a working day, a past instance of that day now reads as a gap the
 * ledger cannot fill, so the run comes back shorter than it really was and a badge
 * that WAS earned can be revoked. Removing a working day is harmless in the other
 * direction (fewer days must carry a credit).
 *
 * Reachable by ordinary use: change the working week in Settings, then delete a
 * completed to-do. Stated here rather than silently accepted, because unlike every
 * gate above this one errs toward taking something real away.
 *
 * **Not fixed here, and the cheap fix was measured and rejected.** Refusing
 * whenever `Settings.updatedAt` falls inside the run would be sound and one
 * condition long, but `@updatedAt` fires on ANY settings write, so for anyone who
 * adjusts a preference mid-run it disables revocation entirely — it gates the
 * feature off rather than guarding it. The precise fix is to record the working
 * week that a run was actually measured with, which is a column, a migration and a
 * write on the engagement path: a different change from this one, and a product
 * decision about how much revocation reach to trade, so it is reported for an
 * explicit call rather than taken in a review round.
 *
 * ── `Streak.current` is lowered, never raised ───────────────────────────────
 *
 * A delete may take a streak day away and must never grant one. If the recompute
 * comes back HIGHER than the stored counter, that is a pre-existing disagreement
 * (a ledger row written where the counter's own transaction then failed, say) and
 * repairing it is not a delete's business — so the update is gated on
 * `run.current < streak.current`.
 *
 * ── The three badges, and why one of them still cannot move ─────────────────
 *
 *  * **`streak_5`** — qualifies while some run reached five working days. The
 *     current run's length is now recomputable, so a delete that drops it under
 *     five revokes. A `streak_5` earned by an earlier run is kept under gate 4.
 *  * **`beat_best_streak`** — awarded when the current run exceeded the best
 *     `StreakRecord`. Both sides of that comparison survive a delete: the records
 *     are untouched, and the run is recomputed. So the condition is directly
 *     recheckable.
 *  * **`comeback`** — **kept, and now for a stated reason rather than for want of
 *     a ledger.** It records that a streak ENDED and another began, and a
 *     `StreakRecord` row is the trace of that event. A delete cannot remove one,
 *     so the badge's evidence survives every delete by construction. Revoking it
 *     would mean proving no reset ever happened, which needs the whole streak
 *     history re-derived — and `StreakRecord` writes `startedAt` and `endedAt`
 *     both as `now()` at reset time, so its rows cannot be placed on a calendar at
 *     all. That is what a future change would have to fix; it is not something
 *     this ledger can supply on its own.
 */
export async function revokeUnqualifiedStreakBadges(
  workspaceId: string,
  daysLost: readonly string[],
  db: Prisma.TransactionClient = prisma,
): Promise<BadgeKeyT[]> {
  if (daysLost.length === 0) return []; // gate 1

  // The same row lock `touchStreakOnEngagement` takes, for the same reason: this
  // reads the counter, decides, and writes it. Taken AFTER the ledger rows are
  // already gone (the cascade ran with the item delete), so the lock order is
  // EngagementDay-then-Streak — identical to the engagement path's, which is what
  // stops the two deadlocking against each other.
  //
  // ⚠️ This lock is only worth anything when `db` is a TRANSACTION client: outside
  // one, Postgres releases a `FOR UPDATE` at the end of the statement that took it,
  // so the read-decide-write below would be an unguarded TOCTOU again. The `db`
  // default exists for the same reason `reverseItemCompletionRewards`' does — to
  // keep the unit tests unchanged — and the one production caller,
  // `deleteBrainDumpItem`, passes its own `tx`. It has to, for a second reason
  // stated at that call site: a revocation that committed independently would
  // survive a rollback that put the to-do back.
  await db.$queryRaw`SELECT 1 FROM "Streak" WHERE "workspaceId" = ${workspaceId} FOR UPDATE`;

  const streak = await db.streak.findUnique({
    where: { workspaceId },
    select: { current: true, ledgerFrom: true },
  });
  if (!streak) return []; // no streak row: nothing was ever credited

  const settings = await db.settings.findUnique({
    where: { workspaceId },
    select: { workingDays: true },
  });
  // Falling back to the schema default rather than returning: a workspace can
  // legitimately have no Settings row yet, and the default IS its working week.
  const workingDays = parseWorkingDays(settings?.workingDays ?? "1,2,3,4,5");

  const dayRows = await db.engagementDay.findMany({
    where: { workspaceId },
    select: { day: true },
    distinct: ["day"],
  });
  const run = recomputeRun(
    new Set(dayRows.map((r) => r.day)),
    workingDays,
    ymd(new Date()),
  );

  // gates 2 and 3. `runStart === null` is tested here as well as inside
  // `runIsFullyLedgered`, which is redundant at runtime and deliberate at the type
  // level: it is what narrows `run.runStart` to `string` for `parseYmd` below.
  // Raised in review on !352 — the previous form was `parseYmd(run.runStart as
  // string)`, and that cast was only true because of the ORDER of the conditions
  // in this `if`. Reordering them, or `runIsFullyLedgered` ever accepting a null
  // run, would have turned it into a lie that the compiler had been told to stop
  // checking.
  if (
    run.truncated ||
    run.runStart === null ||
    !runIsFullyLedgered(run.runStart, streak.ledgerFrom)
  ) {
    return [];
  }
  const runStartsAt = parseYmd(run.runStart);

  if (run.current < streak.current) {
    await db.streak.update({
      where: { workspaceId },
      data: {
        current: run.current,
        lastActiveWorkday: run.lastActiveWorkday,
      },
    });
  }

  const revoked: BadgeKeyT[] = [];
  /** Drop one badge if it is held AND this run is what earned it (gate 4).
   *  `deleteMany` for the reason {@link reverseLatestReward} gives: a concurrent
   *  revocation must resolve to `count: 0`, not to a P2025 that rolls the
   *  caller's transaction back over work somebody else already did. */
  const revokeIfEarnedByThisRun = async (key: BadgeKeyT) => {
    const badge = await db.badge.findUnique({
      where: { workspaceId_key: { workspaceId, key } },
      select: { earnedAt: true },
    });
    if (!badge || badge.earnedAt < runStartsAt) return;
    const { count } = await db.badge.deleteMany({
      where: { workspaceId, key },
    });
    if (count > 0) revoked.push(key);
  };

  // The same threshold `touchStreakOnEngagement` awards on (`current >= 5`), read
  // the other way round and written against it rather than as its own constant so
  // the two cannot drift apart silently — the convention
  // `revokeUnqualifiedBadges` already keeps for `ten_steps_day`.
  if (run.current < 5) await revokeIfEarnedByThisRun(BadgeKey.Streak5);

  // `beat_best_streak`'s award condition is `best > 0 && current > best`. Both
  // halves are re-read: with no records at all the badge cannot have been earned
  // by that comparison, so there is nothing to recheck and it is left alone.
  const best = await db.streakRecord.aggregate({
    _max: { length: true },
    where: { workspaceId },
  });
  const bestLength = best._max.length ?? 0;
  if (bestLength > 0 && run.current <= bestLength) {
    await revokeIfEarnedByThisRun(BadgeKey.BeatBestStreak);
  }

  // `comeback` is deliberately absent — see the docblock. Its evidence is a
  // `StreakRecord` row, which no delete can remove.

  return revoked;
}

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
  engagement?: { kind: EngagementKindT; itemId?: string | null },
): Promise<StreakUpdate | null> {
  const settings = await getSettings(workspaceId);
  const workingDays = parseWorkingDays(settings.workingDays);
  const now = new Date();
  const today = ymd(now);

  // Ensure the Streak row exists (race-safe) before we lock it in the txn. Also
  // before the ledger write below, because a Streak row created LATER would be
  // stamped with a `ledgerFrom` after a credit the ledger already holds — which
  // would make that credit's day read as covered when it is not.
  await getStreak(workspaceId);

  if (!workingDays.includes(isoWeekday(now))) {
    // #233 — a non-working day still gets its ledger row. The ledger is a log of
    // what happened, not a view of what counted; `recomputeRun` is what applies
    // the working-day rule, and it ignores this row exactly as the streak does.
    // Recording it keeps the ledger honest if the working week is ever changed.
    if (engagement) await recordEngagement(workspaceId, today, engagement);
    return null; // non-working day: skip
  }

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

  // Read-decide-write in one interactive transaction. The leading
  // `SELECT … FOR UPDATE` serialises concurrent first-completions-of-the-day
  // for this workspace: a second caller blocks until the first commits, then
  // re-reads `lastActiveWorkday === today` and early-returns. So the streak
  // advances at most once and at most one StreakRecord is filed on a reset,
  // instead of the previous read→compute→write TOCTOU that could double both.
  const result = await prisma.$transaction(async (tx) => {
    // #233 — the ledger row goes FIRST, and inside this transaction, and both
    // halves of that are load-bearing.
    //
    // **Inside**, so the row and the counter cannot disagree: either both land or
    // neither does. **First**, so that if they ever DO disagree the error is in
    // the safe direction. A ledger AHEAD of the counter recomputes to a longer
    // run, and `revokeUnqualifiedStreakBadges` never raises `current`, so nothing
    // happens. A ledger BEHIND the counter recomputes to a SHORTER run, and that
    // is the input that revokes a badge somebody still qualifies for.
    //
    // It is not the contended row, so it does not disturb the serialisation the
    // `FOR UPDATE` below provides: two same-day callers both insert (new rows
    // conflict with nothing) and then one blocks on the Streak lock, exactly as
    // before. Lock ORDER is EngagementDay-then-Streak here, which is the same
    // order `deleteBrainDumpItem` takes when its cascade removes rows and it then
    // recomputes — inverting it in one writer is how a deadlock gets built.
    if (engagement) await recordEngagement(workspaceId, today, engagement, tx);

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
 * Prefer {@link touchStreakOnEngagement}.
 *
 * ⚠️ **Calling this writes NO `EngagementDay` row**, and that is the whole reason
 * not to use it rather than a style preference (raised in review on `!352`). It
 * forwards no engagement argument, so the credit it produces is invisible to the
 * ledger: the day cannot be recomputed, and `revokeUnqualifiedStreakBadges` can
 * never withdraw it. A streak day credited through here is permanent — which is
 * precisely the defect #233 exists to remove, reintroduced one call at a time.
 *
 * **No production caller remains.** Every engagement site passes an explicit
 * `kind` — `completeItem` and `createBrainDumpItem` via `writeCapture`,
 * `confirmBreakdown`, `completeStep` and `completeFocus` via `rewardStepDone`.
 * This survives only for `rewards.integration.test.ts`, the restored
 * `SELECT … FOR UPDATE` proof, which calls it to exercise the lock rather than the
 * ledger. The previous wording said it was "retained so the completion call sites
 * keep working"; those call sites are gone, and a comment naming callers that no
 * longer exist is what makes an alias look safe to reach for.
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
