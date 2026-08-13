/**
 * #257 — the ONE post-commit swallow.
 *
 * ## The rule this exists to make structural
 *
 * Reached on `!330`'s review and quoted by the issue:
 *
 * > the `try` governs the WRITE; anything after it is a consequence of success
 * > and cannot un-write the row.
 *
 * A server action that writes a row and then does its bookkeeping has two
 * statements with nothing atomic between them. When the second one throws, the
 * exception propagates out of the action and the person is told their work did
 * not save — over work that is in the database. What they do next is press the
 * button again, which is at best a wasted press and at worst a duplicate row.
 *
 * ## Why a shared function and not a `try` at each site
 *
 * This repo had reached the same conclusion three times independently and
 * written it out three times: `awardFirstSchedule`
 * (`src/lib/scheduling/award.ts`, "scheduling has already committed and must not
 * be retried"), `settleShopping` (`src/app/actions/shopping.ts`, "a duplicated
 * item is not recoverable"), and `writeCapture` (`src/lib/capture-write.ts`,
 * `!334`). Two of the three carry a private copy of the same fifteen-line
 * structured-log helper.
 *
 * #257 found five more sites and asked for one wrapper rather than five more
 * copies, and the reason is the one that shows up in this codebase repeatedly: a
 * swallow copied N times grows a subtly different rule in one of the copies, and
 * the copy that drifted is invisible because each one reads fine on its own.
 * Here the rule that must not drift is "the tag is emitted, the value is not
 * invented, and nothing else is caught".
 *
 * The two older private copies are deliberately left alone — `shopping.ts` is
 * outside #257's scope and `capture-write.ts` is `!334`'s open diff. They are the
 * natural next adopters; the tag union below is where their literals would go.
 *
 * ## What this is NOT for
 *
 * Not a general error suppressor. It is for a statement that runs **after** a
 * committed write, whose failure the caller can do nothing about and whose
 * absence costs the person nothing they cannot earn again. A write, a read whose
 * value is returned, or anything a caller must branch on for correctness keeps
 * rejecting — see the CONTROL half of every block in
 * `src/app/actions/post-commit-bookkeeping.test.ts`, which is what stops this
 * primitive being used to make a suite green.
 *
 * In particular it is **not** the answer to "the write and its consequence should
 * be atomic". `touchStreakOnEngagement` opens its own interactive
 * `prisma.$transaction` on the module-level client and takes no
 * `Prisma.TransactionClient`, so nesting it in an outer transaction buys no
 * atomicity at all — the inner one runs on a second pooled connection and commits
 * independently — while holding an uncommitted write open across a
 * `SELECT … FOR UPDATE`, a settings read and up to three badge writes. That is a
 * connection-pool deadlock waiting for a second caller. `capture-write.ts`
 * records the full argument, and #257 records that a retry cannot recover the
 * credit either: the touch is per-day idempotent but not idempotent across days,
 * so a replay landing on a later working day would advance the streak — and mint
 * `Streak5` / `BeatBestStreak` — for a day whose only engagement was reopening
 * the app.
 */

/**
 * Every tag a swallow in this repo can emit, as a closed union.
 *
 * A closed union rather than `string` for the reason `logShoppingBookkeepingFailure`
 * types its own two: the tag is the entire value of the log line, and a typo in a
 * string literal produces a line nobody will ever grep for while the code still
 * compiles and the test still passes. Listing them here also makes "what can this
 * app swallow" one file to read rather than a repo-wide search.
 *
 * Named `<site>_..._failed`, matching `capture_streak_touch_failed`.
 */
export type BookkeepingTag =
  /** `confirmBreakdown` — the points, the FirstBreakdown badge, the streak. */
  | "breakdown_confirm_bookkeeping_failed"
  /** `completeStep` — `rewardStepDone` (points, streak, ten-steps badge). */
  | "step_done_bookkeeping_failed"
  /** `markTaskCompleted` — the task-complete points and badge. */
  | "task_complete_bookkeeping_failed"
  /**
   * `completeFocus` — the step payout (points, streak, ten-steps badge).
   *
   * Two tags rather than one for this site, because its two payouts are two
   * `bestEffort` calls rather than one wrapped block: they were split so that a
   * failure in either is independent of the other, and a shared tag would make
   * that independence invisible to the only reader that matters. An alert
   * filtered on one tag must be able to say WHICH payout was lost without
   * parsing `message` — see the call site, and the rule at the head of this
   * union.
   */
  | "focus_step_reward_failed"
  /** `completeFocus` — the session-finished bonus, independent of the above. */
  | "focus_session_bonus_failed"
  /** `beginFocus` — the once-ever FirstFocus badge. */
  | "first_focus_badge_failed";

/**
 * One structured, greppable line for a consequence that failed after its write
 * committed.
 *
 * Same shape and same fields as `recordLLMFailure` and `recordAuthFailure` in
 * `src/lib/observability.ts`, and as the two private copies this replaces: a
 * machine-readable `tag`, the workspace, the message and a timestamp. Kept here
 * rather than in `observability.ts` because the line and the swallow are one
 * decision — a caller cannot adopt half of it — and because that module's
 * counter is read by `/api/livez`, where a bookkeeping blip is not a health
 * signal.
 *
 * `error` level, not `warn`: unlike the *handled* outcomes #158 is about, this is
 * an unhandled fault in a second statement, and the only reason it is not a 500
 * is that the person's work is already safe.
 *
 * Exported so a call site with no value to return, and no thunk to wrap, can
 * still emit the line; `bestEffort` is the form every current site uses.
 */
export function recordBookkeepingFailure(
  tag: BookkeepingTag,
  workspaceId: string,
  error: unknown,
): void {
  try {
    const e = error as { message?: unknown } | undefined;
    console.error(
      JSON.stringify({
        tag,
        workspaceId,
        message: typeof e?.message === "string" ? e.message : String(error),
        ts: new Date().toISOString(),
      }),
    );
  } catch {
    // Observability must never take the request down with it — the guard
    // `recordLLMFailure` and `recordAuthFailure` carry, and it matters more here
    // than anywhere else in the repo: this function is only ever reached from a
    // catch block that exists precisely to keep a committed write from being
    // reported as failed. A logger that threw would undo the whole fix.
    //
    // Both halves are reachable: reading `.message` can throw on a hostile
    // getter, and `JSON.stringify` throws on a circular value — so the `try`
    // opens before the property read rather than around the `console.error`.
  }
}

/**
 * Run one consequence of a committed write. A rejection is logged under `tag`
 * and resolved to `null`; anything the work returns comes back untouched.
 *
 * `T | null` rather than `void`, so a caller that had a value to show can go on
 * showing it: `completeFocus` reports `streak` to the UI, and `null` is already
 * that field's word for "no streak update", so the failure needs no new vocabulary
 * at the call site. A caller with nothing to return ignores the result.
 *
 * `work` is a thunk rather than a promise so that a synchronous throw while
 * building the call — `() => logReward(ws, TYPES[k])` on a bad `k`, say — is
 * caught by the same `try`. Passing an already-created promise would let that one
 * escape, which is the failure mode a wrapper like this is supposed to remove.
 *
 * Sequential by construction, and that is why there is no `allSettled` variant:
 * `awardFirstSchedule` can run its two payouts concurrently because they are
 * independent, while `rewardStepDone`'s are not — `maybeAwardTenStepsDay` counts
 * the `RewardEvent` row `logReward` has just written. A caller that wants two
 * payouts to be independent of each other calls this twice, which is what
 * `completeFocus` does.
 */
export async function bestEffort<T>(
  tag: BookkeepingTag,
  workspaceId: string,
  work: () => Promise<T>,
): Promise<T | null> {
  try {
    return await work();
  } catch (error) {
    recordBookkeepingFailure(tag, workspaceId, error);
    return null;
  }
}
