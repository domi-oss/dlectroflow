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
 *
 * **One member per consequence a site can lose**, with the ⚠️-marked exceptions
 * below. The rule that produces that shape lives on {@link bestEffort} — not
 * repeated here, because a rule written in two places drifts in one of them. Each
 * member below carries only what is local to it: which site, which consequence.
 */
export type BookkeepingTag =
  /** `confirmBreakdown` — the BreakdownConfirmed points. */
  | "breakdown_points_failed"
  /** `confirmBreakdown` — the once-ever FirstBreakdown badge. */
  | "breakdown_badge_failed"
  /**
   * `confirmBreakdown` — the qualifying-engagement streak touch.
   *
   * ⚠️ **Deliberately bundled.** Wraps `touchStreakOnEngagement`, which is itself
   * five consequences: the `StreakRecord` insert and `Streak` update inside its
   * transaction, then up to three streak badges. Legitimate under the callee test
   * on {@link bestEffort} — `streakRecord.aggregate` reads the `StreakRecord` row
   * that same transaction may have just written, so the BeatBestStreak decision
   * cannot be separated from the write it measures.
   */
  | "breakdown_streak_touch_failed"
  /**
   * `completeStep` — `rewardStepDone`: points, streak and ten-steps badge under
   * ONE tag.
   *
   * ⚠️ **Deliberately bundled** — one of three such members, flagged at each rather
   * than only behind the pointer, because a reader who meets several consequences
   * on one tag needs to know it is a decision without going to look. The dependency
   * that forces it, and the residual it leaves, are in `rewardStepDone`'s docblock
   * (`src/lib/rewards.ts`).
   */
  | "step_done_bookkeeping_failed"
  /** `markTaskCompleted` — the TaskComplete points. */
  | "task_complete_points_failed"
  /** `markTaskCompleted` — the once-ever TaskComplete badge. */
  | "task_complete_badge_failed"
  /**
   * `completeFocus` — the step payout (points, streak, ten-steps badge).
   *
   * ⚠️ **Deliberately bundled, and the same bundle as
   * `step_done_bookkeeping_failed`** — both wrap `rewardStepDone`, so the one
   * exception reaches the union under two tags. Missing this was the fourth
   * recurrence of the bundling class on `!339` (Duo review): a sweep counting
   * consequences *at the call site* sees one call here and calls it clean, because
   * the bundling lives one level down in the callee. Same dependency and same
   * residual as that member; `rewardStepDone`'s docblock is the one place both are
   * written.
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
 *
 * ## A BUG and a BLIP get different tags (`!339`)
 *
 * A `TypeError` from a mistyped property at a call site is not an operational
 * failure, and until `!339` it produced a line indistinguishable from a database
 * blip — swallowed, `null` returned, nothing to alert on. It now emits
 * {@link DEFECT_TAG} with the site in a `site` field, so one filter catches every
 * programmer fault across every site while operational lines keep their per-site
 * tag untouched.
 *
 * **Why a tag and not a re-throw, which was the other option considered:** a
 * re-throw would reintroduce #257, the thing this module exists to prevent. The
 * payout runs *after* its write committed, so an exception escaping here
 * propagates out of the server action and tells the person their work failed over
 * a row that is in the database. The cause being a bug rather than a blip changes
 * nothing about the row. It would turn "payout silently unpaid" into "payout
 * unpaid AND the write falsely reported failed" — strictly worse. The tag keeps
 * the fault loud without lying to the person about their data.
 *
 * ## TWO TIERS, SAME TAG EITHER WAY
 *
 * The structured JSON line is tier one. If building it throws, tier two emits the
 * tag and the workspace as plain arguments — **no JSON, no interpolation, and no
 * further reads of the error value**, because touching that value is what just
 * failed. The contract a reader can rely on: **the tag reaches the log on both
 * paths**, so one grep finds either line. Before `!339` tier two did not exist and
 * the `catch` was empty, which meant the one case this logger is reached for
 * produced no line at all — the failure mode `!334` found in
 * `logCaptureBookkeepingFailure` and confirmed here.
 *
 * The innermost `catch` *is* empty, and that is a conclusion rather than an
 * omission: `console.error` itself is unusable, so there is nothing left to try,
 * and throwing out of a block that exists to stop #257 would be the worse harm.
 *
 * ## What the guarded block is actually guarding against
 *
 * Three reachable faults, and this list was **wrong** before `!339`: reading
 * `.message` can throw on a hostile getter; `String(error)` can throw on a hostile
 * `toString`; and `String(error)` also throws `TypeError: Cannot convert object to
 * primitive value` on a **null-prototype** rejection, which has no inherited
 * `toString` at all — the most realistic of the three.
 *
 * It previously claimed `JSON.stringify` on a **circular value** as the second, and
 * that cannot happen here: every field serialised is a string by construction
 * (`tag` and `workspaceId` are typed `string`, `ts` comes from `toISOString()`, and
 * `message` is a `typeof`-checked string or `String(error)`), so a cycle in `error`
 * never reaches the serialiser — it takes the structured path and logs normally. A
 * test written from that claim goes green against an empty `catch` and proves
 * nothing, which is worth recording because it nearly happened here. The `try`
 * still opens before the property read, which is what all three real faults need.
 */
export function recordBookkeepingFailure(
  tag: BookkeepingTag,
  workspaceId: string,
  error: unknown,
): void {
  // Outside the `try` deliberately: `instanceof` cannot throw for any value,
  // including a hostile one, so the fallback below can still tell a bug from a
  // blip even when building the payload fails.
  const defect = isDefect(error);
  const lineTag = defect ? DEFECT_TAG : tag;

  try {
    const e = error as { message?: unknown } | undefined;
    console.error(
      JSON.stringify({
        tag: lineTag,
        // Only on a defect line, so an operational line's shape is unchanged.
        ...(defect ? { site: tag } : {}),
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
    // But it must not be SILENT either, which is what it was until `!339`.
    // Relayed from `!334`, whose review found the same shape in
    // `logCaptureBookkeepingFailure`: a `catch` whose only job is to stop the
    // throw drops the line entirely, so the one case the logger exists to make
    // visible is the case it reports nothing for. JSON-free and property-free on
    // purpose — building the payload is precisely what just failed, so the
    // fallback touches neither the error value nor the serialiser.
    try {
      console.error(lineTag, workspaceId);
    } catch {
      // Genuinely the end of the line: `console.error` itself is unusable. Empty
      // because the alternative is throwing out of a catch block that exists to
      // stop #257, and a lost log line is a smaller harm than telling someone
      // their committed work did not save.
    }
  }
}

/**
 * The one tag every programmer fault emits, whatever site it happened at.
 *
 * Deliberately NOT a member of {@link BookkeepingTag}: that union means "a
 * consequence a site can lose", one member per consequence, and its bijection with
 * the call sites is a property `!339` restored and wants to keep. This is a
 * different axis — *why* the line exists rather than *what* was lost — so it is
 * its own constant, and a caller cannot pass it as a site tag.
 */
export const DEFECT_TAG = "bookkeeping_defect";

/**
 * Whether a rejection is a programmer fault rather than an operational one.
 *
 * These three cannot be produced by a database, a network or a constraint: they
 * mean the code is wrong. Everything else — a Prisma error, a timeout, a thrown
 * string — is operational and keeps its per-site tag, which is what the CONTROL
 * half of the tests in `best-effort.test.ts` pins.
 *
 * `RangeError` is excluded on purpose: `new Date(bad)` and `toISOString` on an
 * invalid date both produce one from *data*, so it is not reliably a bug.
 *
 * `instanceof` rather than reading `.constructor.name`, because a hostile getter
 * cannot make `instanceof` throw and this runs before the guarded block.
 *
 * ## THE RESIDUAL: a plain `Error` reads as operational, on purpose (`!339`)
 *
 * A bug that throws `new Error("unreachable state")` inside a payout is a defect
 * and is **not** detected here. That is a deliberate one-sided bet rather than an
 * oversight, because the alternative is not available: a
 * `PrismaClientKnownRequestError`, a connection reset and a statement timeout are
 * all `Error` too, so widening the test to `Error` would relabel every operational
 * blip a defect and collapse the very split this exists to make. `CONTROL: an
 * operational rejection keeps its own per-site tag` in `best-effort.test.ts`
 * forbids exactly that.
 *
 * The bet is one-sided in the safe direction. A missed defect still emits a line
 * under its per-site tag, so nothing is lost silently; a false defect would send
 * an operator hunting a bug that does not exist.
 *
 * And it has no site to apply to today: `rewards.ts` contains no `throw`
 * statement at all, and the one plain `Error` reachable through a wrapped payout
 * is `firstUseByWorkspace`'s in `src/lib/db.ts` — "the workspace was deleted
 * concurrently", which is environmental, so the answer this function already
 * gives for it is the correct one. If a payout callee ever does grow a genuine
 * invariant check, the fix is a named `Error` subclass at that site and one more
 * `instanceof` here, not a wider net.
 */
function isDefect(error: unknown): boolean {
  return (
    error instanceof TypeError ||
    error instanceof ReferenceError ||
    error instanceof SyntaxError
  );
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
 *
 * ## ONE CALL PER INDEPENDENT CONSEQUENCE — the rule, as a decidable test
 *
 * The thunk is sequential, so **two consequences inside one thunk are not
 * independent of each other**: the first rejection cancels the rest, and a shared
 * tag cannot say which was lost. Duo review found that shape **four times** on
 * `!339` — `completeFocus`, `confirmBreakdown`, `markTaskCompleted`, and then this
 * paragraph's own exception count.
 *
 * **The rule, stated so a reader can decide a NEW site without consulting a list:**
 *
 * > A thunk may bundle consequences **iff** every consequence after the first reads
 * > something an earlier one wrote. Otherwise each gets its own call and its own
 * > tag.
 *
 * Phrased as a property rather than an enumeration on purpose. The previous version
 * said "any other bundled thunk is a bug", which is only protective while the
 * exception list is complete — and it was incomplete the moment it was written,
 * because it named one exception when there were three. A list of exceptions rots;
 * a test does not.
 *
 * ## ⚠️ Applying it requires following the call INTO the callee
 *
 * This is where three of the four recurrences hid, and it is the part worth
 * internalising. Counting consequences **at the call site** is not enough: a thunk
 * can be a single bare `await` and still bundle, because the bundling lives one
 * level down in what it calls. `bestEffort(tag, ws, () => rewardStepDone(ws))` reads
 * as one consequence and is three.
 *
 * So the question is asked of the **callee**, and the current answers are:
 *
 * - `logReward` — one `RewardEvent` insert. Single.
 * - `awardBadge` — one `Badge` upsert behind an existence check. Single.
 * - `rewardStepDone` — **bundles 3**, legitimately: `maybeAwardTenStepsDay` counts
 *   the `RewardEvent` that `logReward` just wrote. Reached under **two** tags,
 *   `step_done_bookkeeping_failed` and `focus_step_reward_failed`.
 * - `touchStreakOnEngagement` — **bundles 5**, legitimately: `streakRecord.aggregate`
 *   reads the `StreakRecord` its own transaction may have just written. Reached
 *   directly under `breakdown_streak_touch_failed`, and transitively inside
 *   `rewardStepDone`.
 *
 * Three tags therefore wrap a legitimate bundle, and all three carry the ⚠️ marker
 * on their union member. Both bundling callees record their own dependency and
 * residual in `src/lib/rewards.ts`; neither is repeated here.
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
