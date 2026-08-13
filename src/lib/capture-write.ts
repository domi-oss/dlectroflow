import { prisma } from "@/lib/db";
import { splitInlineNote } from "@/lib/braindump-note-syntax";
import { normalizeTaskNote } from "@/lib/task-notes";
import { touchStreakOnEngagement } from "@/lib/rewards";

/**
 * #175 — the ONE brain-dump capture write.
 *
 * Design: `docs/design/specs/2026-08-11-offline-capture-queue-design.md`.
 *
 * ## Why this is a module and not just a server action
 *
 * The offline queue flushes through `POST /api/braindump`, and the spec puts the
 * FOREGROUND capture on the same route rather than leaving the server action as a
 * second entry point — so there is **one write path and one set of semantics to
 * test**. `createBrainDumpItem` stays for the callers that are not queued (the
 * breakdown ejector, `src/components/breakdown/breakdown-chat.tsx`) and shares
 * this core rather than carrying its own copy of the note split, the empty guard
 * and the streak touch. Two copies of a write is how `Settings` and `Streak` came
 * to hold the same #156 bug independently.
 *
 * It cannot live in `src/app/actions/braindump.ts`: that file is `"use server"`,
 * so every export from it is an async server action and a plain helper is not a
 * legal thing to export. `src/lib/` is where domain logic lives here anyway.
 *
 * ## Revalidation is deliberately NOT here
 *
 * `revalidatePath` is a request-scoped Next API and no module in `src/lib`
 * touches one; the caller owns it, exactly as the actions do today. It is also
 * only correct on the `created` outcome — see {@link CaptureOutcome}.
 */

/**
 * What happened to one capture. Three values, and the caller maps them to
 * whatever its transport says: `POST /api/braindump` answers 201 / 200 / 400, and
 * the server action revalidates on the first and returns silently on the others.
 *
 * `duplicate` is a SUCCESS. `withActionTimeout` bounds how long the UI waits, not
 * how long the request runs (its docblock in
 * `src/lib/server-action-failure.ts` says so), so a capture that timed out at
 * 10s and landed at 14s comes back on the next flush as a duplicate — the row is
 * saved and the words are not lost. `capture-queue.ts`'s `applyFlushOutcome`
 * drops the queue entry on `duplicate` exactly as it does on `saved`, and that is
 * the whole reason `clientKey` exists.
 */
export type CaptureOutcome = "created" | "duplicate" | "empty";

/**
 * One greppable line for a streak touch that failed after the row was committed
 * (#175). Same shape and same reason as `logShoppingBookkeepingFailure` in
 * `src/app/actions/shopping.ts`, and `recordLLMFailure` before it: a structured
 * `tag` is what makes "the streak touch is failing for everybody" a thing
 * somebody can find out, rather than a number quietly drifting.
 *
 * `error` level rather than `warn`: unlike the handled outcomes #158 is about,
 * this is an unhandled fault in a second statement, and the only reason it is not
 * a 500 is that the user's words are already safe.
 */
function logCaptureBookkeepingFailure(
  workspaceId: string,
  error: unknown,
): void {
  try {
    const e = error as { message?: unknown } | undefined;
    console.error(
      JSON.stringify({
        tag: "capture_streak_touch_failed",
        workspaceId,
        message: typeof e?.message === "string" ? e.message : String(error),
        ts: new Date().toISOString(),
      }),
    );
  } catch {
    // Observability must never take the request down with it — the guard
    // `recordLLMFailure` and `recordAuthFailure` carry, and it matters more here
    // because the catch block calling this exists precisely to keep a committed
    // write from being reported as failed.
    //
    // ⚠️ But swallowing SILENTLY here contradicted the promise three paragraphs
    // up in `writeCapture`'s docblock — "swallowed is not invisible … the failure
    // gets one greppable line" — and did it in the worst possible place: the one
    // case this function exists to report was a case it could drop without trace
    // (Duo review round 10, `!334`). So the fallback emits the tag and the
    // workspace with **no JSON and no interpolation**, because the whole reason
    // it is reachable is that building the structured line failed. Less
    // information, still greppable, and almost nothing left that can throw.
    //
    // ⚠️ It is NOT reachable via a circular rejection value, which is the obvious
    // guess and is wrong: `message` is resolved to a string before
    // `JSON.stringify` sees anything, so the object it serialises holds four
    // strings and cannot be cyclic. What does reach here is `String(error)` on a
    // value with no `toString`/`valueOf` (a null-prototype object raises
    // `TypeError: Cannot convert object to primitive value`), a `message` getter
    // that throws during the read, and a `console.error` that throws. All three
    // are pinned in `capture-write.test.ts`, the last one as a guard on this
    // fallback rather than on the original defect.
    try {
      console.error("capture_streak_touch_failed", workspaceId);
    } catch {
      // Genuinely the end of the line: the only remaining statement was the one
      // that just failed, and there is nowhere left to report to. Empty here is a
      // conclusion rather than an omission — which is exactly what the outer
      // `catch` was NOT, and why it needed this.
    }
  }
}

export type CaptureInput = {
  /** The workspace the SESSION resolved. Never a value a request supplied. */
  workspaceId: string;
  /** Raw text as typed, inline note syntax included — split here (#179). */
  text: string;
  /**
   * The client-generated idempotency key, when the caller has one.
   *
   * `null` for every ordinary online capture, and the null is load-bearing:
   * Postgres treats nulls as DISTINCT in a unique index, so any number of
   * unkeyed captures coexist under `BrainDumpItem_workspaceId_clientKey_key`
   * while a replayed keyed one collides with itself. See the column's comment in
   * `prisma/schema.prisma`.
   */
  clientKey?: string | null;
};

/**
 * Capture a brain dump, splitting off an inline note if it carries one (#179),
 * and never writing the same `clientKey` twice for one workspace (#175).
 *
 * ## The empty guard reads the PARSED text
 *
 * `{just a note}` is refused by the parser and stored literally, so this cannot
 * create a row whose only content is hidden behind a note disclosure — and it is
 * not empty either. The note goes through `normalizeTaskNote` rather than being
 * left to `BrainDumpItem_notes_check`: the constraint is the backstop for a
 * writer that forgot, and reaching it from the writer that did not would surface
 * to the person as a capture that silently failed.
 *
 * ## Idempotency is Postgres's decision, not this function's
 *
 * `createManyAndReturn` with `skipDuplicates` is the only Prisma API that
 * compiles to `INSERT … ON CONFLICT DO NOTHING`, and `src/lib/db.ts` argues at
 * length why that is the shape rather than a `P2002` catch: the client logger
 * prints a failed query strictly BEFORE any `catch` sees it, so a fully handled
 * duplicate still reports `prisma:error` and reads as an incident (#156, #158).
 * A replayed capture is the most ordinary event in this feature and must be
 * silent. The loser gets an empty array — a **result**, not an error, the same
 * reading `ensureFocusStep` takes of its own step insert (#245).
 *
 * There is no read-then-write and so no race to lose: two concurrent flushes of
 * the same key both reach the index, one inserts, the other is skipped.
 *
 * ## The streak is only advanced by a capture that was actually written
 *
 * A duplicate is a capture the user already made, and the engagement was banked
 * when the first copy landed. `touchStreakOnEngagement` early-returns on
 * `lastActiveWorkday === today`, so a second call on the SAME working day is a
 * true no-op rather than a near one — but a duplicate flushed on a LATER working
 * day is not, which is why this arm returns before the touch rather than leaning
 * on the idempotency. The same argument `ensureFocusStep` makes for gating its
 * revalidation on whether it wrote, and the rejected alternative below is where
 * the cross-day half of it bites.
 *
 * ## The streak touch is BEST-EFFORT, and that is a data-integrity decision
 *
 * Duo review round 4, `!334`. The insert and the streak touch are two statements
 * with nothing atomic between them, so the touch can fail on its own with the row
 * already committed — and `skipDuplicates` is what gave that teeth: a retry now
 * takes the `duplicate` arm above, which never reaches the streak, so **nothing
 * downstream can recover the credit**. Letting the failure propagate therefore
 * preserves nothing at all, and costs a lie.
 *
 * **What the person sees, in one sentence:** the capture bar shows
 * `capture.error.failed` — "Couldn't save that just now — your words are still
 * here:" — over words that ARE saved, and its Retry (#210) writes a second row,
 * because `createBrainDumpItem` sends no `clientKey` and the unique index treats
 * nulls as distinct; that is a duplicate item in the inbox, and it needs the
 * person to notice and delete it.
 *
 * `strings.ts` has already ruled on that claim from the other side: it declines to
 * say "couldn't save that" on a TIMEOUT because it would be "a claim the client
 * cannot support". A streak-touch rejection makes the definite wording exactly
 * that unsupportable claim, with the client given no way to know.
 *
 * So this is `settleShopping`'s call for `!295` ("a duplicated item is not
 * recoverable"), and `awardFirstSchedule`'s for scheduling, applied to the write
 * both of them were describing. It is also the rule `inbox-view.tsx` reached from
 * the other end in its Duo round 8 comment — *"the `try` governs the WRITE;
 * anything after it is a consequence of success and cannot un-write the row"* —
 * pushed one layer down, because the streak touch is a consequence of success and
 * `writeCapture` is where it now lives.
 *
 * **The residual, stated rather than implied:** this capture does not bank a
 * streak credit for the day. It is not banked *at all* only when the person makes
 * no other qualifying engagement that working day — `Streak.lastActiveWorkday`
 * makes the streak a per-day boolean, so any completion, breakdown-confirm or
 * later capture credits the same day in full and nothing is left half-advanced.
 * **Swallowed is not invisible:** the failure gets one greppable line, so "the
 * streak touch is failing for everybody" is something somebody can find out.
 * That promise is now kept in two tiers rather than one — a structured JSON line
 * normally, degrading to a bare `capture_streak_touch_failed` and the workspace id
 * if the structured line cannot be built. The tag is the same either way, so the
 * grep that finds one finds the other; see `logCaptureBookkeepingFailure`, where
 * the fallback exists because the first version of this sentence was a promise the
 * code did not keep.
 *
 * ### Rejected: touch the streak on the `duplicate` arm as well
 *
 * The tempting one, because it recovers the credit rather than accepting the loss,
 * and `touchStreakOnEngagement` genuinely is per-day idempotent so it cannot
 * double-count today. It is **not** idempotent across days, and that sinks it. A
 * duplicate is flushed whenever a response was lost after the insert committed;
 * `capture-queue.ts` records a discarded Android Chrome tab as the NORMAL case for
 * that. A flush on the next working day would then advance the streak — and mint
 * `Streak5` or `BeatBestStreak` — for a day whose only engagement was reopening
 * the app. That sequence needs no failure at all, so it is strictly more ordinary
 * than the one it repairs: it would trade a credit the day can earn back for one
 * the person never earned. It is also dead code once the touch above is
 * best-effort, since the request that produced the retry no longer fails.
 *
 * ### Rejected: wrap the two statements in one transaction
 *
 * `touchStreakOnEngagement` opens its OWN interactive `prisma.$transaction` on the
 * module-level client and takes no `Prisma.TransactionClient`, so making it join an
 * outer transaction means changing its signature in `src/lib/rewards.ts`. Nested as
 * it stands it buys no atomicity whatever — the inner transaction runs on a second
 * pooled connection and commits independently of the outer — while holding an
 * uncommitted insert open across a `SELECT … FOR UPDATE`, a settings read and up to
 * three badge writes, which is a connection-pool deadlock waiting for a second
 * caller.
 *
 * Reversing the order instead — streak first, then insert — needs no change to
 * `rewards.ts` and is worse: it puts that lock, that read and those badge writes
 * IN FRONT of the insert, widening the window in which the request dies with the
 * words still unsaved. That is the one thing #175 exists to prevent, so the
 * ordering is not negotiable even though the atomicity would be nice to have.
 */
export async function writeCapture({
  workspaceId,
  text,
  clientKey = null,
}: CaptureInput): Promise<CaptureOutcome> {
  const { text: itemText, note } = splitInlineNote(text);
  if (!itemText) return "empty";

  const [created] = await prisma.brainDumpItem.createManyAndReturn({
    data: {
      text: itemText,
      notes: normalizeTaskNote(note),
      workspaceId,
      clientKey,
    },
    skipDuplicates: true,
  });
  if (!created) return "duplicate";

  // A capture is a qualifying engagement (Decision 1, #8 Phase 7) — advances the
  // streak at most once per working day.
  //
  // Best-effort, and the `try` covers this ONE statement: the row above is
  // committed, so no fault after it may report the capture as failed (#175). The
  // reasoning, the residual and the two alternatives are in this function's
  // docblock under "The streak touch is BEST-EFFORT".
  try {
    await touchStreakOnEngagement(workspaceId);
  } catch (error) {
    logCaptureBookkeepingFailure(workspaceId, error);
  }
  return "created";
}
