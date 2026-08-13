"use client";

import {
  useEffect,
  useId,
  useRef,
  useState,
  useSyncExternalStore,
  useTransition,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { createPortal } from "react-dom";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Clock, RefreshCw, RotateCcw, TriangleAlert } from "lucide-react";
import { cn, touchTarget } from "@/lib/utils";
import { COMPLETE_TEXT } from "@/lib/completion-style";
import { DonePill } from "@/components/completion/done-pill";
import {
  draggable,
  dropTargetForElements,
  monitorForElements,
  type ElementDragPayload,
} from "@atlaskit/pragmatic-drag-and-drop/element/adapter";
import { setCustomNativeDragPreview } from "@atlaskit/pragmatic-drag-and-drop/element/set-custom-native-drag-preview";
import { pointerOutsideOfPreview } from "@atlaskit/pragmatic-drag-and-drop/element/pointer-outside-of-preview";
import {
  MOVE_INSTRUCTIONS,
  liftAnnouncement,
  overAnnouncement,
  movedAnnouncement,
  notMovedAnnouncement,
  cancelledAnnouncement,
} from "@/components/inbox/drag-announce";
import {
  isAging,
  effectiveAgingMs,
  freshnessTier,
  shouldPrompt24h,
  type AgingSettings,
} from "@/lib/aging";
import {
  createBrainDumpItem,
  triageBrainDumpItem,
  snoozeBrainDumpItem,
  deleteBrainDumpItem,
  keepAsTask,
  markReminded,
  freshenItem,
  dismissPrompt,
  completeItem,
  reopenItem,
  moveToReview,
  requestBreakdown,
  ensureFocusStep,
  renameItem,
} from "@/app/actions/braindump";
import { startBreakdown } from "@/app/actions/breakdown";
import {
  pushStepsToGoogleTasks,
  scheduleSingleTask,
} from "@/app/actions/google-schedule";
import { scheduleViaIcs } from "@/app/actions/ics-schedule";
import { downloadIcs } from "@/lib/download-ics";
import type { GoogleConnStatus, ScheduleIntent } from "@/lib/scheduling/types";
import { StatusPill } from "@/components/inbox/status-pill";
import { TaskSteps } from "@/components/breakdown/task-steps";
import { TaskNoteRow } from "@/components/breakdown/task-note";
import {
  inlineNoteSource,
  inlineNoteTyping,
} from "@/lib/braindump-note-syntax";
import { liveNote } from "@/lib/braindump-to-task";
import {
  bucketItems,
  bucketOfItem,
  isBucketId,
  type Item,
  type BucketId,
} from "@/components/inbox/bucket";
import {
  ActionTimeoutError,
  isStaleActionError,
  withActionTimeout,
} from "@/lib/server-action-failure";
import { itemRemainingMin, activeStepRemainingMin } from "@/lib/task-remaining";
import { dropPlan } from "@/components/inbox/move-dispatch";
import { MoveToMenu } from "@/components/inbox/move-to-menu";
import { rowMenuEntry } from "@/components/ui/anchored-popup";
import { groupedRowMenu } from "@/components/ui/row-menu-separator";
import {
  RowActions,
  ScheduleControl,
  type ScheduleControlProps,
} from "@/components/inbox/row-actions";
import { CompleteButton } from "@/components/inbox/complete-button";
import { AddNoteButton } from "@/components/inbox/add-note-button";
import { WelcomeCard } from "@/components/inbox/welcome-card";
import { ShoppingSummaryCard } from "@/components/inbox/shopping-summary-card";
import { newAccountLine, type AccountIdentity } from "@/lib/identity";
import { SubHeader, SEE_ALL } from "@/components/inbox/sub-header";
import { t } from "@/lib/strings";
import { useVoice } from "@/components/voice-provider";
import type { StringKey, Voice } from "@/lib/strings";
import {
  notificationPermission,
  requestNotificationPermission,
  registerServiceWorker,
  showReminder,
  subscribeNotificationPermission,
} from "@/lib/notifications";
import { formatAgo } from "@/lib/format";

/**
 * The key an inbox row's drag carries its item id under, and the one a bucket's
 * drop zone carries its bucket id under. Both are `data` on
 * pragmatic-drag-and-drop's `draggable` / `dropTargetForElements`, which is an
 * open `Record<string, unknown>` — so these constants are the only thing making
 * "is this drag one of ours?" a decidable question rather than a guess (#163).
 */
const DRAG_ITEM_KEY = "inboxItemId";
const DROP_BUCKET_KEY = "inboxBucketId";

/**
 * #210 — how long the capture bar is willing to WAIT for `createBrainDumpItem`
 * before calling it a failure.
 *
 * The third failure mode is silence rather than a rejection — a pod rolling
 * mid-request, a connection that never closes — and from the user's side an
 * un-timed-out `await` is indistinguishable from the bug this fixes: an emptied
 * field, no confirmation, no error, no words. `createBrainDumpItem` is one
 * Prisma insert plus a streak touch, so ten seconds is already pathological;
 * this matches `focus-timer.tsx`'s `ACTION_TIMEOUT_MS` for the same class of
 * call. The request itself carries on (a server action cannot be aborted from
 * the client), so a write that lands late still lands — the next
 * `router.refresh()` picks it up. Exported so the test advances the real value
 * rather than a copy of it.
 */
export const CAPTURE_TIMEOUT_MS = 10_000;

/**
 * #225 — how long a ROW write is willing to wait before it is called a failure.
 *
 * Same reasoning and same value as `CAPTURE_TIMEOUT_MS` above,
 * `SHOPPING_ACTION_TIMEOUT_MS` and `focus-timer.tsx`'s `ACTION_TIMEOUT_MS`: the
 * third failure mode is silence rather than a rejection, and from the user's
 * side an un-timed-out `await` is indistinguishable from the silent no-op this
 * whole notice exists to kill. Every action behind `run()` is a handful of short
 * Prisma statements, so ten seconds is already pathological. The request itself
 * carries on — a server action cannot be aborted from the client — so a write
 * that lands late still lands, and the next `router.refresh()` picks it up.
 * Exported so the test advances the real value rather than a copy of it.
 *
 * A separate constant from `CAPTURE_TIMEOUT_MS` despite the identical value:
 * they bound two different calls, and welding them together would mean re-tuning
 * one silently re-tuned the other.
 */
export const INBOX_ACTION_TIMEOUT_MS = 10_000;

/** How long "captured ✓" stays on screen after a write resolves. */
const CAPTURE_CONFIRM_MS = 1500;

/**
 * #210 — a capture whose write did not land.
 *
 * Holds the words, not just a flag: they are the only thing at stake, and the
 * notice quoting them is what makes them recoverable even in the one case the
 * input cannot be restored (see `capture` below).
 */
type CaptureFailure = {
  value: string;
  /**
   * The browser is running a different deployment than the server. Next
   * regenerates server-action ids on every build, so a retry re-posts the same
   * dead id — the ONLY thing that can work is a reload, and offering a retry
   * would be offering something that cannot.
   */
  stale: boolean;
  /**
   * The write never answered, so **whether it landed is unknown** (Duo review
   * round 2). `withActionTimeout` bounds how long the UI waits, not the request:
   * a server action cannot be aborted from the client, so the insert may still
   * complete, and a retry after it does leaves two identical items.
   *
   * Which is why this is a distinct flag rather than folded into the generic
   * failure. Telling the user "couldn't save that" here would be a claim the
   * client cannot support — the same unverifiable confirmation as the
   * `captured ✓` this issue is about, pointing the other way. Retry is still
   * offered, because a duplicate item is one tap to delete while an unwritten
   * thought is not recoverable at all; the notice just says which risk they are
   * taking. The durable answer is an idempotency key on the insert, which needs
   * a schema change and so is not this fix.
   */
  timedOut: boolean;
  /**
   * A retry of THESE words is in flight.
   *
   * On the failure record rather than in a component-wide `capturing` flag, and
   * that is the whole point (Duo review round 2). A capture the user types while
   * a retry is outstanding is deliberately ungated, so it settles inside the
   * retry's window — and a shared boolean would then be cleared by the wrong
   * request, handing the Retry button back mid-flight and letting a double press
   * post the same words twice. Same lesson `schedulingIds` already applies
   * per-row to the Schedule controls (#169).
   */
  retrying: boolean;
  /**
   * The words are sitting in the capture field, where the user can see them.
   *
   * Which decides whether a LATER successful capture supersedes this notice (Duo
   * review round 3). If they are in the box and the user submits something else
   * from it — an edit, or a different thought typed over them — they have seen
   * them and moved on, so the alert is only noise inviting a near-duplicate
   * Retry. If they are not (the field already held the user's next thought) the
   * notice is the ONLY copy of them, and it has to outlive any number of
   * successful captures.
   *
   * Deliberately "are they in the field", not "did we just put them there" (Duo
   * review round 4). A retry does not clear the field — only success does — so on
   * a retry that fails again the words are already there, untouched. Asking the
   * narrower question answered no, and the notice then refused to be superseded:
   * a stale alert beside a fresh "captured ✓" after the user had visibly typed
   * over those words. Which is this issue's own bug, from a different door.
   */
  wordsInField: boolean;
};

/**
 * #210 — which message a failed capture gets.
 *
 * Ordered by how much the user can be told, most-certain first. `stale` and
 * `timedOut` both override the generic copy because both change what the user
 * should DO: a stale bundle makes a retry impossible, and a timeout makes the
 * outcome unknown, so "couldn't save that" would be a claim the client cannot
 * support. Mirrors `focus-timer.tsx`'s `failureMessageKey`.
 */
function captureMessageKey(failure: CaptureFailure): StringKey {
  if (failure.stale) return "capture.error.stale";
  if (failure.timedOut) return "capture.error.timeout";
  return "capture.error.failed";
}

/**
 * #225 — WHICH write a row failure is about.
 *
 * Not the closure that performed it. !294 spent a review round on that exact
 * mistake: the shopping notice recognised "the write this record is about has
 * now succeeded" by comparing a held `fn` by REFERENCE, and only the notice's own
 * Retry ever hands the same closure back — every ordinary control builds a fresh
 * one on every render. So a user who simply pressed the row's button again could
 * never match, the banner from the earlier attempt stayed up beside the write
 * that had just landed, and its Retry then re-posted the OLD call with the OLD
 * arguments. A failure belongs to a logical target, so that is what it is keyed
 * by; `fn` is still held, but only to re-run.
 *
 * **Row AND field, not row alone.** A failed rename is not answered by a
 * successful tick of the same row — the words still did not save, and re-posting
 * them is still exactly right. Keying by row alone would throw away a failure the
 * user has not been told about, which is this issue's own bug from the other side.
 *
 * `completeItem` and `reopenItem` deliberately SHARE `"done"`: they write the
 * same column in opposite directions, so serialising them is correct rather than
 * incidental, and the guard below is what stops a double-press of Complete
 * becoming two writes.
 *
 * ## `"move"` reaches three of these actions again, and that is accepted
 *
 * A drop and a row button can address the SAME action under two different
 * labels: dragging to Done is `"move"` and runs `completeItem`, while the row's
 * own tick is `"done"` and runs it too. `snoozeBrainDumpItem` (drop on Snoozed
 * vs. the row's Snooze) and `reopenItem` (a drop's `reopenFirst` vs. the row's
 * Undo) overlap the same way. Different keys, so the guard lets both through —
 * raised on !306 and accepted rather than fixed, for three reasons that have to
 * hold together:
 *
 * 1. **They cannot actually overlap from one client.** Next serialises server
 *    actions — see {@link writeGuardKey} for the mechanism — so the second call
 *    is dispatched only once the first has finished. It then meets that action's
 *    own early return (`if (!item || item.completedAt) return`), and the other
 *    two write absolute values rather than accumulating, so the repeat is a
 *    no-op rather than a second effect.
 * 2. **A shared key would break something that works.** Collapsing `"move"` into
 *    the field its `plan` happens to pick is what the note on `moveItemToBucket`
 *    argues against: a failed drop onto Done has to be retried as that drop,
 *    reopen included, not as a bare `completeItem` that would drop half of it.
 * 3. **The residual race is not the client's to hold.** Genuine concurrency here
 *    needs two router instances — two tabs, or two devices — which no in-memory
 *    guard can span, so a guard widened to cover it would buy nothing and read
 *    as though it had. That is why the defence lives in the actions, and
 *    `reopenItem` says so in as many words ("the same Done row open in two
 *    tabs"): see its reversal counted off what the writes CHANGED, the
 *    interactive-transaction row lock — the `tx.$queryRaw … FOR UPDATE` that
 *    opens `touchStreakOnEngagement`'s transaction in `rewards.ts` — and
 *    `awardBadge`'s `ON CONFLICT DO NOTHING`.
 *
 *    ⚠️ Cited by FUNCTION, not by line, and named `touchStreakOnEngagement`
 *    rather than `touchStreakOnCompletion`. This bullet said "`rewards.ts:677`",
 *    which is the `@deprecated` three-line alias — no lock, no transaction — so
 *    it pointed a reader checking the claim at code that does not support it. It
 *    replaced a correct line number to do so. #233 removed the number from
 *    `rewards.integration.test.ts`'s own copy of this citation for exactly that
 *    reason: a line reference goes on reading authoritatively after it stops
 *    being true. The alias is still what the completion call sites call, which is
 *    why the tests race it; the read-decide-write lives in the engagement
 *    function.
 *
 *    ⚠️ Corrected #251, then again on #253: this used to say the row lock was
 *    "proved against a real database in `rewards.integration.test.ts`". #251's
 *    correction — **that file does not exist** — was true and read as though the
 *    proof had never been written. It had. `src/lib/rewards.integration.test.ts`
 *    existed from #21 (`ff9e88a`) until **#251's `783a6bf` deleted all 113 lines
 *    of it**, in a commit whose message documents the inbox-zero gate it was
 *    actually about and never mentions the deletion. So the accurate statement is
 *    not "unproven" but "the proof was removed and the citation outlived it",
 *    which is a different failure with a different fix.
 *
 *    **SETTLED — the proof exists.** #233 landed it:
 *    `src/lib/rewards.integration.test.ts` is in the tree, fires genuinely
 *    concurrent calls at real Postgres, and asserts `maxLiveTx` so a barrier that
 *    never actually overlapped cannot pass. It also carries a citation guard that
 *    fails loudly rather than open, so a second silent deletion reds the suite
 *    instead of quietly restoring the state #251 left.
 *
 *    This sentence is corrected here for the THIRD time and each earlier version
 *    was wrong in the same direction — describing the proof's status from an
 *    inherited claim rather than from the tree. It said "does not exist" when the
 *    file had existed and been deleted, then "is being restored … treat as
 *    unsettled" after the restore had already landed. So the bullet is now one of
 *    three equal defences, and the way to check that is to open the file rather
 *    than to read this comment.
 *
 *    The mocking observation it rested on stands and is why the integration test
 *    is the only thing that can speak here: `touchStreakOnCompletion` is mocked
 *    in every unit file that names it, so no unit test can exercise an
 *    interactive-transaction row lock.
 *
 *    What that leaves is `completeItem`'s two unguarded `logReward` calls, which
 *    two truly simultaneous completions of one to-do could bank twice. It is
 *    real, it is server-side, it predates this MR, and it is reachable without
 *    going near a `WriteField` at all — so it is neither this guard's to fix nor
 *    #225's, and it is recorded here rather than left for the next reader to
 *    rediscover from the same comment.
 *
 * The contrast with `"text"` is the whole point, and it is not that a rename is
 * more dangerous: it is that these three are the same request twice, and two
 * renames are two different requests.
 */
type WriteField =
  /** `renameItem` — and, through it, the inline note (#179). */
  | "text"
  /** `deleteBrainDumpItem`. */
  | "delete"
  /** `keepAsTask`. The one write here that CREATES a row, hence the guard. */
  | "triage"
  /** `snoozeBrainDumpItem`. */
  | "snooze"
  /** `completeItem` and `reopenItem` — the same column, both directions. */
  | "done"
  /** `freshenItem`. */
  | "freshen"
  /** `dismissPrompt`. */
  | "prompt"
  /** `moveItemToBucket`'s composite: an optional reopen plus one bucket write. */
  | "move"
  /**
   * `startBreakdown`. Like `"triage"` it CREATES a Task, and like `"triage"` it
   * navigates away on success rather than refreshing — see `onLanded`.
   *
   * Its own field rather than a share of `"triage"`, even though the two write
   * the same three columns. Sharing would absorb "Break into steps" pressed
   * after "Add to-do", and that second press asks for something the first one
   * does not do: it asks to be TAKEN somewhere. Absorbing it would leave the
   * user on the inbox with no navigation and no explanation, which is the silent
   * no-op this issue removes rather than one to add. Two presses of the SAME
   * control are still absorbed, which is the case that fires twice in practice.
   */
  | "breakdown"
  /** `ensureFocusStep`. Creates a Task AND a Step, and navigates. Its own field
   *  for the reason `"breakdown"` has one. */
  | "focus";

type WriteTarget = { id: string; field: WriteField };

const writeTargetKey = ({ id, field }: WriteTarget): string => `${id}:${field}`;

const sameWriteTarget = (a: WriteTarget, b: WriteTarget): boolean =>
  a.id === b.id && a.field === b.field;

/**
 * #225 (!306, Duo review) — what the double-press guard absorbs on, which is
 * NOT always the target.
 *
 * The guard's premise, argued in full beside `inFlight` below, is that "the
 * identical write to the identical target is already running, so pressing again
 * asks for something that is already happening". That holds for seven of the
 * eight fields because their target IS the whole request: `completeItem(id)`
 * closes the row whichever control asked, so a second press really is the same
 * ask and absorbing it is right.
 *
 * `"text"` is the one field that carries words. `renameItem(id, value)` means
 * two submissions of the ✎ editor against one row are two DIFFERENT requests,
 * and the guard was dropping the second while the editor closed as though it
 * had saved — a silent write failure wearing a success, which is the class this
 * issue exists to remove rather than to add to. So a rename is guarded on the
 * words as well as the row: the same words twice are still a double-press and
 * still absorbed, different words are a new request and go.
 *
 * Letting the second one through is safe rather than a race. Next serialises
 * server actions: `callServer` dispatches every one into the app router's action
 * queue, and `dispatchAction` appends to the queue whenever something is already
 * pending, so `runRemainingActions` starts it only once the previous action has
 * finished (`next/dist/client/components/app-router-instance.js`). The two
 * renames therefore reach the server in submission order and the row is left
 * holding the last words the user typed, which is what they asked for. The
 * `seq` machinery already handles the rest: the NEWEST attempt to settle owns
 * the notice whichever way it went, so an earlier failure is cleared by the
 * later edit that superseded it and — !306's Duo review, since letting the
 * second rename through is what put two writes at one target in the first place
 * — an earlier failure cannot overwrite the later edit's notice either.
 *
 * Deliberately separate from {@link writeTargetKey}, which stays keyed by target
 * alone — `writeSettledAt`'s "has a newer write at this row settled?" question
 * is about the row, not about the words.
 */
const writeGuardKey = (target: WriteTarget, subject: string): string =>
  target.field === "text"
    ? `${writeTargetKey(target)}:${subject}`
    : writeTargetKey(target);

/**
 * #225 — a row write that did not land.
 *
 * ONE slot, not a queue: a second failure displaces the first. That boundary is
 * #210's, argued there at length and deliberately not re-opened here — and it
 * costs less on this path than it does on the capture path, because nothing a row
 * write can lose is unrecoverable. The row is still in the list and the press is
 * still repeatable; what was lost is one change, not the only copy of a thought.
 */
type WriteFailure = {
  /**
   * The words the failed write was about — the NEW text for a rename, the item's
   * own text for everything else. Held here rather than looked up at render, so a
   * rename's notice quotes what did not save rather than the title still on screen.
   */
  subject: string;
  /** @see WriteTarget — the identity every "is this record about that?" test uses. */
  target: WriteTarget;
  /**
   * Which attempt produced this record, from the component's own monotonic
   * counter. Held so an OLDER attempt settling late cannot rewrite a newer record
   * for the same target: a success only clears a notice it is strictly newer than.
   */
  seq: number;
  /**
   * The browser is running a different deployment than the server. Next
   * regenerates server-action ids on every build, so a retry re-posts the same
   * dead id — the only thing that can work is a reload.
   */
  stale: boolean;
  /**
   * The write never answered, so **whether it landed is unknown**. The timeout
   * bounds how long the UI waits, not the request. Kept distinct from the generic
   * failure because "nothing changed" would then be a claim the client cannot
   * support.
   */
  timedOut: boolean;
  /** A retry of THIS write is in flight. */
  retrying: boolean;
  /** The exact call that failed, so Retry re-runs *that* rather than a rebuilt
   *  guess at it. Deliberately not an identity — see {@link WriteTarget}. */
  fn: () => Promise<unknown>;
  /**
   * #225 — what success does, when `router.refresh()` is not it.
   *
   * Two of the writes NAVIGATE: a breakdown and ▶ Focus create the row they are
   * about and then go to its page, so the default refresh would be a second
   * fetch of a route the push has already left. Held beside `fn` for exactly the
   * reason `fn` is held — Retry has to reproduce the whole write, and the outcome
   * is part of the write rather than a decoration on it. A retry that saved the
   * row and then stayed on the inbox would be the press vanishing again.
   *
   * Takes the resolved value because that is where the id to navigate to is, and
   * because a falsy one means the action declined: the callback is the only place
   * that knows which of those two happened.
   */
  onLanded?: (result: unknown) => void;
  /**
   * The control the press came from, so focus can be handed back when the notice
   * goes away (WCAG 2.4.3).
   *
   * A live element rather than an id, because the 20 call sites have no shared
   * registry to look one up in and adding one to all of them is exactly the
   * per-call-site work this fix exists to avoid. `isConnected` is checked before
   * it is used: a row removed by the refresh cannot be focused, and the capture
   * field is the fallback.
   */
  origin: HTMLElement | null;
};

/**
 * #225 — is the write that just landed the one the notice on screen is waiting
 * on?
 *
 * Both halves were learned the expensive way. The TARGET test is !294's round-6
 * finding: identity is the row and the field, never the closure, because every
 * ordinary control builds a fresh closure on every render. The SEQUENCE test
 * stops a late success clearing a FRESHER failure at the same target, which
 * would be a silent no-op of exactly the kind this issue removes.
 *
 * One predicate rather than two copies of it, because the notice's removal and
 * the focus hand-off that goes with it have to agree about what is happening:
 * arming a hand-off for a notice that is NOT going away is how focus lands on a
 * control the user was never sent away from (!306, Duo review).
 */
function answersFailure(
  failure: WriteFailure | null,
  target: WriteTarget,
  seq: number,
): failure is WriteFailure {
  return (
    failure !== null &&
    sameWriteTarget(failure.target, target) &&
    failure.seq < seq
  );
}

/**
 * #225 — which of the four messages a row failure gets, ordered by how much the
 * user can be told, most-certain first. Mirrors `captureMessageKey` above,
 * `writeFailureKey` in `shopping-list.tsx` and `failureMessageKey` in
 * `focus-timer.tsx`.
 */
function writeFailureKey(failure: WriteFailure, rowGone: boolean): StringKey {
  if (failure.stale) return "inbox.errorSaveStale";
  // !306, Duo review — the two facts together, and neither of the messages below
  // is honest about the pair. `writeFailureRemedy` has already withdrawn every
  // control by the time this is true, so the timeout's "before trying again"
  // promises a button that is not on the screen; and the user is being sent to
  // check a list the page has itself just checked. Kept ABOVE `timedOut` for that
  // reason, and separate from `errorSaveGone` because it must not inherit
  // "nothing changed" — see the note below, which applies to this arm too.
  if (failure.timedOut && rowGone) return "inbox.errorSaveTimeoutGone";
  // Stays ABOVE `rowGone`: a timeout's verdict is genuinely unknown, and "nothing
  // changed" would be a claim the client cannot support — the row may be absent
  // BECAUSE the write it is unsure about landed. While the row is still on the
  // list, "check your inbox" is the honest instruction, the inbox is exactly
  // where the answer is, and a Retry is offered to act on what is found.
  if (failure.timedOut) return "inbox.errorSaveTimeout";
  if (rowGone) return "inbox.errorSaveGone";
  return "inbox.errorSaveFailed";
}

/**
 * #225 — what, if anything, the notice can offer that could actually work.
 *
 * A button whose only possible outcome is the message already on screen is worse
 * than no button (!294, Duo review round 5), so the two cases where a retry is
 * known to be futile get no control at all.
 */
function writeFailureRemedy(
  failure: WriteFailure,
  rowGone: boolean,
): "reload" | "retry" | "none" {
  // Retrying re-posts an action id the running deployment has forgotten.
  if (failure.stale) return "reload";
  // Every one of these actions is `findFirst`-then-write against a row id, so a
  // row the list no longer holds makes each of them a no-op again, every time.
  // The page queries everything except archived rows, so "not in `initialItems`"
  // is deleted or archived on the server, not merely filtered off this view.
  //
  // !306, Duo review — this arm swallows `timedOut`, and that is the decision
  // rather than the oversight. A timeout does not weaken the case for withdrawing
  // the button, it strengthens it: retrying either re-posts a write that already
  // landed or matches nothing, and BOTH settle as a silent success that clears
  // the notice. A false "saved this time" is worse than the dead end it would
  // replace. `writeFailureKey` carries the other half — a message that no longer
  // offers a "trying again" this function is about to take away.
  if (rowGone) return "none";
  return "retry";
}

/**
 * #201 — bind {@link inlineNoteTyping} to a controlled input's `keydown`.
 *
 * The rule itself is pure and lives next to the parser; this is the DOM half —
 * reading the live selection, suppressing the browser's own insertion, and
 * putting the caret back once React has committed.
 *
 * ## Which fields get it, and which deliberately do not
 *
 * The two that already carry an `AddNoteButton`: the capture bar and the ✎ row
 * title editor. Those are exactly the fields whose value `splitInlineNote` reads,
 * so they are the fields where a brace MEANS something — and a `{` that
 * auto-closes in one and not the other would be the inconsistency, not the
 * coverage. Everything else on the page (the note textarea itself, the step
 * editor, the estimate input) is plain text to the parser, and auto-closing a
 * brace there would be a surprise with no payoff.
 *
 * ## `keydown`, and what it costs
 *
 * Predictive text, swipe input and autocorrect rewrite a field without emitting
 * a `keydown`, which is the standard argument for `beforeinput`. `keydown` is
 * chosen anyway, and the reason is the FAILURE MODE rather than a claim that the
 * gap cannot be reached (!306, substitute review — this used to assert that "no
 * IME, swipe path or autocorrect produces a bare `{`", which is not defensible as
 * an absolute and is least defensible on Android, where GBoard routes
 * soft-keyboard input through the IME and can report `key: "Unidentified"`).
 *
 * A keystroke this handler never sees types a literal `{`. The parser accepts
 * that — it is exactly what the field held before #201 — so the worst case is the
 * convenience not firing, never a wrong value or a lost character. `beforeinput`
 * would trade that for a mechanism whose `preventDefault` semantics on a
 * controlled React input are considerably harder to get right, to buy a case that
 * degrades gracefully. Dictation and paste produce no `keydown` at all and are
 * out of reach for the same reason and with the same consequence.
 *
 * A composition in progress is skipped, because a `{` typed mid-composition
 * belongs to the IME.
 */
function handleNoteBraceKey(
  e: ReactKeyboardEvent<HTMLInputElement>,
  setValue: (next: string) => void,
): void {
  if (e.nativeEvent.isComposing) return;
  // Cmd/Ctrl chords are shortcuts rather than text entry: Cmd+Backspace deletes
  // to the line start and Ctrl+`{` is a binding, and neither should auto-close
  // anything. This used to cite "the browser's own undo among them", which it
  // cannot be protecting — Cmd+Z reports `key: "z"`, which the rule declines on
  // its first line anyway, and `inlineNoteTyping`'s own header records that a
  // controlled React input sits outside the native undo stack regardless
  // (!306, substitute review). AltGr is NOT excluded: on several European
  // layouts it is how `{` is produced at all, and it reports as ctrl and alt
  // together.
  if (e.metaKey || (e.ctrlKey && !e.altKey)) return;
  // A modified Backspace is a word or line delete, which must stay one.
  if (e.key === "Backspace" && (e.altKey || e.ctrlKey)) return;

  // Read now: React resets `currentTarget` once the handler returns, and the
  // caret has to be placed from a microtask.
  const el = e.currentTarget;
  const next = inlineNoteTyping({
    value: el.value,
    key: e.key,
    start: el.selectionStart ?? el.value.length,
    end: el.selectionEnd ?? el.value.length,
  });
  if (next === null) return;

  e.preventDefault();
  setValue(next.value);
  // AFTER React has committed the new value. Setting the range now would aim at
  // the OLD string, and the browser clamps a range past the current length — on
  // an appended `{}` that parks the caret outside the braces. Same dialect
  // `AddNoteButton` uses, for the same reason.
  queueMicrotask(() => el.setSelectionRange(next.caret, next.caret));
}

/** True when a native drag was started by one of our rows rather than by an
 * image, a text selection, or another surface on the page. */
function isInboxDrag(source: ElementDragPayload): boolean {
  return typeof source.data[DRAG_ITEM_KEY] === "string";
}

/** Map a drop onto a bucket to a move intent (null when dropped nowhere).
 * Pure, and shared by every drop path, so `dragEndToMove(id, null)` is what a
 * cancelled drag looks like as well as a drop into empty space. */
export function dragEndToMove(
  activeId: string,
  overId: string | null,
): { itemId: string; target: BucketId } | null {
  if (!overId || !isBucketId(overId)) return null;
  return { itemId: activeId, target: overId };
}

/** Maps a row's connection status + its own "ready" state (what it'd show if
 * Google were connected) onto the 📅 control's actual state — not-configured
 * and needs-reconnect override every row the same way. Exported so other
 * schedule-control call sites (e.g. the task working-view's <TaskSchedule>,
 * #8 follow-up) reuse this exact owner/guest logic instead of reimplementing
 * it. */
export function scheduleState(
  google: GoogleConnStatus,
  ready: ScheduleControlProps["state"],
): ScheduleControlProps["state"] {
  if (!google.configured) return "connect";
  if (google.needsReconnect) return "reconnect";
  // Configured but the owner never completed OAuth → offer Connect, not a live
  // 📅 that would fail (Duo review: the `connected=false` case was missing).
  if (!google.connected) return "connect";
  return ready;
}

// Mirrors the failure-reason copy `breakdown-chat.tsx` already uses for the
// same Google Tasks actions — `reconnect_required` is handled separately
// (swaps the row's control to the Reconnect link instead of showing text).
// Exported for reuse by <TaskSchedule> (#8 follow-up) — same single source
// of truth as `scheduleState` above.
export const SCHEDULE_ERROR_MESSAGES: Record<string, string> = {
  not_configured:
    "Google isn't configured (set GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET).",
  not_connected: "Google Tasks isn't connected.",
  no_reclaim_list: "Couldn't find your Reclaim-synced Google Tasks list.",
  no_steps: "No steps to send.",
  not_found: "This task couldn't be found.",
};

/**
 * The ▾ entry's label for a row's Schedule slot, from the control's state.
 *
 * ICS states carry "Add to calendar"; a usable Google path carries the full
 * "Schedule to calendar (send to Google Tasks)".
 *
 * #253 — the two UNUSABLE Google states are named here too, and that is new. They
 * used to be unreachable: `ScheduleControl`'s `connect`/`reconnect` branch returned
 * an inline `Connect Google →` link before it ever looked at `label`. The `menu`
 * variant now renders a navigation entry instead and takes its text from here, so
 * every state this function is asked about has an answer — and each one names the
 * destination first, then why it cannot happen yet.
 */
const isIcsState = (s: ScheduleControlProps["state"]) =>
  s === "ics_ready_steps" || s === "ics_needs_duration";
const scheduleMenuLabel = (
  s: ScheduleControlProps["state"],
  voice: Voice,
): string => {
  if (isIcsState(s)) return t("action.addToCalendar", voice);
  if (s === "connect") return t("action.scheduleNotConnected", voice);
  if (s === "reconnect") return t("action.scheduleReconnect", voice);
  return t("action.schedule", voice);
};

export function InboxView({
  initialItems,
  settings,
  google = null,
  scheduleIntents,
  welcomeVisible,
  resumeStep,
  newAccount = null,
  notifyAging = true,
  shoppingSummary = null,
  now: initialNow,
}: {
  initialItems: Item[];
  settings: AgingSettings;
  google?: GoogleConnStatus | null;
  /**
   * #106 — the Schedule menu's prefill per taskId (persisted-or-default),
   * resolved once on the server for every row that can reach `ready_steps`. A
   * missing entry keeps that row's 📅 firing immediately, so the control is never
   * dead; guests get none, exactly as they get no Google control.
   */
  scheduleIntents?: Record<string, ScheduleIntent>;
  /** First-run welcome card (Phase 5, #8) — shown above everything else until
   * the workspace dismisses it (or while previewing the demo first-run state). */
  welcomeVisible: boolean;
  /** Most-recent resumable step (an open, un-ended focus session), computed
   * server-side by the Inbox page. Null when there's nothing to resume — or
   * while previewing the demo first-run empty state, which never shows it. */
  resumeStep: { id: string; text: string } | null;
  /**
   * #111 — the account to NAME in the empty state, set only when this workspace
   * has never held anything. Null otherwise, and null is what an omitted prop
   * means, so an inbox that is merely empty keeps "Inbox zero".
   *
   * The identity itself rather than a boolean, mirroring `<AuthActions>`: this
   * state cannot be rendered without the account it exists to name, so the two
   * cannot drift apart. `AccountIdentity` is the display boundary — a handle, a
   * provider display name and a role, never an id and never an email — so this
   * is safe to hand to a client component (see identity.ts).
   */
  newAccount?: AccountIdentity | null;
  /** Phase 6 — gates the aging→browser-notification firing (permission still applies). */
  notifyAging?: boolean;
  /**
   * #199 — the shopping-list summary line, or null for "show nothing".
   *
   * A COUNT, resolved on the server from the items themselves on the request that
   * rendered this page — never a stored number, because the summary row deliberately
   * holds no number (src/lib/shopping-summary.ts). One nullable prop rather than a
   * count plus a boolean: "show nothing" has four causes on the server (no row, a
   * dismissed row, an empty list, a nonsensical count) and this component has no
   * business branching on which.
   *
   * Optional, defaulting to null, so a caller that predates it — or one whose
   * workspace has the feature off — renders the inbox exactly as it did before.
   * It is deliberately NOT part of `initialItems`: see the note on
   * ShoppingSummaryCard for why a generated line must not enter the buckets.
   */
  shoppingSummary?: { count: number } | null;
  /**
   * #105 — the request-time clock, stamped ONCE on the server and handed down,
   * exactly as the Library page hands `now` to `<LibraryRows>`. It seeds the
   * live clock below so the server's markup and the browser's hydration are
   * rendered from the same instant.
   *
   * Required, not optional: it is the only way a caller can be stopped from
   * reintroducing the fault. Seeding the clock inside this component meant the
   * server evaluated it at request time and the client evaluated it again at
   * hydration time, so every row younger than a minute rendered "Ns ago" from
   * two different clocks. React bails out of a text mismatch (minified error
   * #418) by regenerating the tree from the ROOT, which rebuilds <html>'s class
   * list from the RSC payload — and that payload never carries the `dark` the
   * pre-hydration script wrote, so a returning dark-mode user watched the theme
   * fall off the inbox. Same fault, same fix as #75 on /settings.
   */
  now: number;
}) {
  const router = useRouter();
  const voice = useVoice();
  /**
   * #169 — TWO pending signals, because there are two different questions here
   * and one flag was answering both, wrongly.
   *
   * `refreshing` is list-wide, and honest about it: every wrapper below ends in
   * `router.refresh()`, which redraws the whole list, so dimming the whole list
   * while one is in flight is exactly what it means.
   *
   * `schedulingIds` is keyed by item id and is the ONLY thing the 📅 controls
   * read. It exists because `refreshing` used to be wired straight to
   * `disabled` on every row's Schedule control — and 20 of the call sites that
   * set it go through the generic `run()` below: rename, complete, snooze,
   * delete, freshen, keepAsTask, reopen, dismissPrompt. So renaming one item
   * disabled every Schedule button in the list, and a press landing in that
   * window was discarded with no error and no explanation. `row-actions.tsx`
   * documents the prop as "a schedule call for THIS row"; now the parent
   * honours it.
   *
   * **Concurrent Schedule pushes get no broader guard, deliberately.** #169
   * asked for that decision to be made rather than inherited, and the answer is
   * no:
   *
   *   - Two rows pushing at once write disjoint records.
   *     `pushStepsToGoogleTasks(taskId)` and `scheduleSingleTask(itemId)` upsert
   *     against each step's own persisted `googleTaskId` (`upsertGoogleTask`,
   *     #104), so there is no shared row to race over and no duplicate calendar
   *     block to create — which is the failure a lock would exist to prevent.
   *   - The one genuinely workspace-wide failure, `reconnect_required`, already
   *     has a workspace-wide response: `setReconnectRequired` swaps EVERY row's
   *     control to the Reconnect link. A second, weaker lock aimed at the same
   *     condition would only obscure the one that works.
   *   - The remaining shared resource is the OAuth access token, which
   *     `getValidAccessToken` may refresh mid-push. That is a server-side
   *     concurrency question reachable from any two requests — a second tab,
   *     the focus lane, a scheduled action — so a lock inside one client list
   *     component could not arbitrate it, and having one would imply a
   *     guarantee that is not there.
   *
   * The hazard the prop was actually written for — double-submitting the SAME
   * row — is per-control by definition, and that is what this guards.
   */
  const [refreshing, startTransition] = useTransition();
  const [schedulingIds, setSchedulingIds] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  // Never mutates the previous Set: React bails out of a re-render when the
  // reference is unchanged, which would strand the row's control disabled.
  const markScheduling = (itemId: string, active: boolean) =>
    setSchedulingIds((prev) => {
      if (prev.has(itemId) === active) return prev;
      const next = new Set(prev);
      if (active) next.add(itemId);
      else next.delete(itemId);
      return next;
    });
  const [text, setText] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  // Transient "captured ✓" indicator shown after a successful capture submit.
  const [justCaptured, setJustCaptured] = useState(false);
  const captureTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    return () => {
      if (captureTimeoutRef.current) clearTimeout(captureTimeoutRef.current);
    };
  }, []);

  /**
   * #210 — the capture whose write did not land.
   *
   * Deliberately not `refreshing`, which all ~20 `run()` call sites raise:
   * renaming a row would otherwise make the capture notice's Retry read as busy
   * and announce a save that has nothing to do with it — the same over-broad-flag
   * mistake #169 fixed for the 📅 controls. And deliberately not a
   * component-wide `capturing` boolean either; the in-flight marker lives on the
   * record it guards (`CaptureFailure.retrying`), for the reason documented
   * there.
   *
   * ONE failure slot rather than a queue, and the boundary that buys is sharper
   * than a first draft of this note claimed (Duo review round 7, then the specs
   * that were written to defend it and falsified it instead):
   *
   * **A second outstanding failure displaces the first, and the first's words are
   * then in neither place.** The draft said the notice and the field between them
   * hold two, and they do not — submitting anything empties the field, so the
   * second failure takes the notice AND repopulates the field with its own words.
   * There is no arrangement in which both survive.
   *
   * Not closed here, and not closed by accident. Every fix available inside this
   * issue trades the loss for a different silence: keeping the older record
   * leaves the newer failure unannounced, and rescuing the older words into the
   * field puts text the user did not just type where they are looking. A
   * persisted queue needs neither, and #210 scopes "a real offline session" to
   * #175 — consecutive failures being exactly that. The boundary is recorded on
   * both issues, and `capture-failure-pile-up` in the spec file pins it as
   * executable behaviour rather than a comment nothing checks, which is how the
   * wrong version of this paragraph survived in the first place.
   *
   * What is guaranteed at every point, however many fail: the notice names words
   * that did not save, those words are in the field, and a Retry is offered.
   * Never an emptied field and a false confirmation, which is the bug itself.
   */
  const [captureFailure, setCaptureFailure] = useState<CaptureFailure | null>(
    null,
  );
  // #210 — ties the failure message to the notice's control, so the reason is
  // announced with the remedy however the announcement races. See captureNotice.
  const captureErrorId = useId();
  const captureSavingId = useId();
  const retryCtaRef = useRef<HTMLButtonElement | null>(null);
  /**
   * #210, Duo review round 3 — hand focus back when the notice unmounts.
   *
   * Set only when the notice's own Retry is the focused element at the moment a
   * retry succeeds, because that is the only case where the unmount takes focus
   * away from the user (WCAG 2.4.3). A ref rather than state: it is a one-shot
   * instruction to the effect below, not something anything renders, and putting
   * it in state would schedule a render just to say "no focus move needed".
   */
  const returnFocusToInput = useRef(false);
  useEffect(() => {
    if (captureFailure || !returnFocusToInput.current) return;
    returnFocusToInput.current = false;
    // In an effect rather than beside the state update: the button is still
    // mounted then, so focusing the input would be undone by the unmount.
    inputRef.current?.focus();
  }, [captureFailure]);

  // Per-row inline delete confirm — only one row confirms at a time.
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  // Which multi-step row (if any) has its inline TaskSteps list expanded.
  const [expandedId, setExpandedId] = useState<string | null>(null);

  // Which saved-for-later row (if any) has its inline sorting options open.
  const [savedOptionsId, setSavedOptionsId] = useState<string | null>(null);

  // Which row (any bucket) is editing its title via the ✎ pencil.
  const [editingId, setEditingId] = useState<string | null>(null);

  // #186 — the inline-note rule, as the ✎ editor's DESCRIPTION. Declared beside
  // the state it serves (and before `titleEditor` reads it) rather than with the
  // other two ids further down. The node it names is rendered `hidden` at the
  // foot of the board: a dense row has nowhere to put a visible hint line, and
  // one per editing row would be noise, but an `aria-describedby` target
  // contributes its text whether or not it is painted — the same dialect
  // `MOVE_INSTRUCTIONS` uses on this surface.
  const noteHintId = useId();

  // Which completed multi-step row (if any) has its per-step Reopen picker open.
  const [reopenPickerId, setReopenPickerId] = useState<string | null>(null);

  // Live clock for bucketing + relative ages. Seeded from the server's
  // request-time stamp (#105) — NOT from Date.now(), which is a second reading
  // of the wall clock and put the first client render a tick ahead of the
  // markup it was supposed to hydrate. Only the FIRST render is pinned; the
  // interval below keeps ages ticking from here on.
  const [now, setNow] = useState(initialNow);
  useEffect(() => {
    const ms = Math.min(effectiveAgingMs(settings), 15_000);
    const id = setInterval(() => setNow(Date.now()), Math.max(1000, ms / 4));
    return () => clearInterval(id);
  }, [settings]);

  // "/" focuses the capture bar (unless already typing in a field).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      const typing =
        el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA");
      if (e.key === "/" && !typing) {
        e.preventDefault();
        inputRef.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Notifications: register the service worker + read permission through a
  // subscription — the store notifies after our own permission requests, so
  // no setState-in-effect is needed to keep the banner in sync.
  const permission = useSyncExternalStore(
    subscribeNotificationPermission,
    notificationPermission,
    () => "default" as const,
  );
  const notifiedRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    registerServiceWorker();
  }, []);

  const enableReminders = () => {
    void requestNotificationPermission();
  };

  const {
    needsReview,
    singleTask,
    multiStep,
    savedLater,
    completed,
    completedTodayCount,
  } = bucketItems(initialItems, now);

  // #111 — re-checked here rather than trusted from the prop alone. The server
  // sets `newAccount` for a workspace with nothing in it, but the client can get
  // ahead of that: capture something and this component re-renders with a row
  // while the prop still says "new". "This is a new account" printed next to the
  // thing you just typed is worse than the copy it replaced. Note it is EVERY
  // item, not just `needsReview` — an empty review queue on an account holding
  // triaged to-dos is a cleared queue, which is what inbox.zero is for.
  const brandNewAccount = initialItems.length === 0 ? newAccount : null;

  const untriagedCount = needsReview.length;
  // #105 — from the render's own clock, not a fresh Date.now(): this count is
  // RENDERED ("· 3 aging 🟡" in NavBadge), so a threshold crossed between the
  // server's render and hydration is another text mismatch. `demoOverrideSeconds`
  // puts that threshold seconds away rather than half an hour.
  const agingCount = needsReview.filter((i) =>
    isAging(i.createdAt, settings, now),
  ).length;

  // Fire a desktop reminder once per aging, not-yet-reminded item, then persist
  // remindedAt so it doesn't repeat (guarded client-side by notifiedRef too).
  // The inline 24h "still needed?" prompt is the canonical review nudge, so an
  // item whose prompt has been dismissed is excluded here too — dismissing it
  // once means "stop bugging me about this," not just "don't show the banner."
  useEffect(() => {
    if (permission !== "granted") return;
    if (!notifyAging) return; // Phase 6 — per-type notification preference
    const due = needsReview.filter(
      (i) =>
        isAging(i.createdAt, settings) &&
        i.remindedAt == null &&
        i.promptDismissedAt == null &&
        !notifiedRef.current.has(i.id),
    );
    if (due.length === 0) return;
    due.forEach((i) => notifiedRef.current.add(i.id));
    (async () => {
      for (const i of due) {
        await showReminder("🟡 Still needs triage", i.text);
        await markReminded(i.id);
      }
      router.refresh();
    })();
  }, [needsReview, permission, settings, router, notifyAging]);

  /**
   * ── #225: every row write, and one place that says when one did not land ────
   *
   * `run()` used to be four lines with no `try`: a rejected server action
   * surfaced as an unhandled rejection inside the transition and the user was
   * told nothing — the row simply did not change. There is no `error.tsx`
   * anywhere in `src/` to catch it at the framework level either. Twenty call
   * sites across eight actions, all silent.
   *
   * The fix is #210's capture notice and !294's shopping notice applied here
   * rather than reinvented: the same three-way split from
   * `server-action-failure.ts`, the same `role="alert"` notice quoting the
   * subject, the same `aria-disabled`-not-`disabled` Retry. Three surfaces
   * failing in three different shapes would be worse than any one of them.
   *
   * ## One notice slot, at the top, rather than one per row
   *
   * The decision #225 asks for, and the inbox is genuinely harder than the
   * shopping list here: it is a long, bucketed list, its sections truncate behind
   * "See all", and the Done bucket shows a window rather than everything. So a
   * per-row message would be **silent exactly when the row is not rendered** —
   * which includes the case a delete's failure is most likely to arrive in — and
   * it would need injecting at five separate row renderers, when the whole point
   * of hardening `run()` is that a new call site inherits the behaviour.
   *
   * One slot works because the notice **quotes the item's own text**: "which row"
   * is answered without the row being on screen. What one slot does NOT solve on
   * its own is the notice itself being off screen, and that is what the focus
   * move below is for — a focused control is scrolled into view by the browser,
   * so the message and the focus ring arrive together. Leaving focus on a control
   * that has just scrolled away would fail WCAG 2.4.7 as well as hiding the error.
   *
   * Deliberately NOT a per-row `aria-invalid` pointing at a shared message node,
   * which is the WCAG 3.3.1 failure !294 found one level down: row B's field
   * describing row A's error.
   *
   * ## The double-press guard
   *
   * A failed write is indistinguishable from a press that did not register, so
   * the natural response is to press again — which, unguarded, fires the write a
   * second time. `inFlight` keys that per logical target, the same lesson
   * `schedulingIds` applies per row to the 📅 controls (#169). The one exception
   * is a rename, whose words are part of what makes it a repeat — see
   * {@link writeGuardKey}, which is what the entries below are actually keyed by.
   *
   * The second press is absorbed rather than discarded, and the distinction
   * matters because #169's other harm is a press that vanishes with no
   * explanation: the identical write to the identical target is already running,
   * so pressing again asks for something that is already happening, and
   * `refreshing` is already dimming the list while it does. #210's capture path
   * makes the same call for the same reason.
   *
   * The three Task-CREATING writes are why this is not merely tidy — `keepAsTask`,
   * `startBreakdown` and `ensureFocusStep` each make a Task and then point the
   * item at it, so two in flight left an orphaned Task row that nothing could
   * reach. **This guard is not what closes that**, and saying so is the point:
   * it is per-press and per-client, so it cannot see the Retry this notice offers
   * after a ten-second timeout, and it cannot span two tabs at all. All three are
   * guarded in the write itself now (see their doc comments in
   * `src/app/actions/braindump.ts` and `breakdown.ts`); the guard here just stops
   * the ordinary double-tap ever getting that far.
   *
   * ## What this still cannot see
   *
   * **All eight actions can decline without throwing** — each returns early when
   * the row is gone, whether from a `findFirst` in front of the write or, for the
   * three above, from the guarded write's own zero-row answer; and
   * `freshenItem`/`dismissPrompt` are bare `updateMany`s that report nothing when
   * they match zero rows. On the wire a decline is identical to a success, so
   * `run()` cannot tell them apart; closing that properly means the eight actions
   * returning a result the way `shopping.ts` does, which is a signature change to
   * `src/app/actions/braindump.ts` consumed by `library-rows.tsx`,
   * `focus-lanes.tsx`, `focus-timer.tsx`, `google-schedule.ts` and
   * `focus-launcher.ts`. That is its own change, not this one.
   *
   * What IS closed here is the only decline reachable in production: the row is
   * gone. `initialItems` comes from the dynamic page, so the rendered list losing
   * a row IS the server saying so — see `writeFailureRowGone`, which withdraws a
   * Retry that could only be refused again.
   */
  const [writeFailure, setWriteFailure] = useState<WriteFailure | null>(null);
  // Declared here rather than beside the drag dispatcher that also reads it: the
  // notice's `rowGone` test needs it, and that test has to be in scope before the
  // focus effect below can depend on the remedy it decides.
  const itemsById = new Map(initialItems.map((i) => [i.id, i]));
  /**
   * #225 — a failure aimed at a row the rendered list no longer holds.
   *
   * Derived from `initialItems` rather than tracked, because a second copy of a
   * fact is how the page ends up disagreeing with itself. The inbox page is
   * dynamic, so its losing a row IS the server saying the row has gone — which is
   * the one silent decline `run()` can see without the eight actions returning a
   * result. It changes both the message and whether a control is offered at all.
   */
  const writeFailureRowGone =
    writeFailure !== null && !itemsById.has(writeFailure.target.id);
  /** `null` when there is no notice; otherwise which control it offers. A
   *  dependency of the focus effect below, because the control being withdrawn is
   *  one of the two things that can strand focus on <body>. */
  const writeRemedy = writeFailure
    ? writeFailureRemedy(writeFailure, writeFailureRowGone)
    : null;
  // Ties the failure message to the notice's control, so the reason is announced
  // with the remedy however the announcement races.
  const writeErrorId = useId();
  // The retry's wait. It sits on the visually hidden live region BESIDE the
  // notice, not on the visible line inside it, so the one node a screen reader
  // can reach is also the one the CTA's `aria-describedby` points at (!306, Duo
  // review; the same correction #218 made to the capture notice above).
  const writeSavingId = useId();
  const writeCtaRef = useRef<HTMLButtonElement | null>(null);
  /** The notice's message, and the focus target of last resort — see the effect
   *  below and `writeFailureRemedy`'s `"none"` arm. */
  const writeNoticeRef = useRef<HTMLParagraphElement | null>(null);
  /**
   * Which targets have a write outstanding, how many writes have been started,
   * how many are still running, and the newest attempt at each target that
   * SETTLED — landed or failed, both, because the question it answers is "has
   * this target moved on since my attempt started?" and either answer means yes.
   *
   * Refs, not state: nothing renders any of them, and a counter that triggered a
   * render would re-run the very effects below that move focus. That is the one
   * deliberate difference from `schedulingIds`, which is state precisely because
   * `row-actions.tsx` renders it as `pending`.
   *
   * `settledAt` exists because two writes at the same target where the older one
   * loses the race would otherwise end with a notice about a write that
   * succeeded — and, once it was told about failures too (!306, Duo review),
   * with the older of two failures overwriting the newer one's notice. It is
   * emptied whenever nothing is outstanding, because at that instant nothing can
   * read it — otherwise a long session accumulates one entry per row ever
   * touched.
   */
  const inFlight = useRef(new Set<string>());
  const writeAttempts = useRef(0);
  const writesOutstanding = useRef(0);
  const writeSettledAt = useRef(new Map<string, number>());
  /**
   * What the notice on screen is currently about, readable from the async write
   * paths. Their closure holds the `writeFailure` from the press that started
   * them, which is by definition not the record a LATER failure put on screen.
   *
   * Not a one-shot instruction like the two refs below it — a mirror, kept in an
   * effect rather than assigned during render so a render React discards leaves
   * no fact behind. It can therefore LAG the state by a commit, which is safe in
   * the one place that reads it: that reader also requires the notice's control
   * to be holding focus, and a notice that has not been committed has no control
   * to hold it.
   */
  const displayedFailure = useRef<WriteFailure | null>(null);
  useEffect(() => {
    displayedFailure.current = writeFailure;
  }, [writeFailure]);
  /**
   * One-shot instructions to the two effects below. Refs rather than state for
   * the reason `returnFocusToInput` gives: they are messages to an effect, not
   * something anything renders, and putting them in state would schedule a render
   * just to say "no focus move needed".
   */
  const takeFocusForWrite = useRef(false);
  /**
   * Where focus goes when the notice unmounts; `null` when no hand-off is
   * pending.
   *
   * A BOX rather than a bare element, because "armed, with nowhere in particular
   * to go" is a real state and has to be distinguishable from "not armed". A
   * press whose control the browser never focused leaves no origin — and that is
   * every mouse press in WebKit, which blurs whatever held focus and puts it on
   * `<body>` rather than on the button (measured; Chromium reports the button for
   * the same gesture). Collapsing the two states left that user on `<body>` when
   * the notice they had been sent to unmounted, which is the WCAG 2.4.3 fault
   * this hand-off exists to avoid rather than to create.
   */
  const returnFocusAfterWrite = useRef<{ origin: HTMLElement | null } | null>(
    null,
  );
  useEffect(() => {
    if (!writeFailure) return;
    // Two reasons to move focus here, and the second is not a duplicate of the
    // first. **Taking** it is the one-shot instruction the failure path leaves.
    // **Repairing** it is what happens when the control the user was standing on
    // is withdrawn — the row goes away mid-notice, the Retry is removed because
    // it could only be refused again, and the browser drops them to <body>
    // (WCAG 2.4.3). The dependency list is what keeps the second from being
    // grabby: it re-runs when the remedy changes, not on every render, so
    // clicking the page background does not pull focus back.
    if (!takeFocusForWrite.current && document.activeElement !== document.body)
      return;
    takeFocusForWrite.current = false;
    // In an effect rather than beside the state update: the notice does not exist
    // yet at that point — it is what this state update renders. The message is
    // the fallback target for exactly the withdrawn-control case, which is why it
    // carries `tabIndex={-1}`: a notice with nothing focusable in it cannot
    // receive the hand-off at all.
    (writeCtaRef.current ?? writeNoticeRef.current)?.focus();
  }, [writeFailure, writeRemedy]);
  useEffect(() => {
    const handOff = returnFocusAfterWrite.current;
    // A notice REPLACED rather than removed voids the hand-off armed for the one
    // it displaced: React re-uses the control the user is standing on instead of
    // unmounting it, so nothing was stranded, and moving focus now would be a
    // steal rather than a repair (!306, Duo review).
    if (writeFailure) {
      returnFocusAfterWrite.current = null;
      return;
    }
    if (!handOff) return;
    returnFocusAfterWrite.current = null;
    // Two ways to have nowhere to go back to, and dropping the user on <body> is
    // the WCAG 2.4.3 fault in both: a row removed by the refresh cannot be
    // focused, and a press the browser never focused left no origin at all. The
    // capture field is the notice's nearest surviving neighbour.
    if (handOff.origin?.isConnected) handOff.origin.focus();
    else inputRef.current?.focus();
  }, [writeFailure]);

  /**
   * The element the press came from, or null when there is nothing worth
   * returning to. `<body>` is excluded on purpose: it is what `activeElement`
   * reports when focus is nowhere, and "return focus to the document" is not a
   * hand-off.
   */
  const focusOrigin = (): HTMLElement | null => {
    const el = document.activeElement;
    return el instanceof HTMLElement && el !== document.body ? el : null;
  };

  /**
   * Raise or drop `retrying`, and only on a record about this attempt's own
   * write — an older attempt settling must not rewrite a record about something
   * else.
   *
   * Keyed on {@link writeGuardKey} rather than the target, which is !306's Duo
   * review and a correction to what stood here. The old comment argued that no
   * sequence test was needed because "a record for this target can only be
   * showing `retrying` because THIS retry raised it" — true only while one write
   * per target can be in flight, and `writeGuardKey` is the line that stopped
   * that being so. Two retries of one row to DIFFERENT words are two writes at
   * the same `{ id, field: "text" }` target, and on a target match the older
   * one's cleanup put the newer one's notice back to idle underneath it. A Retry
   * that reads idle invites a press, and the guard then absorbs that press
   * because the words really are still in flight — a silent no-op handed out by
   * a control that had just said it was free, which is the class #225 exists to
   * remove. The guard key is the identity of an in-flight write, so matching on
   * it keeps this in step with whatever that function decides.
   *
   * Still no sequence test, and now that is sound: an entry is held in
   * `inFlight` for exactly the life of its attempt, so one guard key cannot have
   * two attempts running at once to be confused about.
   */
  const markWriteRetrying = (guardKey: string, retrying: boolean) =>
    setWriteFailure((prev) =>
      prev &&
      writeGuardKey(prev.target, prev.subject) === guardKey &&
      prev.retrying !== retrying
        ? { ...prev, retrying }
        : prev,
    );

  /** Drop the notice, if this write is the one it was waiting on.
   *  @see answersFailure — the same predicate the focus hand-off is gated on, so
   *  the removal and the hand-off cannot disagree about what is happening. */
  const clearWriteFailureFor = (target: WriteTarget, seq: number) =>
    setWriteFailure((prev) =>
      answersFailure(prev, target, seq) ? null : prev,
    );

  const attemptWrite = (
    fn: () => Promise<unknown>,
    target: WriteTarget,
    subject: string,
    {
      fromRetry,
      origin,
      onLanded,
    }: {
      fromRetry: boolean;
      origin: HTMLElement | null;
      onLanded?: (result: unknown) => void;
    },
  ) => {
    const key = writeTargetKey(target);
    // @see writeGuardKey — the same target for everything except a rename, which
    // is guarded on its words too because they are what makes it a new request.
    const guardKey = writeGuardKey(target, subject);
    // Both of these are URGENT and deliberately outside the transition — see
    // runSchedule (#169): React 19 holds an async transition's own state updates
    // until the action settles, so a guard raised inside one would first paint at
    // the moment it stopped being true. A ref needs no paint at all, which is why
    // the guard is one; the retry flag is state and so must be raised here.
    if (inFlight.current.has(guardKey)) return;
    inFlight.current.add(guardKey);
    if (fromRetry) markWriteRetrying(guardKey, true);
    return startTransition(async () => {
      const seq = (writeAttempts.current += 1);
      writesOutstanding.current += 1;
      /** A newer write at this same target has already settled — landed OR
       *  failed — so whatever this one has to say about it is out of date. */
      const overtaken = () => (writeSettledAt.current.get(key) ?? 0) > seq;
      /**
       * This attempt is now the newest one to have settled at this target.
       *
       * `max`, because an attempt that started earlier can still settle later —
       * and on the failure path below `overtaken()` has already established that
       * nothing newer is recorded, so the `max` is a statement of the invariant
       * rather than a live comparison.
       */
      const markSettled = () =>
        writeSettledAt.current.set(
          key,
          Math.max(writeSettledAt.current.get(key) ?? 0, seq),
        );
      try {
        let landed = false;
        let result: unknown;
        try {
          result = await withActionTimeout(fn(), INBOX_ACTION_TIMEOUT_MS);
          landed = true;
        } catch (error) {
          if (overtaken()) return;
          // !306, Duo review — the failure path has to claim the target just as
          // the success path does, and this line is the whole fix. `overtaken`
          // used to be told about landings only, so it stopped a stale SUCCESS
          // clearing a fresher failure notice while letting a stale FAILURE
          // overwrite one: two edits of one row to different words are two
          // writes in flight at the same target (see `writeGuardKey`), and when
          // the older lost the race the user was left reading the wrong words
          // and the wrong reason, with Retry armed to re-post an edit they had
          // already superseded. Claiming it HERE rather than testing the notice
          // in `setWriteFailure` is what makes the guard hold when both failures
          // settle before React commits: `displayedFailure` is a mirror kept in
          // an effect and has not caught up yet at that point, whereas this map
          // is written synchronously. It also drops the attempt whole, so
          // `takeFocusForWrite` below is never raised for a record that is not
          // going to be shown.
          markSettled();
          // Only take focus when the user has not moved it since the press. They
          // may have gone to the capture field during a ten-second hang, and
          // interrupting them mid-sentence is #210's argument for why the capture
          // notice never steals focus at all.
          //
          // There used to be a second arm here — `!origin.isConnected &&
          // document.activeElement === document.body`, for the case the pressed
          // control was removed under them. It is gone, and removing it changes
          // no behaviour (!306, substitute review, which found that mutating it
          // away left the whole suite green and then found out why). The effect
          // that consumes this flag already treats `activeElement ===
          // document.body` as sufficient on its own, so the arm was redundant
          // wherever it agreed — and actively wrong where it did not. It was
          // evaluated HERE, at settle time, while the effect runs after the
          // commit: a user who moved focus in between would have had it taken
          // anyway, by a flag whose stated purpose is to leave them alone.
          // Deciding it once, at the later moment, is both simpler and correct.
          takeFocusForWrite.current =
            origin !== null && document.activeElement === origin;
          setWriteFailure({
            fn,
            target,
            subject,
            seq,
            origin,
            onLanded,
            stale: isStaleActionError(error),
            timedOut: error instanceof ActionTimeoutError,
            // A fresh record, so the retry flag starts down: this attempt is
            // over, whatever it was.
            retrying: false,
          });
        }
        if (!landed) return;
        markSettled();
        // Read while the notice still exists: its unmount is about to drop focus
        // to <body> if the user is standing on it, which they are if they pressed
        // Retry. Two conditions, and the second is !306's review finding — the
        // control has to be holding focus AND this write has to be the one the
        // notice is waiting on. Twenty independent row controls means writes to
        // different rows overlap routinely, and a success at ANOTHER target
        // leaves the notice up: arming on it pointed the hand-off at a control
        // the user was never sent away from, and spent it on whatever cleared the
        // notice later.
        const displayed = displayedFailure.current;
        if (
          answersFailure(displayed, target, seq) &&
          writeCtaRef.current !== null &&
          writeCtaRef.current === document.activeElement
        ) {
          // The notice's OWN record rather than this call's `origin`: the same
          // object on the retry path, and where the user was standing before the
          // notice pulled them in is the thing the hand-off is for.
          returnFocusAfterWrite.current = { origin: displayed.origin };
        }
        // Any notice about THIS target, not just the one this closure raised: a
        // fresh press of the row's own control is how a user actually retries,
        // and a banner outliving the write it is about is !294's round-6 finding.
        clearWriteFailureFor(target, seq);
        // Deliberately not on the failure path: the write did not happen, so
        // there is nothing new to fetch, and a refresh that itself failed would be
        // a second unreported error. Outside the inner `try` for the reason !290
        // round 8 found — the row is written, so a refresh that throws is a stale
        // list, not a lost write, and must never be reported as one. The same
        // reasoning covers `onLanded`, which stands in for the refresh on the two
        // writes that navigate instead (see {@link WriteFailure.onLanded}).
        //
        // Its OWN `catch`, and swallowing on purpose (!306, substitute review).
        // Being outside the inner `try` made "never reported as a lost write"
        // true, but it made it true by letting the throw leave the transition
        // entirely — an unhandled rejection with no `error.tsx` anywhere in
        // `src/` to catch it, which is the precise failure mode this issue
        // exists to remove, arriving from the code removing it. There is nothing
        // to tell the user that would be both true and useful: the write landed,
        // so "couldn't save" is a lie, and the only casualty is a list that is
        // one fetch stale and re-fetches on the next interaction. So it is
        // swallowed where a reader can see the decision instead of inferring it
        // from a missing `catch`.
        try {
          if (onLanded) onLanded(result);
          else router.refresh();
        } catch {
          // Intentionally empty — see above.
        }
      } finally {
        // Must run on every exit including a throw: a target left in `inFlight`
        // is a control that silently does nothing for the rest of the session,
        // and a retry flag left up is a Retry button that reads permanently busy.
        inFlight.current.delete(guardKey);
        if (fromRetry) markWriteRetrying(guardKey, false);
        writesOutstanding.current -= 1;
        if (writesOutstanding.current === 0) writeSettledAt.current.clear();
      }
    });
  };

  /**
   * Every row write goes through here. `target` and `subject` are required rather
   * than optional so a new call site cannot inherit the machinery while silently
   * opting out of the part that makes the notice mean something.
   */
  const run = (
    fn: () => Promise<unknown>,
    target: WriteTarget,
    subject: string,
    onLanded?: (result: unknown) => void,
  ) =>
    attemptWrite(fn, target, subject, {
      fromRetry: false,
      origin: focusOrigin(),
      onLanded,
    });

  const retryWrite = () => {
    if (!writeFailure || writeFailure.retrying) return;
    attemptWrite(
      writeFailure.fn,
      writeFailure.target,
      writeFailure.subject,
      // The origin is the control the ORIGINAL press came from, not the Retry
      // button: the Retry is about to unmount, and handing focus back to it would
      // be handing it to nothing.
      {
        fromRetry: true,
        origin: writeFailure.origin,
        // Carried through, so a retry that lands navigates exactly as the first
        // press would have. Dropping it here would save the row and leave the
        // user on the inbox with no sign anything had happened.
        onLanded: writeFailure.onLanded,
      },
    );
  };

  // Per-row 📅 error text (cleared on the row's next attempt); reconnect_required
  // is a workspace-wide condition, so it swaps every row's control to the
  // Reconnect link rather than just showing an error message on one row.
  const [scheduleErrors, setScheduleErrors] = useState<Record<string, string>>(
    {},
  );
  const [reconnectRequired, setReconnectRequired] = useState(false);
  // Already null for guests (owner-gated at the server boundary), so this directly
  // encodes whether these rows lead with Google (owner) or ICS (guest). The
  // needsReconnect override is workspace-wide (see reconnectRequired above).
  const effectiveGoogle: GoogleConnStatus | null = google
    ? { ...google, needsReconnect: google.needsReconnect || reconnectRequired }
    : null;

  const runSchedule = (
    itemId: string,
    fn: () => Promise<
      { ok: true } | { ok: false; reason: string; message?: string }
    >,
  ) => {
    // #169 — both of these are URGENT and deliberately outside the transition.
    // React 19 holds an async transition's own state updates until the action
    // settles, so a flag raised inside it would first paint at the moment it
    // stopped being true: a double-submit guard that guards nothing, and a
    // stale error still on screen for the whole round trip. The transition is
    // for the `router.refresh()` that follows, which is what it is good at.
    markScheduling(itemId, true);
    setScheduleErrors((prev) => {
      if (!(itemId in prev)) return prev;
      const next = { ...prev };
      delete next[itemId];
      return next;
    });
    return startTransition(async () => {
      try {
        const res = await fn();
        if (res.ok) {
          router.refresh();
          return;
        }
        if (res.reason === "reconnect_required") {
          setReconnectRequired(true);
          // Every row's control just swapped to the Reconnect link, so any
          // per-row schedule error left from an earlier attempt is now stale —
          // clear them all rather than show a red error beside a Reconnect
          // prompt (Duo review).
          setScheduleErrors({});
          return;
        }
        setScheduleErrors((prev) => ({
          ...prev,
          // Prefer the action's own message — e.g. pushStepsToGoogleTasks's
          // no_reclaim_list failure lists the available lists, which is more
          // useful than the generic dictionary copy for the same reason.
          [itemId]:
            res.message ??
            SCHEDULE_ERROR_MESSAGES[res.reason] ??
            "Scheduling failed.",
        }));
      } catch {
        // #169 — "a discarded press should never be silent", by the other door.
        // A server action that REJECTS (dropped connection, a redeploy mid-push)
        // resolves to no `res` at all, so without this the row shows nothing and
        // the user is back to "I pressed Schedule and nothing happened".
        setScheduleErrors((prev) => ({
          ...prev,
          [itemId]: "Scheduling failed.",
        }));
      } finally {
        // Must run on every exit, including the two early returns and a throw:
        // a row left in `schedulingIds` is a control disabled for the rest of
        // the session, which is the #169 harm made permanent.
        markScheduling(itemId, false);
      }
    });
  };

  // ICS "Add to calendar" runner: builds the .ics server-side (marks + rewards),
  // then downloads it client-side. Guest-allowed (no owner gate) + no reconnect
  // handling (there's no external service to reconnect).
  const runScheduleIcs = (
    itemId: string,
    fn: () => Promise<
      | { ok: true; ics: string; icsFilename: string }
      | { ok: false; reason: string; message?: string }
    >,
  ) => {
    // Urgent, outside the transition — see runSchedule above for why (#169).
    markScheduling(itemId, true);
    setScheduleErrors((prev) => {
      if (!(itemId in prev)) return prev;
      const next = { ...prev };
      delete next[itemId];
      return next;
    });
    return startTransition(async () => {
      try {
        const res = await fn();
        if (res.ok) {
          downloadIcs(res.ics, res.icsFilename);
          router.refresh();
          return;
        }
        setScheduleErrors((prev) => ({
          ...prev,
          [itemId]:
            res.message ??
            SCHEDULE_ERROR_MESSAGES[res.reason] ??
            "Couldn't build the calendar file.",
        }));
      } catch {
        // #169 — same reasoning as runSchedule: a rejected action must say so
        // rather than leave the row looking like nothing was pressed.
        setScheduleErrors((prev) => ({
          ...prev,
          [itemId]: "Couldn't build the calendar file.",
        }));
      } finally {
        markScheduling(itemId, false);
      }
    });
  };

  // Guest primary control + owner ▾ alternative both use this. State depends
  // on whether the task already has steps (per-step events vs. one timed event).
  const icsProps = (item: Item): ScheduleControlProps => ({
    state: item.stepsTotal > 0 ? "ics_ready_steps" : "ics_needs_duration",
    onScheduleIcs: (minutes?: number) => {
      const tid = item.taskId; // guard, mirroring the multi-step Google wiring
      if (!tid) return;
      runScheduleIcs(item.id, () =>
        scheduleViaIcs(
          tid,
          minutes != null ? { durationMin: minutes } : undefined,
        ),
      );
    },
    pending: schedulingIds.has(item.id),
  });

  /**
   * #225 — the two row writes that were still outside the notice.
   *
   * Both were `startTransition(async () => { await action(); router.push(…) })`
   * with no `try`, which is the exact four-line shape this issue was filed
   * about — and between them they are seven more call sites (five here, two for
   * ▶ Focus) across two more actions, so "every inbox row write says so when it
   * does not land" was not true of the component while they stayed out. The
   * issue's table counts the `run()` sites only, which is why these were missed
   * rather than excluded.
   *
   * They are also the two the guard matters most for: each CREATES a Task, so a
   * second press is the duplicate-row class `keepAsTask` is guarded against
   * server-side in this same change.
   *
   * `onLanded` is what lets them through the shared machinery without the
   * navigation becoming a refresh — see {@link WriteFailure.onLanded}. A falsy
   * id means the action declined because the row has gone, so the fall-back is a
   * refresh: the list is what is now wrong, and refreshing it is what says so.
   */
  const breakdown = (id: string, subject: string) =>
    run(
      () => startBreakdown(id),
      { id, field: "breakdown" },
      subject,
      (taskId) => {
        if (typeof taskId === "string") router.push(`/tasks/${taskId}`);
        else router.refresh();
      },
    );

  // ▶ Focus on a single to-do — ensures its one-step task exists, then opens
  // the step-based focus timer.
  const focusOnItem = (id: string, subject: string) =>
    run(
      () => ensureFocusStep(id),
      { id, field: "focus" },
      subject,
      (stepId) => {
        if (typeof stepId === "string") router.push(`/focus/${stepId}`);
        else router.refresh();
      },
    );

  // ▶ Focus a multi-step row: jump straight into the next unfinished step's
  // timer (mirrors the single-task ▶ Focus). Steps already exist, so there's
  // nothing to ensure.
  const focusNextStep = (item: Item) => {
    const next = item.steps.find((s) => !s.done);
    if (next) router.push(`/focus/${next.id}`);
  };

  // ✎ inline title editing — shared by every bucket's rows. Keyed so it's
  // safe to drop directly into a RowActions `overflow` array too.
  //
  // #253 — this is the ONLY edit affordance on a row now. The ▾ list used to
  // carry an "Edit task title" entry calling the identical `setEditingId(item.id)`
  // (see the commit that removed it), which is the mirror shape #253's sweep was
  // written to catch; it survived the first pass only because the sweep compared
  // the list against the ACTION BAR and this button lives on the TITLE line.
  //
  // ⚠️ `Edit ${item.text}` is load-bearing beyond this row. !337's row-lookup fix
  // for #255 anchors on it being the row's unique accessible name, so renaming it
  // — or letting a second control answer to it — reintroduces a measured ~20%
  // flake in the write-failure specs.
  const pencil = (item: Item) => (
    <button
      key={`edit-${item.id}`}
      type="button"
      aria-label={`Edit ${item.text}`}
      onClick={() => setEditingId(item.id)}
      className={cn(
        "text-muted-foreground hover:text-foreground shrink-0 px-1 text-xs",
        touchTarget,
      )}
    >
      ✏️
    </button>
  );

  const titleEditor = (item: Item) => {
    // #179 — the field holds the RECONSTRUCTION (`text {note}`), not the bare
    // stored text. That is what makes the round trip an identity by construction:
    // re-parsing it yields exactly what was stored, so a save that changed
    // nothing writes back what was already there. Pre-filled with the bare text,
    // an unchanged save re-split it — eroding the text one brace group per save
    // and overwriting the note. `inlineNoteSource` also refuses to compose a note
    // whose braces could not survive the round trip, falling back to the text
    // alone; `renameItem` keeps such a note rather than losing it.
    //
    // `liveNote` picks the column, the same rule `TaskNoteRow` and `renameItem`
    // use. Pre-filling from the other grain would show a note the row does not
    // display and let a save revert one edited through `NoteField`.
    const source = inlineNoteSource({
      text: item.text,
      note: liveNote({
        taskId: item.taskId,
        itemNotes: item.itemNotes ?? null,
        taskNotes: item.notes ?? null,
      }),
    });
    return (
      <EditTitleInput
        initial={source}
        // #186 — the row's own title, so the inline-note button beside this field
        // is not a second control called "Add note". The capture bar's is mounted
        // at the same time.
        subject={item.text}
        noteHintId={noteHintId}
        voice={voice}
        onSave={(value) => {
          setEditingId(null);
          // Compared against what the field was GIVEN, not against `item.text` —
          // otherwise every row carrying a note posts a rename on open-and-close.
          if (value && value !== source)
            run(
              () => renameItem(item.id, value),
              { id: item.id, field: "text" },
              // The NEW words are what is at stake: the row still shows the old
              // title, and quoting that would name the thing that did not change.
              value,
            );
        }}
        onCancel={() => setEditingId(null)}
      />
    );
  };

  // #163 — every move outcome, spoken once.
  //
  // dnd-kit maintained this live region itself; pragmatic-drag-and-drop hands
  // the job to us on purpose (see drag-announce.ts). The state lives here, next
  // to the dispatcher, rather than inside the drag code, because the "Move to…"
  // menu has to produce the SAME sentence — a keyboard user who never drags is
  // exactly the user this feedback is for, and until now they got none at all.
  const [announcement, setAnnouncement] = useState("");

  // Drag + the "Move to…" menu share this single dispatcher so the two paths
  // can never diverge (Task 10). Every drop moves immediately — a Multi-step
  // drop parks the item there with a "Break into steps now?" call-to-action
  // (requestBreakdown) instead of a blocking prompt.
  const moveItemToBucket = (itemId: string, target: BucketId) => {
    const item = itemsById.get(itemId);
    if (!item) return;
    const source = bucketOfItem(item, now);
    const plan = dropPlan(source, target);
    // A no-op says so. Announcing the intent instead of the outcome would tell
    // a screen reader an item had moved when it had not.
    if (plan.kind === "noop") {
      setAnnouncement(notMovedAnnouncement(item.text, source, voice));
      return;
    }
    run(
      async () => {
        if (plan.reopenFirst) await reopenItem(itemId, undefined);
        switch (plan.action) {
          case "moveToReview":
            await moveToReview(itemId);
            break;
          case "triage":
            await triageBrainDumpItem(itemId);
            break;
          case "requestBreakdown":
            await requestBreakdown(itemId);
            break;
          case "snooze":
            await snoozeBrainDumpItem(itemId, 60);
            break;
          case "complete":
            await completeItem(itemId);
            break;
        }
        // #225 — announced HERE, after the writes, and that placement is the
        // fix rather than a tidy-up. `movedAnnouncement` is documented as "a
        // move that actually happened", and the rule three lines above is that
        // announcing the INTENT "would tell a screen reader an item had moved
        // when it had not" — which is precisely what announcing it ahead of the
        // write did. While every failure here was silent that was one wrong
        // sentence; now that a failure is an assertive `role="alert"`, it is two
        // live regions contradicting each other about one gesture, which is the
        // pair #210 clears `justCaptured` to avoid on the capture path.
        //
        // Inside `fn` rather than in a success callback, because the failure
        // record carries `fn` and nothing else about the write: a successful
        // RETRY has to announce too, and this is what makes that free. A write
        // that lands after the client stopped waiting announces late, which is
        // the honest outcome — the move did happen, and the timeout's message
        // says only that it could not tell.
        setAnnouncement(
          movedAnnouncement(item.text, source, plan.target, voice),
        );
      },
      // #225 — its own field rather than the field of whichever action `plan`
      // picked. A move is ONE user intent and the notice reports on it as one, so
      // a failed drop onto Done is retried as that drop (reopen included) rather
      // than as a bare `completeItem` that would drop the first half.
      { id: itemId, field: "move" },
      item.text,
    );
  };

  // Row dimming (#26): rows compare their id against activeDragId to dim
  // themselves. The platform's own drag preview is a photo of an element we
  // supply (see DragGrip), and it does not hide the source, so this is still
  // ours to do. Cleared on drop and on cancel.
  const [activeDragId, setActiveDragId] = useState<string | null>(null);

  // The monitor below is registered ONCE — re-registering it per render would
  // tear the subscription down and rebuild it on every keystroke in the capture
  // box — but it has to act on the current items, voice and clock. This is the
  // standard "latest ref" hand-off, written into the ref from an effect rather
  // than during render so it stays correct if React renders a pass it throws
  // away.
  const latest = useRef({ itemsById, now, voice, moveItemToBucket });
  useEffect(() => {
    latest.current = { itemsById, now, voice, moveItemToBucket };
  });

  useEffect(() => {
    /** The bucket a drag is currently over, or null when it is over nothing.
     * `dropTargets` is innermost-first; buckets never nest, so [0] is it. */
    const bucketUnder = (
      dropTargets: readonly { data: Record<string, unknown> }[],
    ): string | null => {
      const id = dropTargets[0]?.data[DROP_BUCKET_KEY];
      return typeof id === "string" ? id : null;
    };

    return monitorForElements({
      canMonitor: ({ source }) => isInboxDrag(source),
      onDragStart: ({ source }) => {
        const id = String(source.data[DRAG_ITEM_KEY]);
        const { itemsById, now, voice } = latest.current;
        const item = itemsById.get(id);
        if (!item) return;
        setActiveDragId(id);
        setAnnouncement(
          liftAnnouncement(item.text, bucketOfItem(item, now), voice),
        );
      },
      onDropTargetChange: ({ source, location }) => {
        const id = String(source.data[DRAG_ITEM_KEY]);
        const { itemsById, voice } = latest.current;
        const item = itemsById.get(id);
        const over = bucketUnder(location.current.dropTargets);
        if (!item || !over || !isBucketId(over)) return;
        setAnnouncement(overAnnouncement(item.text, over, voice));
      },
      // pragmatic-drag-and-drop has no separate "cancel" event: an Escape, a
      // drop into empty space and a `dragend` all arrive here with an empty
      // `dropTargets`, which `dragEndToMove` already maps to null.
      onDrop: ({ source, location }) => {
        setActiveDragId(null);
        const id = String(source.data[DRAG_ITEM_KEY]);
        const { itemsById, now, voice, moveItemToBucket } = latest.current;
        const item = itemsById.get(id);
        if (!item) return;
        const move = dragEndToMove(
          id,
          bucketUnder(location.current.dropTargets),
        );
        if (!move) {
          setAnnouncement(
            cancelledAnnouncement(item.text, bucketOfItem(item, now), voice),
          );
          return;
        }
        moveItemToBucket(move.itemId, move.target);
      },
    });
  }, []);

  // One instructions node for the whole board, named by every row's move
  // control. `useId` is the #94 fix: dnd-kit built this id from a per-render
  // counter that restarted in the browser, and rendered the node into a portal
  // that never server-rendered, so on a hard load `aria-describedby` pointed at
  // nothing at all.
  const moveInstructionsId = useId();
  // #183 — associates the capture field with the hint sentence beneath it, so
  // that sentence is announced as the field's DESCRIPTION rather than being
  // orphaned text a screen-reader user only reaches after leaving the input.
  const captureHintId = useId();

  /**
   * #210 — the one write in the app whose failure is irreversible, so the only
   * one that cannot go through the generic `run()`.
   *
   * Every other inbox action operates on an `id` that exists because the server
   * already has the row: a rejection there leaves the data intact and the press
   * repeatable. A capture's words exist nowhere but this component, and the old
   * code emptied the field and rendered "captured ✓" before the call, outside
   * any `try`. A rejection destroyed the text and lied about it in the same
   * breath — with no `error.tsx` anywhere in `src/` to catch the throw either.
   *
   * `fromRetry` distinguishes the notice's button from a fresh Enter. It is not
   * cosmetic: only a retry may clear the input on success, because only a retry
   * knows the text sitting there is the copy IT restored rather than the user's
   * next thought (see the success branch).
   *
   * `supersedes` carries the words of a notice this capture replaces — see
   * `submit()`, which is where the user's intent is legible.
   */
  const capture = (
    value: string,
    { fromRetry = false, supersedes = null as string | null } = {},
  ) => {
    // Urgent, and deliberately OUTSIDE the transition — see runSchedule (#169):
    // React 19 holds an async transition's own state updates until the action
    // settles, so a guard raised inside one first paints at the moment it stops
    // being true, which is a guard that guards nothing. Discrete events like a
    // click flush at synchronous priority, so this has landed before the next
    // press can read it.
    if (fromRetry) markRetrying(value, true);
    return startTransition(async () => {
      // Duo review round 8 — `router.refresh()` used to live inside the `try`,
      // so a refresh that threw ran the catch and told the user a capture had
      // failed when the row was already written. That is #210's own lie,
      // produced by the code fixing #210. The `try` governs the WRITE; anything
      // after it is a consequence of success and cannot un-write the row.
      let landed = false;
      try {
        await withActionTimeout(createBrainDumpItem(value), CAPTURE_TIMEOUT_MS);
        landed = true;
        // A later capture succeeding says nothing about an earlier one that
        // failed, so the notice is cleared by only two things: these words
        // landing at last, or the user having replaced them in the field and
        // captured that instead. Anything else and the notice may be the only
        // copy of words that never reached the server.
        //
        // Both tests read `prev`, not the closure: by now the notice may hold a
        // different failure entirely, and clearing THAT would be the data loss
        // this whole function exists to prevent.
        setCaptureFailure((prev) => {
          if (!prev) return null;
          if (prev.value === value) return null;
          // Duo review round 6 — the invariant, enforced where the record is
          // written rather than only where the decision is taken: a record whose
          // own attempt is UNSETTLED is never cleared by anything but that
          // attempt. `supersedes` was decided when this capture was submitted,
          // and a Retry pressed since then has made the outcome unknown again,
          // so acting on the stale decision would clear a notice out from under
          // a live request.
          if (prev.retrying) return prev;
          if (supersedes !== null && prev.value === supersedes) return null;
          return prev;
        });
        // Only a retry clears the field, and only when it still holds exactly
        // what we just saved. A fresh Enter has already emptied it
        // synchronously, so anything in there now is the user's NEXT thought —
        // and clearing that would be this bug with the roles reversed.
        if (fromRetry) {
          setText((prev) => (prev.trim() === value ? "" : prev));
          // The notice is about to unmount. If the user is standing on its Retry
          // — which they are, they just pressed it — the unmount would drop them
          // to <body> (WCAG 2.4.3), so the effect above puts them back in the
          // capture field. Read here, while the button still exists.
          returnFocusToInput.current =
            retryCtaRef.current !== null &&
            retryCtaRef.current === document.activeElement;
        }
        setJustCaptured(true);
        if (captureTimeoutRef.current) clearTimeout(captureTimeoutRef.current);
        captureTimeoutRef.current = setTimeout(
          () => setJustCaptured(false),
          CAPTURE_CONFIRM_MS,
        );
      } catch (error) {
        // An earlier capture's "captured ✓" can still be inside its 1.5s
        // window. Leaving it up would put two live regions on screen saying
        // opposite things about the same keystroke — and a screen reader would
        // read both.
        if (captureTimeoutRef.current) clearTimeout(captureTimeoutRef.current);
        setJustCaptured(false);
        // Restore the words, but ONLY into a field the user has not since typed
        // into. A ten-second hang is long enough to type the next thought, and
        // overwriting that would be the same data loss wearing the other hat.
        // When we can't restore, the notice quotes the words instead, so they
        // are never only in a variable.
        //
        // Read off the DOM node rather than through a functional `setText`
        // updater, because the answer is needed HERE — `wordsInField` decides
        // whether a later capture may clear this notice. An updater that also
        // reported what it decided would have to mutate on the way past, which
        // is not a pure updater and would run twice under StrictMode. The input
        // is controlled, so its value is `text` as currently rendered, which is
        // exactly what the updater would have been handed.
        const inField = (inputRef.current?.value ?? "").trim();
        if (inField === "") setText(value);
        // Duo review round 9 — yes, this writes unconditionally while the
        // success path above declines to clear a record whose attempt is
        // unsettled, and the asymmetry is deliberate rather than an oversight.
        // The two are answering different questions: a success may decline the
        // slot because its own words are safe on the server, whereas a failure
        // that declines it reports nothing at all. With one slot and two
        // outstanding failures, whichever record wins leaves the other
        // unannounced — so the tie is broken toward the news the user has not
        // heard yet. The words of the displaced one are still in the field; the
        // cost is a missing notice, not missing text, and
        // `capture-failure-pile-up` pins both directions. Closing it properly is
        // #175's queue.
        setCaptureFailure({
          value,
          stale: isStaleActionError(error),
          timedOut: error instanceof ActionTimeoutError,
          // A fresh record, so the retry flag starts down: this attempt is over,
          // whatever it was.
          retrying: false,
          // Either we just put them back, or a retry that failed again found
          // them still there — both mean the user is looking at them.
          wordsInField: inField === "" || inField === value,
        });
      } finally {
        // Must run on every exit including a throw: a retry flag left up is a
        // Retry button that reads permanently busy. Scoped to `value`, so a
        // capture the user typed during the retry cannot clear it — the race Duo
        // review round 2 found.
        if (fromRetry) markRetrying(value, false);
      }
      // Outside the try/catch on purpose (round 8): the row is written, so a
      // refresh that throws is a stale list, not a lost capture, and must never
      // be reported as one. Its own `catch` for the reason the row-write path
      // gives at length (!306, substitute review): outside the try made that
      // claim true by letting the throw leave the transition unhandled, which is
      // #210's own defect wearing the fix. Swallowed where it can be read.
      try {
        if (landed) router.refresh();
      } catch {
        // Intentionally empty — a stale list, and the next interaction re-fetches.
      }
    });
  };

  /**
   * Raise or drop `retrying` on the failure record for `value`, and only for
   * that record.
   *
   * The functional update is what makes it per-attempt: it reads the CURRENT
   * failure rather than the one captured in this closure, so an unrelated
   * capture that displaced the notice in the meantime is left alone instead of
   * being marked busy on another attempt's behalf.
   */
  const markRetrying = (value: string, active: boolean) =>
    setCaptureFailure((prev) => {
      if (!prev || prev.value !== value || prev.retrying === active)
        return prev;
      return { ...prev, retrying: active };
    });

  const submit = () => {
    const value = text.trim();
    if (!value) return;
    // Duo review round 5 — the one exception to "never gate a capture". These
    // exact words are already being resubmitted by the notice's Retry, and they
    // are in the field only because the notice put them back, so this Enter is
    // the same request by a second route rather than the independent insert the
    // ungating exists to protect. Not a silent discard either (#169's other
    // harm): the notice is on screen announcing a save for these very words, and
    // its Retry reads busy.
    if (captureFailure?.retrying && captureFailure.value === value) return;
    // Duo review round 3: a notice whose words are sitting in THIS field, and
    // which the user has now submitted something else from, has been seen and
    // answered — an edited typo, or a different thought typed over them. Leaving
    // it up puts a stale alert beside a fresh "captured ✓" and invites a Retry
    // that would post a near-duplicate. The words are carried rather than a
    // boolean, so a failure that lands between this press and its response
    // cannot be cleared by it.
    //
    // Duo review round 5 — but NOT while its retry is in flight. Superseding
    // means "the user has seen how this attempt ended and replaced its words",
    // and mid-flight they have seen no such thing: clearing the notice there
    // would clear it out from under a request whose outcome nobody knows, and
    // the eventual failure would look like a notice resurrecting itself from
    // nothing. Leaving it up is the fix; suppressing the failure would be the
    // silence this whole issue exists to remove.
    const supersedes =
      captureFailure?.wordsInField && !captureFailure.retrying
        ? captureFailure.value
        : null;
    // Cleared synchronously and urgently, which is both the instant-capture
    // feel and the double-submit guard: a second Enter arriving before the
    // write resolves finds an empty field and returns below. Deliberately NOT
    // gated on an in-flight capture — firing three thoughts in a row is the
    // whole point of this control, and they are independent inserts.
    setText("");
    capture(value, { supersedes });
  };

  /** #210 — the notice's Retry: re-posts the exact words that did not land. */
  const retryCapture = () => {
    if (!captureFailure || captureFailure.retrying) return;
    capture(captureFailure.value, { fromRetry: true });
  };

  // Inline delete confirm: first click reveals Delete/Cancel; the action only
  // fires on the confirming click.
  const requestDelete = (id: string) => setConfirmDeleteId(id);
  const cancelDelete = () => setConfirmDeleteId(null);
  const confirmDelete = (id: string) => {
    setConfirmDeleteId(null);
    // #225 — the subject is read here, while the row is still in the list. A
    // delete that fails leaves the row, but a delete that TIMES OUT may not, and
    // a notice that could not name what it was about would be no better than the
    // silence this replaces.
    run(
      () => deleteBrainDumpItem(id),
      { id, field: "delete" },
      itemsById.get(id)?.text ?? "",
      // #251 — where focus goes once the control it was pressed in is gone.
      //
      // A confirmed delete withdraws TWO things: the confirming button unmounts
      // with the state change above, and the row itself goes with the refresh.
      // Either is enough for the browser to drop focus on `<body>`, which is the
      // WCAG 2.4.3 fault the write notice's own hand-off exists to avoid — it was
      // simply never wired for the success path, because until this issue every
      // delete was of a row the user could re-create by typing it again. A
      // completed to-do is the one they cannot.
      //
      // This used to add "(React re-uses the slot for the resting 🗑)" and that is
      // true of the LIBRARY's copy, not this one — the two transitions are
      // structurally opposite and the sentence cannot describe both (#251 review).
      // `library-done-delete.tsx` reconciles `<span>` against `<span>`, so the
      // node is reused and focus survives the collapse, which is why its
      // `focusIsOursToMove` has to be a containment test rather than a `<body>`
      // check. Here the resting control is a `<button>` and the armed pair is a
      // `<span>`, so React unmounts and remounts: measured, focus is already on
      // `<body>` at the ARM press, one press earlier than the sentence implied,
      // and the resting node is gone from the document. The conclusion below is
      // unaffected — `activeElement === document.body` at `onLanded` either way,
      // so the capture field gets focus — but a comment two files now share must
      // not assert the same mechanism about opposite shapes.
      //
      // In `onLanded` rather than beside the press, for two reasons. It replaces
      // the default `router.refresh()` (see `attemptWrite`) and so has to make
      // that call itself — done first, because the refresh is what the user
      // asked for and the focus move is bookkeeping. And it runs only when the
      // write LANDED: on a failure, focus must stay where it is so the notice's
      // own hand-off can pull the user to the error, which is a decision it
      // makes by observing that focus is on `<body>`. Repairing here would take
      // that signal away and leave the failure unannounced.
      //
      // Repair, never steal: if the user moved focus somewhere real while the
      // write was in flight — the capture field during a slow round trip — they
      // stay there. The capture field is the fallback the notice's hand-off
      // already uses for "nowhere to go back to", and it is the deleted row's
      // nearest surviving neighbour.
      () => {
        router.refresh();
        if (document.activeElement === document.body) inputRef.current?.focus();
      },
    );
  };

  // Delete, in three shapes, all sharing one `confirmDeleteId` so confirming or
  // cancelling either resting variant keeps the other in sync.
  //
  // #253 retired the "▾ lists ALL the row's options including duplicates" rule
  // this factory was written for: the ▾ list now holds only what is not already
  // on the row, so `fullWidth` is the ROUTE to delete on every `RowActions` row
  // rather than a mirror of the 🗑 beside it. `icon` survives for one caller —
  // the Done bucket hand-rolls its action line (it needs Reopen where the primary
  // CTA goes) and is not a `RowActions` row, so its 🗑 was never in the cluster
  // #253 deleted.
  const deleteControl = (
    itemId: string,
    key: string,
    {
      fullWidth = false,
      icon = false,
    }: { fullWidth?: boolean; icon?: boolean } = {},
  ) =>
    confirmDeleteId === itemId ? (
      <span key={key} className="flex items-center gap-2">
        {/* #251 — both confirm controls carry `touchTarget`, which they did not.
            The armed pair REPLACES the 🗑 that opened it, and that button is
            already 44px, so a 24px pair shrank the action line under the
            pointer at exactly the moment a mis-tap deletes something. Sizing
            them keeps the row from moving as well as clearing the house
            minimum. `expectFullTargets` (inbox-view.test.tsx) measures every
            control in `[data-row-actions]`, but only in the resting state — it
            never opens a confirm, which is how these two stayed small while
            every sibling was checked. */}
        <button
          className={cn(
            touchTarget,
            "text-destructive rounded-md px-2.5 py-1 font-medium",
          )}
          onClick={() => confirmDelete(itemId)}
        >
          {t("action.delete", voice)}
        </button>
        {/* Decorative punctuation — hidden for the reason `library-rows.tsx` and
            `library-done-delete.tsx` hide theirs, which this factory was missed
            for (#251 review). */}
        <span aria-hidden="true" className="text-muted-foreground">
          ·
        </span>
        <button
          className={cn(
            touchTarget,
            "text-muted-foreground hover:text-foreground rounded-md px-2.5 py-1",
          )}
          onClick={cancelDelete}
        >
          {t("action.cancel", voice)}
        </button>
      </span>
    ) : icon ? (
      // v6 end-cluster: 🗑 icon (aria-label carries the meaning; two-step confirm
      // preserved — the first tap swaps to the Delete · Cancel text above).
      <button
        key={key}
        aria-label={t("action.delete", voice)}
        title={t("action.delete", voice)}
        className={cn(
          // End-cluster icon — ghost hover + a slightly bigger glyph, same
          // treatment as 📅/▾/📥 (owner: mobile icons read too tiny).
          "text-muted-foreground hover:bg-accent hover:text-destructive rounded-md px-2 py-1 text-sm",
          touchTarget,
        )}
        onClick={() => requestDelete(itemId)}
      >
        🗑
      </button>
    ) : (
      <button
        key={key}
        // Colours unchanged: muted at rest, `hover:text-foreground` on the accent
        // background. #253 changed WHERE the resting delete lives, not how it reads.
        className={
          fullWidth
            ? rowMenuEntry("text-muted-foreground hover:text-foreground")
            : cn(
                "text-muted-foreground hover:text-destructive rounded-md px-2.5 py-1",
              )
        }
        onClick={() => requestDelete(itemId)}
      >
        {t("action.delete", voice)}
      </button>
    );

  return (
    <div className="space-y-6">
      {welcomeVisible && <WelcomeCard voice={voice} />}
      {/* #199 — above the buckets, beside the resume banner: this is where the
          inbox already puts things that are ABOUT the inbox rather than in it. It
          is not a row, so it cannot reach bucketItems, the Library tabs, the
          freshness clock, the untriaged badge or maybeAwardInboxZero. */}
      {shoppingSummary && (
        <ShoppingSummaryCard count={shoppingSummary.count} voice={voice} />
      )}
      {resumeStep && (
        <div
          role="status"
          className="flex items-center gap-2 rounded-lg border border-amber-500/40 bg-amber-50 px-4 py-2 text-sm dark:bg-amber-950/20"
        >
          <span className="flex-1">
            {t("focus.pausedBanner", voice)}{" "}
            <strong>&ldquo;{resumeStep.text}&rdquo;</strong>
          </span>
          <Link
            href={`/focus/${resumeStep.id}`}
            className="text-amber-800 hover:underline dark:text-amber-300"
          >
            {t("focus.resumeArrow", voice)}
          </Link>
        </div>
      )}
      <NavBadge untriagedCount={untriagedCount} agingCount={agingCount} />

      {permission === "default" && (
        <button
          onClick={enableReminders}
          className="hover:bg-accent w-full rounded-lg border border-dashed px-3 py-2 text-sm"
        >
          🔔 Enable desktop reminders for aging items
        </button>
      )}
      {permission === "denied" && (
        <p className="text-muted-foreground text-xs">
          Desktop reminders are blocked in your browser settings; items still
          age and re-sort in-app.
        </p>
      )}

      {/* Capture bar */}
      <div className="space-y-1">
        {/* #186 — the input and its inline-note button on one line. The input
            keeps `flex-1 min-w-0` rather than `w-full`, so the button cannot be
            pushed off the edge of a phone by a long capture. */}
        <div className="flex items-center gap-2">
          <input
            ref={inputRef}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                submit();
                return;
              }
              // #201 — after Enter, so a capture is never intercepted, and
              // before nothing else: every other key falls through untouched.
              handleNoteBraceKey(e, setText);
            }}
            placeholder="Brain dump anything… (Enter to save)"
            // #183 — the app's most-used control had NO accessible name: a
            // placeholder and nothing else. A placeholder is not a name. Support
            // varies, and it VANISHES on the first keystroke, so anyone who tabs
            // away mid-capture and back had a field full of text and no way to
            // re-read what it was for. WCAG 4.1.2 Name, Role, Value; the gap also
            // undermines 3.3.2 Labels or Instructions.
            //
            // `aria-label` rather than a visually-hidden <label>: nothing may
            // change visually (the placeholder-led look is deliberate), and this
            // is the smaller change. Short, and deliberately NOT the placeholder
            // sentence — a name is what you call the control, and a voice-control
            // user saying "brain dump" has to be able to hit it.
            aria-label="Brain dump"
            // The hint below is a DESCRIPTION, not a name. Associated so it is
            // announced with the field instead of being orphaned text that a
            // screen-reader user only meets after leaving the input.
            aria-describedby={captureHintId}
            className="border-input bg-background focus-visible:ring-ring min-w-0 flex-1 rounded-lg border px-4 py-3 text-base shadow-sm outline-none focus-visible:ring-2"
            autoFocus
          />
          {/* #186 — inserts the note braces and puts the caret between them, so
              nobody has to reach the symbol keyboard for `{`. Named after this
              field, because an open ✎ row editor mounts a second one. */}
          <AddNoteButton
            subject="Brain dump"
            value={text}
            inputRef={inputRef}
            onChange={setText}
            voice={voice}
          />
        </div>
        <p id={captureHintId} className="text-muted-foreground px-1 text-xs">
          {/* #186 — the second sentence is the only thing on screen saying the
              note syntax exists, and it states the POSITION as well as the
              punctuation: "at the end" IS the rule (#179 Decision 1), so anyone
              who learns only the braces meets a mid-string group staying literal
              and reads that refusal as a bug. Both sentences share this one
              node, so they are announced together as the field's description.
              The braces themselves live in `capture.noteHint` rather than in
              this JSX, where a literal brace opens an expression. */}
          No fields required. Press Enter to capture instantly.{" "}
          {t("capture.noteHint", voice)}
        </p>
        {justCaptured && (
          <p
            role="status"
            className="text-emerald-700 dark:text-emerald-400 px-1 text-xs"
          >
            {t("capture.confirm", voice)}
          </p>
        )}
        {/* ── #210: the capture that did not land ────────────────────────────
            a11y, and three decisions that are not the focus timer's:

            `role="alert"` (assertive), not the confirmation's polite
            `role="status"`. The two describe opposite outcomes, so the failure
            path clears a still-showing "captured ✓" before setting this — they
            cannot contradict each other about the same keystroke. Where they DO
            legitimately coexist (a later capture succeeding while an earlier
            failure stands unresolved) they are reporting different captures, and
            assertive-interrupts-polite is exactly the priority wanted: the words
            still at risk outrank the ones already safe.

            Focus is NOT moved here. `focus-timer.tsx` hands focus to its
            notice's primary action because the pressed control unmounts, which
            would otherwise drop the user to <body> (WCAG 2.4.3). Nothing
            unmounts here — the capture input is still mounted, still focused,
            and still where the user is typing — so taking focus would interrupt
            them mid-sentence and fight the restored text (WCAG 3.2.2). The
            alert announces without stealing.

            The words are quoted, not merely referred to. In the common case they
            are also back in the input, but when the user has typed on the notice
            is the only copy, and a notice that says "your words are safe"
            without showing them is the same unverifiable promise this issue is
            about.

            Colour: the failure is carried by the text and the icon, never by the
            red alone (WCAG 1.4.1). `text-destructive` / `border-destructive/40`
            / `bg-destructive/5` is the token pairing globals.css documents as AA
            in both themes (5.2:1+) and the one focus-timer's notice already
            uses — not a raw palette shade, which is what dropped the emerald
            confirmation below 4.5:1 on the warm-tinted --background in #40. */}
        {captureFailure && (
          <>
            <div
              role="alert"
              className="border-destructive/40 bg-destructive/5 mt-2 flex flex-col gap-2 rounded-md border p-3 sm:flex-row sm:items-start sm:justify-between"
            >
              <p
                id={captureErrorId}
                className="text-destructive flex min-w-0 items-start gap-1.5 text-sm font-medium"
              >
                <TriangleAlert
                  aria-hidden="true"
                  className="mt-0.5 h-4 w-4 shrink-0"
                />
                <span className="break-words">
                  {t(captureMessageKey(captureFailure), voice)}{" "}
                  <strong>&ldquo;{captureFailure.value}&rdquo;</strong>
                </span>
              </p>
              <div className="flex shrink-0 flex-col items-start gap-1 sm:items-end">
                {captureFailure.stale ? (
                  // Retrying re-posts the same action id the running deployment
                  // has already forgotten, so a reload is the ONLY thing on offer.
                  <button
                    type="button"
                    aria-describedby={captureErrorId}
                    onClick={() => window.location.reload()}
                    className="bg-primary text-primary-foreground inline-flex min-h-[44px] items-center gap-1.5 rounded-md px-4 font-medium"
                  >
                    <RefreshCw
                      aria-hidden="true"
                      className="h-4 w-4 shrink-0"
                    />
                    {t("capture.error.reload", voice)}
                  </button>
                ) : (
                  // `aria-disabled`, not `disabled`: a disabled element cannot
                  // hold focus, so the browser would drop it to <body> the moment
                  // the retry starts. The press is guarded in the handler instead,
                  // so a double-tap still cannot fire two writes.
                  <button
                    ref={retryCtaRef}
                    type="button"
                    // While a retry runs, the reason AND the wait are both
                    // reachable from the control (Duo review round 8). This is
                    // the channel for focus LANDING here with a write already in
                    // flight; the press itself is announced by the live region
                    // below, because a description is not re-read under held
                    // focus (Duo round 16 on `!303`).
                    aria-describedby={
                      captureFailure.retrying
                        ? `${captureErrorId} ${captureSavingId}`
                        : captureErrorId
                    }
                    aria-disabled={captureFailure.retrying}
                    onClick={() => {
                      if (!captureFailure.retrying) retryCapture();
                    }}
                    className="bg-primary text-primary-foreground inline-flex min-h-[44px] items-center gap-1.5 rounded-md px-4 font-medium aria-disabled:opacity-50"
                  >
                    <RotateCcw
                      aria-hidden="true"
                      className="h-4 w-4 shrink-0"
                    />
                    {t("capture.error.retry", voice)}
                  </button>
                )}
                {/* Duo review round 8 — deliberately NOT `role="status"`. That
                    would be a polite live region nested inside this assertive
                    one, which is undefined enough in practice that "will it
                    announce" has no answer. This is the SIGHTED copy only, and
                    `aria-hidden` keeps it that way: the announcement is the
                    sibling region below, and one sentence in two places is how
                    it gets said twice. Hiding it also stops the insertion from
                    mutating this `role="alert"` — an alert is assertive and
                    atomic, so a visible child appearing inside it mid-retry
                    re-reads the whole notice over the polite announcement.
                    Nothing changes on screen. */}
                {captureFailure.retrying && (
                  <p
                    data-testid="capture-saving-visible"
                    aria-hidden="true"
                    className="text-muted-foreground text-xs"
                  >
                    {t("capture.error.saving", voice)}
                  </p>
                )}
              </div>
            </div>
            {/* Duo round 16 on `!303` — where the wait is actually ANNOUNCED,
                and a SIBLING of the alert rather than a descendant, because a
                polite region nested inside an assertive one inherits the
                container's politeness across its whole subtree.
                `aria-describedby` cannot do this alone: a description is read
                when focus LANDS on a control, and Retry is pressed on a control
                that already holds focus and keeps it by design, so the value
                gaining this id mid-flight is not something a screen reader goes
                back to re-read. A live region is the one channel defined for
                content that changes while the user is stationary.
                Mounted with the notice and EMPTY until there is something to
                say — the move announcer at the foot of this file documents why:
                a region that arrives together with its first message is silent.
                Kept identical to the timer's notice in `focus-timer.tsx`, which
                these two have already drifted apart on once. */}
            <p
              id={captureSavingId}
              data-testid="capture-saving-announcer"
              role="status"
              aria-live="polite"
              aria-atomic="true"
              className="sr-only"
            >
              {captureFailure.retrying && t("capture.error.saving", voice)}
            </p>
          </>
        )}
      </div>

      {/* ── #225: the row write that did not land ──────────────────────────────
          Outside the capture bar and above the board, because it reports on any
          of the twenty row writes rather than on the capture field — but next to
          that field, which is the fallback focus target when the row it was about
          has gone.

          Its own slot rather than a share of the capture notice's: the two can be
          outstanding at once and report different writes, and merging them would
          mean one of the two goes unannounced. Two `role="alert"`s adjacent is the
          honest rendering of two independent pieces of news.

          Colour: the failure is carried by the icon and the words, never by the
          red alone (WCAG 1.4.1). `text-destructive` / `border-destructive/40` /
          `bg-destructive/5` is the token pairing globals.css documents as AA in
          both themes and the one the capture notice, focus-timer.tsx and
          shopping-list.tsx already use — not a raw palette shade, which is what
          dropped a confirmation below 4.5:1 in #40. Neither control sets
          `outline-none`, so the UA focus ring draws and WCAG 2.4.11 is satisfied
          without a bespoke indicator. */}
      {writeFailure && (
        <>
          <div
            role="alert"
            className="border-destructive/40 bg-destructive/5 flex flex-col gap-2 rounded-md border p-3 sm:flex-row sm:items-start sm:justify-between"
          >
            <p
              ref={writeNoticeRef}
              id={writeErrorId}
              // Focusable programmatically but not in the tab order: the notice
              // has to be able to RECEIVE the hand-off even when it offers no
              // control, and adding a stop for a paragraph nobody can act on
              // would be noise.
              //
              // No `outline-none` here, and `a11y-class-hygiene` is why the first
              // draft had one and this does not: the moment an element can hold
              // focus, suppressing the UA outline leaves it with no visible focus
              // indicator at all (WCAG 2.4.7 / 2.4.11). The gate caught it, which
              // is the whole reason it exists — axe cannot see 2.4.11.
              tabIndex={-1}
              className="text-destructive flex min-w-0 items-start gap-1.5 text-sm font-medium"
            >
              <TriangleAlert
                aria-hidden="true"
                className="mt-0.5 h-4 w-4 shrink-0"
              />
              <span className="break-words">
                {t(writeFailureKey(writeFailure, writeFailureRowGone), voice)}{" "}
                <strong>&ldquo;{writeFailure.subject}&rdquo;</strong>
              </span>
            </p>
            {/* No control at all when nothing could work — see writeFailureRemedy. */}
            {writeRemedy !== "none" && (
              <div className="flex shrink-0 flex-col items-start gap-1 sm:items-end">
                {writeRemedy === "reload" ? (
                  <button
                    ref={writeCtaRef}
                    type="button"
                    aria-describedby={writeErrorId}
                    onClick={() => window.location.reload()}
                    className="bg-primary text-primary-foreground inline-flex min-h-[44px] items-center gap-1.5 rounded-md px-4 text-sm font-medium"
                  >
                    <RefreshCw
                      aria-hidden="true"
                      className="h-4 w-4 shrink-0"
                    />
                    {t("inbox.errorReload", voice)}
                  </button>
                ) : (
                  // `aria-disabled`, not `disabled`: a disabled element cannot
                  // hold focus, so the browser would drop it to <body> the moment
                  // the retry starts — and this notice takes focus on purpose, so
                  // that would be the WCAG 2.4.3 fault built in rather than
                  // avoided. The press is guarded in `attemptWrite` instead, per
                  // target, so a double-tap still cannot fire two writes.
                  <button
                    ref={writeCtaRef}
                    type="button"
                    // The SECOND channel for the wait, not the only one (!306,
                    // Duo review). A description is computed when focus LANDS on
                    // a control, so this covers the notice mounting with a retry
                    // already in flight — the effect above then moves focus here
                    // and the description is read on arrival. It cannot cover the
                    // press itself, because that happens on a control that
                    // already holds focus and keeps it by design; the live region
                    // below is what covers that.
                    aria-describedby={
                      writeFailure.retrying
                        ? `${writeErrorId} ${writeSavingId}`
                        : writeErrorId
                    }
                    aria-disabled={writeFailure.retrying}
                    onClick={retryWrite}
                    className="bg-primary text-primary-foreground inline-flex min-h-[44px] items-center gap-1.5 rounded-md px-4 text-sm font-medium aria-disabled:opacity-50"
                  >
                    <RotateCcw
                      aria-hidden="true"
                      className="h-4 w-4 shrink-0"
                    />
                    {t("inbox.errorRetry", voice)}
                  </button>
                )}
                {/* The SIGHTED copy of the wait, and only that. `aria-hidden`
                    because the announcement is the sibling region below, and one
                    sentence in two nodes is how it gets said twice. Hiding it
                    also stops the insertion mutating this `role="alert"`: an
                    alert is assertive AND atomic, so a visible child appearing
                    inside it mid-retry re-reads the whole notice over the polite
                    announcement. Nothing changes on screen. */}
                {writeFailure.retrying && (
                  <p
                    data-testid="write-saving-visible"
                    aria-hidden="true"
                    className="text-muted-foreground text-xs"
                  >
                    {t("inbox.errorSaving", voice)}
                  </p>
                )}
              </div>
            )}
          </div>
          {/* !306, Duo review — where the wait is actually ANNOUNCED.
              This notice shipped `!290`'s shape, which `!303` had already found
              to be half a fix (#218, its own round 16). Not nesting a polite
              region inside this assertive one was right — the outer `aria-live`
              applies to the whole subtree — but leaving `aria-describedby` to
              carry the wait alone only moved the hole onto the button: a
              description is read when focus LANDS on a control, and Retry is
              pressed on a control that already holds focus and keeps it by
              design, so the value gaining `writeSavingId` mid-flight is a change
              nothing goes back to re-read. A live region is the one channel
              defined for content that changes while the user is stationary.
              A SIBLING of the alert, never a descendant: nesting one level in is
              the original bug, not a fix for it.
              Rendered whenever the notice is, and EMPTY until there is something
              to say, because assistive technology announces a CHANGE to a region
              already in the accessibility tree and one arriving with its first
              message is silent — the move announcer at the foot of this file
              documents the same thing. `sr-only` rather than `hidden` for the
              same reason: a live region has to be rendered to be observed.
              Outside the `writeRemedy !== "none"` gate above on purpose. A row
              can vanish mid-retry, which withdraws the control and the sighted
              line with it; the write is still running and the region is still the
              honest place to say so.
              Kept identical to the capture notice above and to
              `focus-timer.tsx` — these have drifted apart once already, which is
              what produced #218. */}
          <p
            id={writeSavingId}
            data-testid="write-saving-announcer"
            role="status"
            aria-live="polite"
            aria-atomic="true"
            className="sr-only"
          >
            {writeFailure.retrying && t("inbox.errorSaving", voice)}
          </p>
        </>
      )}

      {/* #163 — the drag surface. There is no provider to wrap it in any more:
          pragmatic-drag-and-drop registers draggables, drop targets and the
          monitor imperatively against real elements, so the board is plain
          markup and the wiring is in the effects above and in DragGrip /
          DroppableBucket below. */}
      <>
        {/* Needs review */}
        <section>
          <h2 className="text-primary mb-2 flex items-center gap-2 text-sm font-semibold">
            {t("section.needsReview", voice)}
            {untriagedCount > 0 && (
              <span className="bg-secondary text-secondary-foreground rounded-full px-2 py-0.5 text-xs">
                {untriagedCount}
              </span>
            )}
          </h2>
          <DroppableBucket id="needsReview">
            {needsReview.length === 0 ? (
              // #111 — two empty inboxes, one node. "Inbox zero" is a
              // congratulation for clearing a queue; a workspace that never had
              // one gets a sentence that NAMES the account instead, because an
              // unexplained empty screen is where "did I lose everything?" gets
              // asked. Same element and same tokens either way, so the
              // zero-tolerance color-contrast gate sees no new pairing.
              // newAccountLine() composes the whole sentence as one JS string —
              // see identity.ts for why it is not JSX text around expressions.
              <p className="text-muted-foreground rounded-lg border border-dashed px-4 py-6 text-center text-sm">
                {brandNewAccount
                  ? newAccountLine(brandNewAccount, voice)
                  : t("inbox.zero", voice)}
              </p>
            ) : (
              <ul className={cn("space-y-2", refreshing && "opacity-70")}>
                {needsReview.map((item) => {
                  // v5: review rows are now schedulable — an unclarified
                  // capture has no steps, so 📅 always offers the same
                  // duration popover a Single-task row uses.
                  const schedule: ScheduleControlProps | null = effectiveGoogle
                    ? {
                        state: scheduleState(effectiveGoogle, "needs_duration"),
                        onScheduleSingle: (minutes: number) =>
                          runSchedule(item.id, () =>
                            scheduleSingleTask(item.id, minutes),
                          ),
                        pending: schedulingIds.has(item.id),
                      }
                    : icsProps(item);
                  return (
                    // #186 — the wrapper picks the note grain and hands back the
                    // two halves; the row places them. Untriaged rows are the
                    // item grain, which is where #179's captured note lives.
                    <TaskNoteRow
                      key={item.id}
                      taskId={item.taskId}
                      itemId={item.id}
                      taskTitle={item.text}
                      notes={item.notes}
                      itemNotes={item.itemNotes}
                      voice={voice}
                    >
                      {({ trigger, body }) => (
                        <ItemRow
                          isDragging={activeDragId === item.id}
                          item={item}
                          noteTrigger={trigger}
                          noteBody={body}
                          settings={settings}
                          voice={voice}
                          now={now}
                          onBreakdown={() => breakdown(item.id, item.text)}
                          onMoveToMultiStep={() =>
                            moveItemToBucket(item.id, "multiStep")
                          }
                          onKeep={() =>
                            run(
                              () => keepAsTask(item.id),
                              { id: item.id, field: "triage" },
                              item.text,
                            )
                          }
                          onSaveForLater={() =>
                            moveItemToBucket(item.id, "savedLater")
                          }
                          onComplete={() =>
                            run(
                              () => completeItem(item.id),
                              { id: item.id, field: "done" },
                              item.text,
                            )
                          }
                          confirmingDelete={confirmDeleteId === item.id}
                          onRequestDelete={() => requestDelete(item.id)}
                          onConfirmDelete={() => confirmDelete(item.id)}
                          onCancelDelete={cancelDelete}
                          onFreshen={() =>
                            run(
                              () => freshenItem(item.id),
                              { id: item.id, field: "freshen" },
                              item.text,
                            )
                          }
                          onDismissPrompt={() =>
                            run(
                              () => dismissPrompt(item.id),
                              { id: item.id, field: "prompt" },
                              item.text,
                            )
                          }
                          schedule={schedule}
                          scheduled={item.scheduledAt != null}
                          icsMenu={
                            effectiveGoogle ? (
                              <ScheduleControl
                                key="ics-m"
                                variant="menu"
                                {...icsProps(item)}
                                label={t("action.addToCalendar", voice)}
                              />
                            ) : null
                          }
                          scheduleError={scheduleErrors[item.id]}
                          dragGrip={<DragGrip id={item.id} text={item.text} />}
                          editButton={pencil(item)}
                          titleEditor={
                            editingId === item.id
                              ? titleEditor(item)
                              : undefined
                          }
                        />
                      )}
                    </TaskNoteRow>
                  );
                })}
              </ul>
            )}
          </DroppableBucket>
        </section>

        {/* To-Do board — four always-visible buckets (Phase B) */}
        <section className="space-y-4">
          <h2 className="text-primary text-sm font-semibold">
            {t("section.toDo", voice)}
          </h2>

          {/* Multi-step */}
          <div>
            <SubHeader
              label={t("section.multiStep", voice)}
              count={multiStep.length}
              seeAllHref={SEE_ALL.multiStep}
              voice={voice}
            />
            <DroppableBucket id="multiStep">
              {multiStep.length === 0 ? (
                <EmptyBucket voice={voice} />
              ) : (
                <ul className={cn("space-y-2", refreshing && "opacity-70")}>
                  {multiStep.map((item) => {
                    /* multi-step row — extended in Task 9 (step count + expand) and Task 10 (drag/menu).
                       A 0-step row is awaiting its breakdown (breakdownRequestedAt): instead of a
                       step count it shows a red "Break into steps now?" CTA into the editor. */
                    const expanded = expandedId === item.id;
                    const awaitingBreakdown = item.stepsTotal === 0;
                    // #27 follow-up — task total (shrinks as steps are
                    // paused/completed) + the active step's own remaining
                    // time, if one is open. Both are persisted SNAPSHOTS as
                    // of this page load — no live ticking in the list.
                    const totalRemainingMin = itemRemainingMin(item);
                    const activeRemainingMin = activeStepRemainingMin(item);
                    // No steps yet → nothing to push, so 📅 offers the same
                    // duration popover a single-task row uses. Rows with
                    // steps push them straight to Google Tasks on tap.
                    const schedule: ScheduleControlProps | null =
                      !effectiveGoogle
                        ? icsProps(item)
                        : awaitingBreakdown
                          ? {
                              state: scheduleState(
                                effectiveGoogle,
                                "needs_duration",
                              ),
                              onScheduleSingle: (minutes: number) =>
                                runSchedule(item.id, () =>
                                  scheduleSingleTask(item.id, minutes),
                                ),
                              pending: schedulingIds.has(item.id),
                            }
                          : {
                              state: scheduleState(
                                effectiveGoogle,
                                "ready_steps",
                              ),
                              taskTitle: item.text,
                              // #106 — present → 📅 opens the Schedule menu;
                              // absent → it keeps firing immediately.
                              scheduleIntent:
                                (item.taskId &&
                                  scheduleIntents?.[item.taskId]) ||
                                null,
                              onScheduleSteps: (intent?: ScheduleIntent) => {
                                // Guard taskId instead of asserting it — a data
                                // inconsistency should no-op, not POST undefined (Duo review).
                                const tid = item.taskId;
                                if (tid)
                                  runSchedule(item.id, () =>
                                    pushStepsToGoogleTasks(tid, intent),
                                  );
                              },
                              pending: schedulingIds.has(item.id),
                            };
                    return (
                      <li
                        key={item.id}
                        className={cn(
                          "rounded-lg border px-4 py-3 text-sm",
                          item.id === activeDragId && "opacity-40",
                        )}
                      >
                        {/* Title line + action row below — mirrors the Needs-review row layout. */}
                        {/* Tapping anywhere on the title line toggles the inline
                            step list (a step-bearing row); the title button keeps
                            aria-expanded for keyboard/AT, and the pencil stops
                            propagation so editing doesn't also toggle. */}
                        <div
                          className={cn(
                            "flex items-start gap-2",
                            !awaitingBreakdown &&
                              editingId !== item.id &&
                              "cursor-pointer",
                          )}
                          onClick={
                            !awaitingBreakdown && editingId !== item.id
                              ? () => setExpandedId(expanded ? null : item.id)
                              : undefined
                          }
                        >
                          <DragGrip id={item.id} text={item.text} />
                          {editingId === item.id ? (
                            titleEditor(item)
                          ) : awaitingBreakdown ? (
                            <span className="min-w-0 flex-1 break-words">
                              <span className="text-lg font-semibold">
                                {item.text}
                              </span>{" "}
                              {pencil(item)}
                            </span>
                          ) : (
                            <span className="min-w-0 flex-1 break-words">
                              <button
                                type="button"
                                aria-expanded={expanded}
                                onClick={(e) => {
                                  e.stopPropagation();
                                  setExpandedId(expanded ? null : item.id);
                                }}
                                className="text-lg font-semibold break-words text-left hover:underline"
                              >
                                {item.text}
                              </button>{" "}
                              <span onClick={(e) => e.stopPropagation()}>
                                {pencil(item)}
                              </span>
                            </span>
                          )}
                          {editingId !== item.id && !awaitingBreakdown && (
                            <span className="text-muted-foreground shrink-0 text-xs">
                              {item.stepsTotal} steps · {item.stepsDone}{" "}
                              {t("progress.done", voice)}
                            </span>
                          )}
                        </div>
                        {/* #27 follow-up — task total remaining + (when a
                            step is paused/in progress) that step's own
                            remaining time. */}
                        {!awaitingBreakdown && (
                          <p className="text-muted-foreground pl-9 text-xs tabular-nums">
                            ≈{totalRemainingMin} {t("lib.minLeft", voice)}
                            {activeRemainingMin != null &&
                              ` · ≈${activeRemainingMin} ${t("lib.minOnStep", voice)}`}
                          </p>
                        )}
                        {/* #44 — the note's collapsed trigger sits INSIDE the
                            action group beside Complete (owner request); the
                            editor body opens below the action line but stays in
                            this row's <li>. Both halves are null for a row with
                            no `Task` — an untriaged brain-dump item has no
                            `notes` column — which is why the action group is
                            rendered from inside `TaskNoteRow`. */}
                        <TaskNoteRow
                          taskId={item.taskId}
                          // #186 — the item grain, for a row that is triaged but
                          // has no `Task` yet (`triageBrainDumpItem` does not
                          // create one). `TaskNoteRow` picks between the two.
                          itemId={item.id}
                          taskTitle={item.text}
                          notes={item.notes}
                          itemNotes={item.itemNotes}
                          voice={voice}
                        >
                          {({ trigger, body }) => (
                            <>
                              <RowActions
                                className="pl-9"
                                scheduled={item.scheduledAt != null}
                                inline={
                                  awaitingBreakdown
                                    ? [
                                        <button
                                          key="break-now"
                                          type="button"
                                          onClick={() =>
                                            breakdown(item.id, item.text)
                                          }
                                          className={cn(
                                            touchTarget,
                                            "bg-destructive text-destructive-foreground rounded-md px-2.5 py-1 font-medium hover:opacity-90",
                                          )}
                                        >
                                          {t("prompt.breakNow", voice)}
                                        </button>,
                                      ]
                                    : [
                                        // Primary CTA — matches the single-task row (▶ Focus + Complete):
                                        // jumps straight into the next unfinished step's timer.
                                        <button
                                          key="focus"
                                          type="button"
                                          onClick={() => focusNextStep(item)}
                                          className={cn(
                                            touchTarget,
                                            "bg-primary text-primary-foreground rounded-md px-2.5 py-1 font-medium hover:opacity-90",
                                          )}
                                        >
                                          ▶ Start Focus
                                        </button>,
                                        <CompleteButton
                                          key="complete"
                                          voice={voice}
                                          onClick={() =>
                                            run(
                                              () => completeItem(item.id),
                                              { id: item.id, field: "done" },
                                              item.text,
                                            )
                                          }
                                        />,
                                        trigger,
                                      ]
                                }
                                /* #253 — the same principle and the same shape as the
                                   Needs-review row's list (see `ItemRow` below for the
                                   argument): canonical and complete, `Move to…` and
                                   `Delete` as the bookends, what-you-do-to-the-item in
                                   between, then the calendar pair, grouped by
                                   `rowMenuSeparator`.

                                   NOT the same entries, deliberately. This row is
                                   already broken into steps, so `Break into multi-step
                                   to-do` and `Add as single-task to-do` are not actions
                                   it has — and it carries two the review row does not:
                                   `View multi-step task list` (the inline expander) and
                                   `Start visual focus timer` (the task page). Those are
                                   what this row's middle group is, with the inline CTA's
                                   twin last: `Mark as completed`, or `Break into steps
                                   now?` while the breakdown has not arrived, which is
                                   also when the two step-dependent entries have nothing
                                   to point at. */
                                menu={groupedRowMenu([
                                  // ⚠️ The nested `Move to…` picker is gone (see
                                  // `ItemRow` for the owner's reasoning), and on THIS
                                  // renderer its destinations were not already covered.
                                  // The picker offered every bucket but this row's own
                                  // — needsReview, singleTask, savedLater, completed —
                                  // and only `completed` had an entry (`Mark as
                                  // completed`, below). So three explicit destination
                                  // entries replace it, each dispatched through
                                  // `moveItemToBucket`, which is byte-for-byte what the
                                  // picker's `onMove` did: same `dropPlan`, same no-op
                                  // guard, same `role="status"` announcement (#163/#225).
                                  //
                                  // Deleting the picker without these would have
                                  // stripped three routes from this row and left drag
                                  // as the only way out of Multi-step.
                                  [
                                    <button
                                      key="review-m"
                                      type="button"
                                      className={rowMenuEntry()}
                                      onClick={() =>
                                        moveItemToBucket(item.id, "needsReview")
                                      }
                                    >
                                      {t("action.sendToReview", voice)}
                                    </button>,
                                    // ⚠️ `moveItemToBucket` here, NOT `keepAsTask` as on
                                    // the Needs-review row: this entry replaces
                                    // `Move to… → Single-task`, so it keeps that path's
                                    // exact behaviour (`triage`). Both land the row in
                                    // the same bucket, which is what the shared label
                                    // names; `keepAsTask` additionally materialises the
                                    // `Task`. Unifying the two is #259/#213 territory,
                                    // not a menu-layout change.
                                    //
                                    // ⚠️⚠️ AWAITING ROWS ONLY, and this is a bug fix
                                    // rather than a layout choice. On a row that HAS
                                    // steps this entry never worked: `triage` clears
                                    // `breakdownRequestedAt`, but `bucketItems` keeps
                                    // the row in Multi-step on `stepsTotal > 1` alone
                                    // (`bucket.ts`), so the row does not move — while
                                    // `moveItemToBucket` still fired
                                    // `movedAnnouncement`, telling a screen-reader
                                    // user it had landed in Single-task. A dead
                                    // option that lied about its own outcome, against
                                    // that function's stated invariant.
                                    //
                                    // On an awaiting row it is the whole point:
                                    // `awaitsBreakdown` is `stepsTotal === 0 &&
                                    // breakdownRequestedAt != null`, so clearing the
                                    // stamp genuinely moves the row out. Hence the
                                    // gate is `awaitingBreakdown`, not `true` and not
                                    // `stepsTotal === 0` — the latter would also catch
                                    // a stepless row with no stamp, which is not in
                                    // this bucket at all.
                                    awaitingBreakdown ? (
                                      <button
                                        key="single-m"
                                        type="button"
                                        className={rowMenuEntry()}
                                        onClick={() =>
                                          moveItemToBucket(
                                            item.id,
                                            "singleTask",
                                          )
                                        }
                                      >
                                        {t("action.addTodoFull", voice)}
                                      </button>
                                    ) : null,
                                    <button
                                      key="save-m"
                                      type="button"
                                      className={rowMenuEntry()}
                                      onClick={() =>
                                        moveItemToBucket(item.id, "savedLater")
                                      }
                                    >
                                      {t("action.saveForLater", voice)}
                                    </button>,
                                  ],
                                  [
                                    // Rows with steps: view the broken-down list (inline
                                    // expand) + jump to the task page to focus a step.
                                    // Hidden while awaiting a breakdown, which is also
                                    // when this row's inline CTA becomes Break now.
                                    !awaitingBreakdown ? (
                                      <button
                                        key="view-list-m"
                                        type="button"
                                        className={rowMenuEntry()}
                                        onClick={() =>
                                          setExpandedId(
                                            expanded ? null : item.id,
                                          )
                                        }
                                      >
                                        View multi-step task list
                                      </button>
                                    ) : null,
                                    !awaitingBreakdown ? (
                                      <button
                                        key="focus-list-m"
                                        type="button"
                                        className={rowMenuEntry()}
                                        // Guard rather than assert: a multi-step row's Task always
                                        // exists by construction, but a data inconsistency must not
                                        // navigate to `/tasks/null` (Duo review).
                                        onClick={() =>
                                          item.taskId &&
                                          router.push(`/tasks/${item.taskId}`)
                                        }
                                      >
                                        {t("action.startFocusTimer", voice)}
                                      </button>
                                    ) : null,
                                    // The inline red CTA's twin, in the awaiting
                                    // state only — that is the state it names.
                                    //
                                    // ⚠️ `action.breakNow`, NOT `prompt.breakNow`.
                                    // The two were one key until #253 F1 split them:
                                    // a menu entry is a command, so this reads as an
                                    // imperative that names where it takes you
                                    // ("Break it down in the editor"), while the
                                    // card's red button keeps "Break into steps
                                    // now?" — a question is the right register on a
                                    // card, and it is the only thing that visually
                                    // marks an unbroken-down one. Owner's call on
                                    // both halves. Same key as the Needs-review
                                    // row's navigating entry, because it is the same
                                    // act: `startBreakdown`, into the editor.
                                    awaitingBreakdown ? (
                                      <button
                                        key="break-now-m"
                                        type="button"
                                        className={rowMenuEntry()}
                                        onClick={() =>
                                          breakdown(item.id, item.text)
                                        }
                                      >
                                        {t("action.breakNow", voice)}
                                      </button>
                                    ) : null,
                                    // ⚠️ UNCONDITIONAL, and it used to be the else
                                    // branch of the ternary above. Everything else
                                    // this state suppresses is suppressed for a
                                    // reason to do with steps — `view-list-m` and
                                    // `focus-list-m` have nothing to point at, and
                                    // the inline cluster collapses to the single red
                                    // CTA. Complete was the fourth casualty and the
                                    // only one with no such reason.
                                    //
                                    // With the nested picker gone (it offered
                                    // `completed` from this row) that left an
                                    // awaiting row with NO route to complete: not in
                                    // the ▾, not inline. Reachable in one ordinary
                                    // sequence — drag an item into Multi-step, then
                                    // realise you already did it — and the only way
                                    // out was to request a breakdown you do not want
                                    // in order to reach a Complete you do.
                                    <button
                                      key="complete-m"
                                      type="button"
                                      className={rowMenuEntry()}
                                      onClick={() =>
                                        run(
                                          () => completeItem(item.id),
                                          { id: item.id, field: "done" },
                                          item.text,
                                        )
                                      }
                                    >
                                      {t("action.completeFull", voice)}
                                    </button>,
                                  ],
                                  [
                                    schedule ? (
                                      <ScheduleControl
                                        key="schedule-m"
                                        {...schedule}
                                        variant="menu"
                                        label={scheduleMenuLabel(
                                          schedule.state,
                                          voice,
                                        )}
                                      />
                                    ) : null,
                                    effectiveGoogle ? (
                                      <ScheduleControl
                                        key="ics-m"
                                        variant="menu"
                                        {...icsProps(item)}
                                        label={t("action.addToCalendar", voice)}
                                      />
                                    ) : null,
                                  ],
                                  [
                                    deleteControl(item.id, "delete-m", {
                                      fullWidth: true,
                                    }),
                                  ],
                                ])}
                              />
                              {scheduleErrors[item.id] && (
                                <p className="text-destructive mt-1 text-xs">
                                  {scheduleErrors[item.id]}
                                </p>
                              )}
                              {body}
                            </>
                          )}
                        </TaskNoteRow>

                        {expanded && item.taskId && (
                          <div className="mt-2">
                            <TaskSteps
                              taskId={item.taskId}
                              voice={voice}
                              steps={item.steps.map((s) => ({
                                id: s.id,
                                order: s.order,
                                total: item.stepsTotal,
                                text: s.text,
                                subtaskEmoji: s.subtaskEmoji,
                                estMinutes: s.estMinutes,
                                done: s.done,
                                notes: s.notes ?? null,
                                resumable: s.resumable,
                              }))}
                            />
                          </div>
                        )}
                      </li>
                    );
                  })}
                </ul>
              )}
            </DroppableBucket>
          </div>

          {/* Single-task */}
          <div>
            <SubHeader
              label={t("section.singleTask", voice)}
              count={singleTask.length}
              seeAllHref={SEE_ALL.singleTask}
              voice={voice}
            />
            <DroppableBucket id="singleTask">
              {singleTask.length === 0 ? (
                <EmptyBucket voice={voice} />
              ) : (
                <ul className={cn("space-y-2", refreshing && "opacity-70")}>
                  {singleTask.map((item) => {
                    const schedule: ScheduleControlProps | null =
                      effectiveGoogle
                        ? {
                            state: scheduleState(
                              effectiveGoogle,
                              "needs_duration",
                            ),
                            onScheduleSingle: (minutes: number) =>
                              runSchedule(item.id, () =>
                                scheduleSingleTask(item.id, minutes),
                              ),
                            pending: schedulingIds.has(item.id),
                          }
                        : icsProps(item);
                    return (
                      <li
                        key={item.id}
                        className={cn(
                          "rounded-lg border px-4 py-3 text-sm",
                          item.id === activeDragId && "opacity-40",
                        )}
                      >
                        {/* Title line + action row below — mirrors the Needs-review row layout. */}
                        <div className="flex items-start gap-2">
                          <DragGrip id={item.id} text={item.text} />
                          {editingId === item.id ? (
                            titleEditor(item)
                          ) : (
                            <span className="min-w-0 flex-1 break-words">
                              <span className="text-lg font-semibold">
                                {item.text}
                              </span>{" "}
                              {pencil(item)}
                            </span>
                          )}
                          {editingId !== item.id && (
                            <span className="text-muted-foreground shrink-0 text-xs">
                              captured{" "}
                              {formatAgo(
                                now - new Date(item.createdAt).getTime(),
                              )}
                            </span>
                          )}
                        </div>
                        {/* #44 — a single-step to-do is a real `Task` row with a
                            real `notes` column, and this is the Inbox twin of
                            the Library gap: it has no steps to reach a note
                            through. Trigger in the action group beside
                            Complete, body below it, both null when the row has
                            no task. */}
                        <TaskNoteRow
                          taskId={item.taskId}
                          // #186 — the item grain, for a row that is triaged but
                          // has no `Task` yet (`triageBrainDumpItem` does not
                          // create one). `TaskNoteRow` picks between the two.
                          itemId={item.id}
                          taskTitle={item.text}
                          notes={item.notes}
                          itemNotes={item.itemNotes}
                          voice={voice}
                        >
                          {({ trigger, body }) => (
                            <>
                              <RowActions
                                className="pl-9"
                                scheduled={item.scheduledAt != null}
                                inline={[
                                  <button
                                    key="focus"
                                    type="button"
                                    onClick={() =>
                                      focusOnItem(item.id, item.text)
                                    }
                                    className={cn(
                                      touchTarget,
                                      "bg-primary text-primary-foreground rounded-md px-2.5 py-1 font-medium hover:opacity-90",
                                    )}
                                  >
                                    ▶ Start Focus
                                  </button>,
                                  <CompleteButton
                                    key="complete"
                                    voice={voice}
                                    onClick={() =>
                                      run(
                                        () => completeItem(item.id),
                                        { id: item.id, field: "done" },
                                        item.text,
                                      )
                                    }
                                  />,
                                  trigger,
                                ]}
                                /* #253 — canonical and complete, same bookends and
                                   grouping as every other ▾ list on the board. The two
                                   middle entries are the full-label twins of this row's
                                   inline `▶ Start Focus` and `Complete`; they were
                                   deleted mid-issue as duplicates and are back, because
                                   the list is the place a person is entitled to find
                                   everything. `focusOnItem(item.id, item.text)` really
                                   is the identical expression in both places, and that
                                   is now the point rather than the objection.

                                   Not `Break into multi-step to-do` / `Add as
                                   single-task to-do`: this row IS the single-task
                                   bucket, so one is what it already is and the other is
                                   reached by `Move to… → Multi-step`. */
                                menu={groupedRowMenu([
                                  // The picker's destinations, explicit (see the
                                  // multi-step row above for the full reasoning). It
                                  // offered needsReview, multiStep, savedLater and
                                  // completed here; only `completed` had an entry, so
                                  // three are added, all through `moveItemToBucket` so
                                  // the behaviour is identical to the picker's.
                                  //
                                  // ⚠️ `Break into multi-step to-do` on THIS row parks
                                  // the item in Multi-step with a "Break into steps
                                  // now?" CTA (`requestBreakdown`) — what
                                  // `Move to… → Multi-step` always did here. On the
                                  // Needs-review row the same label navigates into the
                                  // breakdown editor (`startBreakdown`). Same
                                  // destination bucket, different next step, and the
                                  // difference predates this change.
                                  [
                                    <button
                                      key="review-m"
                                      type="button"
                                      className={rowMenuEntry()}
                                      onClick={() =>
                                        moveItemToBucket(item.id, "needsReview")
                                      }
                                    >
                                      {t("action.sendToReview", voice)}
                                    </button>,
                                    <button
                                      key="multi-m"
                                      type="button"
                                      className={rowMenuEntry()}
                                      onClick={() =>
                                        moveItemToBucket(item.id, "multiStep")
                                      }
                                    >
                                      {t("action.breakdownFull", voice)}
                                    </button>,
                                    <button
                                      key="save-m"
                                      type="button"
                                      className={rowMenuEntry()}
                                      onClick={() =>
                                        moveItemToBucket(item.id, "savedLater")
                                      }
                                    >
                                      {t("action.saveForLater", voice)}
                                    </button>,
                                  ],
                                  [
                                    <button
                                      key="focus-m"
                                      type="button"
                                      className={rowMenuEntry()}
                                      onClick={() =>
                                        focusOnItem(item.id, item.text)
                                      }
                                    >
                                      {t("action.startFocusTimer", voice)}
                                    </button>,
                                    <button
                                      key="complete-m"
                                      type="button"
                                      className={rowMenuEntry()}
                                      onClick={() =>
                                        run(
                                          () => completeItem(item.id),
                                          { id: item.id, field: "done" },
                                          item.text,
                                        )
                                      }
                                    >
                                      {t("action.completeFull", voice)}
                                    </button>,
                                  ],
                                  [
                                    schedule ? (
                                      <ScheduleControl
                                        key="schedule-m"
                                        {...schedule}
                                        variant="menu"
                                        label={scheduleMenuLabel(
                                          schedule.state,
                                          voice,
                                        )}
                                      />
                                    ) : null,
                                    effectiveGoogle ? (
                                      <ScheduleControl
                                        key="ics-m"
                                        variant="menu"
                                        {...icsProps(item)}
                                        label={t("action.addToCalendar", voice)}
                                      />
                                    ) : null,
                                  ],
                                  [
                                    deleteControl(item.id, "delete-m", {
                                      fullWidth: true,
                                    }),
                                  ],
                                ])}
                              />
                              {scheduleErrors[item.id] && (
                                <p className="text-destructive mt-1 text-xs">
                                  {scheduleErrors[item.id]}
                                </p>
                              )}
                              {body}
                            </>
                          )}
                        </TaskNoteRow>
                      </li>
                    );
                  })}
                </ul>
              )}
            </DroppableBucket>
          </div>

          {/* Saved for later */}
          <div>
            <SubHeader
              label={t("section.savedLater", voice)}
              count={savedLater.length}
              seeAllHref={SEE_ALL.savedLater}
              voice={voice}
            />
            <DroppableBucket id="savedLater">
              {savedLater.length === 0 ? (
                <EmptyBucket voice={voice} />
              ) : (
                <ul className="space-y-2">
                  {savedLater.map((item) => {
                    /* Tapping a saved row reveals the same sorting options a
                       review row has — the pantry is "waiting for your review".
                       Idle rows are dimmed; a row under review looks active. */
                    const optionsOpen = savedOptionsId === item.id;
                    return (
                      // #186 — a parked row is untriaged too, so its note lives on
                      // the item. A note that vanished because somebody moved a
                      // row to the pantry would be the same defect in a quieter
                      // place, which is exactly how the Library gap shipped.
                      <TaskNoteRow
                        key={item.id}
                        taskId={item.taskId}
                        itemId={item.id}
                        taskTitle={item.text}
                        notes={item.notes}
                        itemNotes={item.itemNotes}
                        voice={voice}
                      >
                        {({ trigger, body }) => (
                          <li
                            className={cn(
                              "rounded-lg border px-4 py-3 text-sm",
                              item.id === activeDragId && "opacity-40",
                            )}
                          >
                            {/* Title line + action row below — mirrors the Needs-review row layout.
                            An idle row reads as "asleep" by dimming ONLY this title/metadata
                            line — NOT the whole row (#56). Layering opacity-70 over the <li>
                            also composited the bg-primary "Review now" CTA below WCAG-AA
                            (~3.3:1 light / ~3.6:1 dark against its background; needs 4.5:1).
                            Keeping the dim off the CTA lets it stay at its full 5.41:1 (light)
                            / 6.32:1 (dark). The dim lifts once the row is under review
                            (optionsOpen) or being dragged (the <li>'s opacity-40 covers it). */}
                            <div
                              className={cn(
                                "flex items-start gap-2",
                                !optionsOpen &&
                                  item.id !== activeDragId &&
                                  "opacity-70",
                              )}
                            >
                              <DragGrip id={item.id} text={item.text} />
                              {editingId === item.id ? (
                                titleEditor(item)
                              ) : (
                                <span className="min-w-0 flex-1 break-words">
                                  <button
                                    type="button"
                                    aria-expanded={optionsOpen}
                                    onClick={() =>
                                      setSavedOptionsId(
                                        optionsOpen ? null : item.id,
                                      )
                                    }
                                    className="text-lg font-semibold break-words text-left hover:underline"
                                  >
                                    {item.text}
                                  </button>{" "}
                                  {pencil(item)}
                                </span>
                              )}
                            </div>
                            {/* Idle: Review now + 📥 Move. Reviewing: the full v6
                            review-row frame (short buttons + ▾ full mirror);
                            the short "Save" re-snoozes and puts the row back
                            to sleep. */}
                            {optionsOpen ? (
                              <RowActions
                                className="pl-9"
                                inline={[
                                  <button
                                    key="breakdown"
                                    onClick={() =>
                                      breakdown(item.id, item.text)
                                    }
                                    className={cn(
                                      touchTarget,
                                      "bg-primary text-primary-foreground rounded-md px-2.5 py-1 font-medium hover:opacity-90",
                                    )}
                                  >
                                    {t("action.breakdown", voice)} →
                                  </button>,
                                  // #253 — Add to-do left the row for the ▾ list, so
                                  // this frame is the same four as every other bucket:
                                  // main CTA, Save, Complete, Note.
                                  <button
                                    key="save"
                                    // Named by its visible text — see the same button
                                    // on the Needs-review row for why #253's earlier
                                    // `aria-label` of the full label came back off. In
                                    // short: the ▾ entry carrying those exact words is
                                    // restored, and two controls in one row answering to
                                    // "Save for later" is an ambiguous voice-control
                                    // target and an unqueryable row. `title` keeps the
                                    // full wording on hover without entering the name.
                                    title={t("action.saveForLater", voice)}
                                    className={cn(
                                      touchTarget,
                                      "hover:bg-accent rounded-md px-2.5 py-1 font-medium",
                                    )}
                                    onClick={() => {
                                      setSavedOptionsId(null);
                                      run(
                                        () => snoozeBrainDumpItem(item.id, 60),
                                        { id: item.id, field: "snooze" },
                                        item.text,
                                      );
                                    }}
                                  >
                                    {t("action.saveShort", voice)}
                                  </button>,
                                  <CompleteButton
                                    key="complete"
                                    voice={voice}
                                    onClick={() =>
                                      run(
                                        () => completeItem(item.id),
                                        { id: item.id, field: "done" },
                                        item.text,
                                      )
                                    }
                                  />,
                                  // #186 — beside Complete, the placement !270
                                  // settled for every list row.
                                  trigger,
                                ]}
                                /* #253 — the review frame a parked row reveals, so it
                                   carries the Needs-review row's list minus the two it
                                   has no route to: there is no Schedule or .ics control
                                   on a saved row, and there never was.

                                   `Save for later` here is the RE-snooze — the same
                                   `snoozeBrainDumpItem(id, 60)` as the inline `Save`
                                   beside it, which also puts the row back to sleep. It
                                   was dropped mid-issue for being that duplicate and is
                                   back for the same reason the others are: this list is
                                   the row's canonical set, and a person looking for
                                   "park it again" should not have to know that the short
                                   button above means that. */
                                menu={groupedRowMenu([
                                  // The picker offered needsReview, multiStep,
                                  // singleTask and completed here, and the review
                                  // frame's own four entries below already cover three
                                  // of them. Only `needsReview` needed adding — the
                                  // row's way back out of the pantry to be re-triaged.
                                  [
                                    <button
                                      key="review-m"
                                      type="button"
                                      className={rowMenuEntry()}
                                      onClick={() =>
                                        moveItemToBucket(item.id, "needsReview")
                                      }
                                    >
                                      {t("action.sendToReview", voice)}
                                    </button>,
                                  ],
                                  [
                                    <button
                                      key="breakdown-m"
                                      onClick={() =>
                                        breakdown(item.id, item.text)
                                      }
                                      className={rowMenuEntry()}
                                    >
                                      {t("action.breakdownFull", voice)}
                                    </button>,
                                    <button
                                      key="keep-m"
                                      onClick={() =>
                                        run(
                                          () => keepAsTask(item.id),
                                          { id: item.id, field: "triage" },
                                          item.text,
                                        )
                                      }
                                      className={rowMenuEntry()}
                                    >
                                      {t("action.addTodoFull", voice)}
                                    </button>,
                                    <button
                                      key="save-m"
                                      onClick={() => {
                                        setSavedOptionsId(null);
                                        run(
                                          () =>
                                            snoozeBrainDumpItem(item.id, 60),
                                          { id: item.id, field: "snooze" },
                                          item.text,
                                        );
                                      }}
                                      className={rowMenuEntry()}
                                    >
                                      {t("action.saveForLater", voice)}
                                    </button>,
                                    <button
                                      key="complete-m"
                                      onClick={() =>
                                        run(
                                          () => completeItem(item.id),
                                          { id: item.id, field: "done" },
                                          item.text,
                                        )
                                      }
                                      className={rowMenuEntry()}
                                    >
                                      {t("action.completeFull", voice)}
                                    </button>,
                                  ],
                                  [
                                    deleteControl(item.id, "delete-saved-m", {
                                      fullWidth: true,
                                    }),
                                  ],
                                ])}
                              />
                            ) : (
                              <div className="mt-2 flex flex-wrap items-center gap-2 pl-9 text-xs">
                                {/* Wakes the item for review IN the bucket — same
                                toggle as pressing the row title. */}
                                <button
                                  type="button"
                                  aria-expanded={optionsOpen}
                                  onClick={() => setSavedOptionsId(item.id)}
                                  className={cn(
                                    touchTarget,
                                    "bg-primary text-primary-foreground rounded-md px-2.5 py-1 font-medium hover:opacity-90",
                                  )}
                                >
                                  {t("action.reviewNow", voice)}
                                </button>
                                <span className="flex-1" />
                                <MoveToMenu
                                  describedById={moveInstructionsId}
                                  currentBucket={bucketOfItem(item, now)}
                                  voice={voice}
                                  onMove={(target) =>
                                    moveItemToBucket(item.id, target)
                                  }
                                />
                              </div>
                            )}
                            {/* #186 — below the action line, inside this row's <li>,
                            and where the saved note is READ while collapsed. */}
                            {body}
                          </li>
                        )}
                      </TaskNoteRow>
                    );
                  })}
                </ul>
              )}
            </DroppableBucket>
          </div>

          {/* Completed */}
          <div>
            <h2 className="text-primary mb-2 flex items-center gap-2 text-sm font-semibold">
              {t("section.completed", voice)}
              <span className="bg-secondary text-secondary-foreground rounded-full px-2 py-0.5 text-xs">
                {t("section.completedToday", voice)}: {completedTodayCount}
              </span>
              <a
                href="/library?tab=done"
                className="text-muted-foreground hover:text-foreground ml-auto text-xs font-normal"
              >
                {t("link.seeAll", voice)}
              </a>
            </h2>
            <DroppableBucket id="completed">
              {completed.length === 0 ? (
                <EmptyBucket voice={voice} />
              ) : (
                <ul className="space-y-2 opacity-80">
                  {completed.map((item) => {
                    /* Multi-step (2+ steps): Reopen opens a per-step picker so
                       only the steps that still need doing come back. Anything
                       simpler reopens whole, as before. */
                    const pickingSteps = reopenPickerId === item.id;
                    return (
                      <li
                        key={item.id}
                        className={cn(
                          "rounded-lg border px-4 py-3 text-sm",
                          item.id === activeDragId && "opacity-40",
                        )}
                      >
                        {/* Title line + action row below — mirrors the Needs-review row layout. */}
                        <div className="flex items-start gap-2">
                          <DragGrip id={item.id} text={item.text} />
                          {editingId === item.id ? (
                            titleEditor(item)
                          ) : (
                            <span className="min-w-0 flex-1 break-words">
                              <span
                                className={cn(
                                  "text-lg font-semibold",
                                  COMPLETE_TEXT,
                                )}
                              >
                                {item.text}
                              </span>{" "}
                              {pencil(item)}
                            </span>
                          )}
                          {editingId !== item.id && (
                            <DonePill
                              voice={voice}
                              done={item.stepsDone}
                              total={item.stepsTotal}
                            />
                          )}
                        </div>
                        {/* The Done bucket hand-rolls its action line instead
                            of rendering <RowActions>, because it needs Reopen
                            where the primary CTA goes and none of the rest.
                            It still carries `data-row-actions` (#184): without
                            the marker this line is invisible to the target-size
                            guard, which is exactly how its Reopen button sat at
                            24px while every other bucket's CTA was checked.
                            The layout classes are duplicated from RowActions
                            deliberately-for-now — folding this into that
                            component is worth doing and is not this issue.

                            #251 — "and none of the rest" no longer includes
                            delete. Completing an item used to be a one-way door:
                            this line offered Reopen and Move to… only, so a
                            to-do completed while demoing the app stayed in the
                            list for good. It is the same 🗑 the other buckets
                            render, from the same `deleteControl` and sharing the
                            one `confirmDeleteId`, so the two-step confirm and
                            its wording cannot drift from theirs. */}
                        <div
                          data-row-actions=""
                          className="mt-2 flex flex-wrap items-center gap-2 pl-9 text-xs"
                        >
                          <button
                            type="button"
                            className={cn(
                              touchTarget,
                              "hover:bg-accent rounded-md px-2.5 py-1 font-medium",
                            )}
                            onClick={() =>
                              item.stepsTotal > 1
                                ? setReopenPickerId(
                                    pickingSteps ? null : item.id,
                                  )
                                : run(
                                    () => reopenItem(item.id, undefined),
                                    { id: item.id, field: "done" },
                                    item.text,
                                  )
                            }
                          >
                            {t("action.reopen", voice)}
                          </button>
                          <span className="flex-1" />
                          <MoveToMenu
                            describedById={moveInstructionsId}
                            currentBucket={bucketOfItem(item, now)}
                            voice={voice}
                            onMove={(target) =>
                              moveItemToBucket(item.id, target)
                            }
                          />
                          {/* Visible gap so 📥 Move to and 🗑 Delete don't sit
                              flush — the same spacer RowActions puts between
                              its end-cluster icons, for the same misclick. */}
                          <span aria-hidden="true" className="w-3" />
                          {deleteControl(item.id, "delete-done", {
                            icon: true,
                          })}
                        </div>
                        {pickingSteps && (
                          <ReopenStepPicker
                            steps={item.steps}
                            voice={voice}
                            onConfirm={(stepIds) => {
                              setReopenPickerId(null);
                              run(
                                () => reopenItem(item.id, stepIds),
                                { id: item.id, field: "done" },
                                item.text,
                              );
                            }}
                            onCancel={() => setReopenPickerId(null)}
                          />
                        )}
                      </li>
                    );
                  })}
                </ul>
              )}
            </DroppableBucket>
          </div>
        </section>
      </>

      {/* #163 — the live region every move outcome is announced through.
          Rendered ALWAYS and initially empty on purpose: assistive technology
          announces a *change* to a region already in the accessibility tree, so
          one that appears together with its first message is silent. `sr-only`
          rather than `hidden`, because a live region has to be rendered to be
          observed. */}
      <p
        data-testid="move-announcer"
        role="status"
        aria-atomic="true"
        className="sr-only"
      >
        {announcement}
      </p>

      {/* The description every row's move control points at. `hidden` is the
          long-standing technique for a description-only node: an element
          referenced directly by `aria-describedby` contributes its text even
          when it is not rendered, and hiding it keeps the sentence from being
          read a second time by someone browsing the page. */}
      <p id={moveInstructionsId} hidden>
        {MOVE_INSTRUCTIONS}
      </p>
      {/* #186 — the ✎ row editor's description, once for the whole board. Same
          reasoning as the node above: referenced text contributes to the
          description without being painted, so the rule reaches a screen-reader
          user without putting a hint line inside every row. */}
      <p id={noteHintId} hidden>
        {t("capture.noteHint", voice)}
      </p>
    </div>
  );
}

/** Inline title editor swapped in for a row's title while its ✎ is active.
 * Enter saves, Escape cancels. */
function EditTitleInput({
  initial,
  subject,
  noteHintId,
  voice,
  onSave,
  onCancel,
}: {
  initial: string;
  /** #186 — this row's title, for the inline-note button's accessible name. */
  subject: string;
  /** #186 — the board's one hidden node describing the note syntax. */
  noteHintId: string;
  voice: Voice;
  onSave: (value: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(initial);
  // #186 — the note button places a caret, which is a DOM operation: `value`
  // says what the text is and nothing says where in it the user is.
  const inputRef = useRef<HTMLInputElement>(null);
  return (
    <span className="flex min-w-0 flex-1 items-center gap-1">
      <input
        ref={inputRef}
        autoFocus
        value={value}
        aria-label="Edit title"
        // #186 — the same rule the capture bar states visibly. There is no room
        // for a hint line inside a row, and one per editing row would be noise,
        // so a screen-reader user gets it from the referenced hidden node while
        // a sighted user has already met it under the capture bar.
        aria-describedby={noteHintId}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            onSave(value.trim());
            return;
          }
          if (e.key === "Escape") {
            onCancel();
            return;
          }
          // #201 — the same auto-close as the capture bar. This field holds the
          // reconstruction (`text {note}`), so a row WITH a note pre-fills as a
          // value already ending in a group and a `{` typed at the end is
          // declined — the correct outcome, not a gap. No claim about how often
          // that happens: notes are opt-in, so most rows pre-fill as bare text
          // and the rule fires normally (!306, substitute review, which found the
          // frequency claim that used to be here unmeasurable and probably
          // backwards).
          handleNoteBraceKey(e, setValue);
        }}
        className="border-input bg-background focus-visible:ring-ring min-w-0 flex-1 rounded-md border px-2 py-1 text-sm outline-none focus-visible:ring-2"
      />
      <AddNoteButton
        subject={subject}
        value={value}
        inputRef={inputRef}
        onChange={setValue}
        voice={voice}
      />
    </span>
  );
}

/** Inline picker for undoing a completed multi-step item: tick the steps that
 * still need doing. Confirm needs ≥1 ticked; "Reopen all" resets every step
 * (same as the whole-item Undo, stepIds = undefined). */
function ReopenStepPicker({
  steps,
  voice,
  onConfirm,
  onCancel,
}: {
  steps: Item["steps"];
  voice: Voice;
  onConfirm: (stepIds: string[] | undefined) => void;
  onCancel: () => void;
}) {
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const toggle = (id: string) =>
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const ordered = [...steps].sort((a, b) => a.order - b.order);

  // Escape dismisses the picker — same keyboard behaviour as MoveToMenu.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onCancel]);
  return (
    <div className="mt-2 space-y-2 rounded-md border px-3 py-2 text-xs">
      <p className="font-medium">{t("prompt.reopenWhich", voice)}</p>
      <ul className="space-y-1">
        {ordered.map((s) => (
          <li key={s.id}>
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={checked.has(s.id)}
                onChange={() => toggle(s.id)}
              />
              {/* Unticked = stays done, so it keeps the completed strikethrough. */}
              <span
                className={cn(
                  !checked.has(s.id) && `${COMPLETE_TEXT} opacity-70`,
                )}
              >
                {/* Emoji is decoration; keep it out of the accessible name. */}
                {s.subtaskEmoji && (
                  <span aria-hidden="true">{s.subtaskEmoji} </span>
                )}
                {s.text}
              </span>
            </label>
          </li>
        ))}
      </ul>
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          disabled={checked.size === 0}
          onClick={() => onConfirm([...checked])}
          className="bg-primary text-primary-foreground rounded-md px-2.5 py-1 font-medium hover:opacity-90 disabled:opacity-50"
        >
          {t("action.reopenSelected", voice)}
        </button>
        <button
          type="button"
          onClick={() => onConfirm(undefined)}
          className="hover:bg-accent rounded-md border px-2.5 py-1"
        >
          {t("action.reopenAll", voice)}
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="text-muted-foreground hover:text-foreground rounded-md px-2.5 py-1"
        >
          {t("action.cancel", voice)}
        </button>
      </div>
    </div>
  );
}

/** Drop zone wrapper around a bucket's body — used by both the To-Do buckets
 * and the Needs-review region so drag has a target everywhere the menu does. */
function DroppableBucket({
  id,
  children,
}: {
  id: BucketId;
  children: React.ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [isOver, setIsOver] = useState(false);

  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    return dropTargetForElements({
      element,
      getData: () => ({ [DROP_BUCKET_KEY]: id }),
      // Without this a file, an image or a text selection dragged in from
      // anywhere would light the bucket up as a valid target.
      canDrop: ({ source }) => isInboxDrag(source),
      onDragEnter: () => setIsOver(true),
      onDragLeave: () => setIsOver(false),
      onDrop: () => setIsOver(false),
    });
  }, [id]);

  return (
    <div
      ref={ref}
      data-bucket={id}
      className={cn("rounded-lg", isOver && "ring-primary ring-2")}
    >
      {children}
    </div>
  );
}

/**
 * The pointer drag handle for a single row.
 *
 * **It is decoration, not a control (#163.)** It used to be a
 * `<button aria-label="Drag …">` because dnd-kit's `KeyboardSensor` needed a
 * focusable activator. pragmatic-drag-and-drop is built on the platform's own
 * drag and drop and has no keyboard adapter at all — Atlassian's accessibility
 * guidelines recommend *against* building one ("avoid directional controls")
 * and point at a menu instead. Keeping a focus stop that advertises a drag it
 * can no longer perform would be worse for a screen-reader user than not
 * exposing it, so the grip is `aria-hidden` and out of the tab order, and the
 * row's "Move to" control carries the whole non-pointer path. That is what
 * satisfies WCAG 2.1.1 (Keyboard) and, since the same control needs no
 * dragging movement, 2.5.7 as well.
 *
 * No `touch-none`: dnd-kit's `TouchSensor` needed it to win the gesture race
 * against page scrolling (#26). The platform arbitrates that race itself now —
 * a long press lifts, a swipe scrolls — and a `touch-action: none` island would
 * only trap a scroll that happens to start on the grip.
 */
function DragGrip({ id, text }: { id: string; text: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  const [previewContainer, setPreviewContainer] = useState<HTMLElement | null>(
    null,
  );

  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    return draggable({
      element,
      getInitialData: () => ({ [DRAG_ITEM_KEY]: id }),
      onGenerateDragPreview: ({ nativeSetDragImage }) => {
        setCustomNativeDragPreview({
          // Push the ghost off the pointer so the row underneath stays
          // readable. Kept small: a native preview wider or taller than 280px
          // is dimmed heavily by Windows.
          getOffset: pointerOutsideOfPreview({ x: "12px", y: "8px" }),
          render: ({ container }) => {
            setPreviewContainer(container);
            return () => setPreviewContainer(null);
          },
          nativeSetDragImage,
        });
      },
    });
  }, [id]);

  return (
    <>
      <span
        ref={ref}
        data-drag-grip={id}
        // Decoration for a pointer, and named nowhere in the accessibility
        // tree — see the component doc comment.
        aria-hidden="true"
        // Narrow gutter (28px wide × 44px tall) so the title tucks in to the
        // left instead of floating past a full 44px-square grip. 28px keeps the
        // pointer target ≥ the WCAG-AA 24px minimum (2.5.8); full 44px height
        // preserved.
        className="text-muted-foreground hover:text-foreground inline-flex min-h-11 w-7 shrink-0 cursor-grab items-center justify-center text-xs select-none"
      >
        ⠿
      </span>
      {/* A portal rather than a second React root, so the ghost is rendered by
          the same tree (and therefore under the same providers) as the row it
          is a copy of. `setCustomNativeDragPreview` owns this container: it
          appends it to the body, lets the browser photograph it, and removes it
          on the frame the lift completes. */}
      {previewContainer
        ? createPortal(<DragGhostRow text={text} />, previewContainer)
        : null}
    </>
  );
}

/**
 * The row copy the browser photographs to use as the drag preview (#26/#62).
 *
 * #62 was that dnd-kit's `DragOverlay` sized its wrapper to the measured rect
 * of the *draggable* node, and the draggable ref lived on the 28×44 grip — so
 * the ghost came out grip-shaped and the title collapsed into a
 * one-character-per-line sliver. That coupling does not exist here: the preview
 * is this element, in a container of its own, and the grip's rect never enters
 * the calculation. The `style={{ width: "auto", height: "auto" }}` workaround
 * against `PositionedOverlay` is gone with it.
 *
 * Still its own component so it can be unit-tested away from the drag
 * lifecycle: jsdom cannot reproduce the real-browser layout bug, but it can
 * assert the markup never pins itself to a fixed narrow width.
 */
export function DragGhostRow({ text }: { text: string }) {
  return (
    <div
      data-drag-ghost=""
      className="bg-background ring-primary/40 pointer-events-none flex w-[min(90vw,28rem)] scale-[1.02] items-start gap-2 rounded-lg border px-4 py-3 shadow-lg ring-2"
    >
      <span
        aria-hidden="true"
        className="text-muted-foreground inline-flex w-7 shrink-0 items-center justify-center text-xs"
      >
        ⠿
      </span>
      <span className="min-w-0 flex-1 text-sm break-words">{text}</span>
    </div>
  );
}

/** Empty-state placeholder shown inside a bucket that has no items. */
function EmptyBucket({ voice }: { voice: Voice }) {
  return (
    <p className="text-muted-foreground rounded-lg border border-dashed px-4 py-4 text-center text-xs">
      {t("bucket.empty", voice)}
    </p>
  );
}

/**
 * A Needs-review row: an untriaged brain-dump item.
 *
 * #186 — this row DOES offer a note now, and the comment that used to say
 * otherwise was right when it was written. #44's reasoning was that an untriaged
 * item has no `Task` row and therefore no `notes` column, so the affordance could
 * only render as nothing. #186 gave `BrainDumpItem` its own `notes` column and
 * #179 began writing it at CAPTURE — which means a row in this bucket is now the
 * most likely place in the app for a note to exist, and the one place it had
 * nowhere to be read.
 *
 * The two halves arrive as props rather than being built here: the caller wraps
 * this row in `TaskNoteRow`, which is what picks the grain, so the trigger can go
 * inside `RowActions` beside Complete (owner request, settled on !270) with the
 * body below the action line and still inside this row's `<li>`.
 */
function ItemRow({
  item,
  settings,
  voice,
  now,
  isDragging,
  onBreakdown,
  onMoveToMultiStep,
  onKeep,
  onSaveForLater,
  onComplete,
  confirmingDelete,
  onRequestDelete,
  onConfirmDelete,
  onCancelDelete,
  onFreshen,
  onDismissPrompt,
  schedule,
  scheduled = false,
  icsMenu,
  scheduleError,
  dragGrip,
  editButton,
  titleEditor,
  noteTrigger,
  noteBody,
}: {
  item: Item;
  settings: AgingSettings;
  voice: Voice;
  now: number;
  isDragging?: boolean;
  /** `startBreakdown` — creates the Task and NAVIGATES to the breakdown screen.
   * Labelled `action.breakNow` ("Break into steps"), an imperative because a menu
   * entry is a command; the card's inline red CTA keeps the question mark. */
  onBreakdown: () => void;
  /** #253 F1 — PARK the item in Multi-step without navigating, through
   * `moveItemToBucket(id, "multiStep")` and nothing else, so `dropPlan`, the no-op
   * guard, the `{ field: "move" }` retry grain and `movedAnnouncement` stay
   * byte-identical to the drag path.
   *
   * This row previously had **no** route to Multi-step at all. Its
   * `action.breakdownFull` entry was wired to `onBreakdown`, and `startBreakdown`
   * writes `Triaged` + `triagedAt` and never `breakdownRequestedAt` — so
   * `bucketOfItem` landed the item in **singleTask** while the label named
   * Multi-step. With this row's 📥 deleted by #253, a pointer drag was the only
   * honest route, and `drag-announce.ts` states in the repo's own words that the
   * menu is not a fallback for dragging but *is* the keyboard and
   * assistive-technology path (WCAG 2.1.1, 2.5.7) — so this was an accessibility
   * gap, not a cosmetic one.
   *
   * Both entries are offered because they are different acts, not two spellings of
   * one: parking rests the item in Multi-step indefinitely (nothing reaps
   * `breakdownRequestedAt`), breaking down now opens the editor. */
  onMoveToMultiStep: () => void;
  onKeep: () => void;
  /** "Save for later" — a direct MOVE to the Saved bucket, dispatched through
   * the same `moveItemToBucket` path drag and MoveToMenu use. #253 removed this
   * row's separate `onSnooze` prop rather than leaving it accepting a handler
   * nothing renders: it dispatched the same `snoozeBrainDumpItem(id, 60)` this
   * one reaches through `dropPlan`, so it was a second route to one write. */
  onSaveForLater: () => void;
  onComplete: () => void;
  confirmingDelete: boolean;
  onRequestDelete: () => void;
  onConfirmDelete: () => void;
  onCancelDelete: () => void;
  onFreshen: () => void;
  onDismissPrompt: () => void;
  schedule: ScheduleControlProps | null;
  /** Renders the "Scheduled ✓" indicator when the row's task has a scheduledAt marker. */
  scheduled?: boolean;
  /** Owner-only ▾ "Add to calendar (.ics)" entry, rendered after the schedule
   *  mirror. Null for guests (whose primary control is already the ICS one). */
  icsMenu?: React.ReactNode;
  scheduleError?: string;
  dragGrip?: React.ReactNode;
  editButton?: React.ReactNode;
  titleEditor?: React.ReactNode;
  /** #186 — the note disclosure's two halves, from the `TaskNoteRow` this row is
   *  wrapped in. The trigger joins the action group; the body opens below it. */
  noteTrigger?: React.ReactNode;
  noteBody?: React.ReactNode;
}) {
  // #105 — every age question this row asks is answered by the ONE clock it was
  // handed. Each of these three used to default to a fresh `Date.now()`, and all
  // three feed rendered output (the amber age tint, the StatusPill's WORDS, and
  // whether the "still needed?" nudge exists at all), so a boundary crossed
  // between the server's render and hydration was a structural mismatch, not
  // just a stale label. In demo mode (`demoOverrideSeconds`) those boundaries
  // are seconds apart, which is well inside the server↔hydration gap.
  const aging = isAging(item.createdAt, settings, now);
  const tier = freshnessTier(item.createdAt, item.freshenedAt, settings, now);
  const showStillNeededPrompt = shouldPrompt24h(
    item.createdAt,
    item.freshenedAt,
    item.promptDismissedAt,
    settings,
    now,
  );
  // #253 — one resting shape, not two. This factory had an `icon` variant for the
  // end cluster and a `fullWidth` one for the ▾ list, both driven by the same
  // `confirmingDelete`; the cluster is gone, so the ▾ entry is the route and the
  // `icon` branch had no caller left. `rowMenuEntry` keeps it at 44px, which the
  // old mirror-only entry never was — it did not need to be while a 44px 🗑 sat
  // beside it.
  const deleteControl = (key: string) =>
    confirmingDelete ? (
      <span key={key} className="flex items-center gap-2">
        {/* #251 review — the FOURTH copy of the armed confirm, and the last one
            still at 24px. #251 sized the other three and diagnosed why the guard
            could not see any of them (`expectFullTargets` measures every control
            in `[data-row-actions]` but never opens a confirm), then added
            confirm-opening tests for two — leaving this one, which is rendered
            for every untriaged inbox row and is therefore the busiest surface in
            the app. The pair REPLACES the 44px 🗑 that opened it, so a small pair
            shrinks the action line under the pointer at exactly the moment a
            mis-tap deletes something (WCAG 2.5.5). */}
        <button
          onClick={onConfirmDelete}
          className={cn(
            touchTarget,
            "text-destructive rounded-md px-2.5 py-1 font-medium",
          )}
        >
          {t("action.delete", voice)}
        </button>
        {/* Punctuation between two buttons, so it is hidden rather than read as
            content — the treatment both library factories got in #251 and
            neither inbox one, which had the same confirm reading "Delete ·
            Cancel" here and "Delete Cancel" there. */}
        <span aria-hidden="true" className="text-muted-foreground">
          ·
        </span>
        <button
          onClick={onCancelDelete}
          className={cn(
            touchTarget,
            "text-muted-foreground hover:text-foreground rounded-md px-2.5 py-1",
          )}
        >
          {t("action.cancel", voice)}
        </button>
      </span>
    ) : (
      <button
        key={key}
        // Colours unchanged from the ▾ entry this replaces: muted at rest,
        // `hover:text-foreground` on the accent background.
        className={rowMenuEntry("text-muted-foreground hover:text-foreground")}
        onClick={onRequestDelete}
      >
        {t("action.delete", voice)}
      </button>
    );
  return (
    <li
      className={cn("rounded-lg border px-4 py-3", isDragging && "opacity-40")}
    >
      <div className="flex items-start gap-2">
        {dragGrip}
        <div className="min-w-0 flex-1 space-y-1">
          {/* #51: the title is the dominant text — larger + heavier than the
              metadata line below it. */}
          <div className="flex items-center gap-2">
            {titleEditor ?? (
              <>
                <span className="text-lg font-semibold break-words">
                  {item.text}
                </span>
                {editButton}
              </>
            )}
          </div>
          {/* #52: the age/status pill is demoted off the title line down onto
              the metadata line, left of "captured x ago", at meta size. */}
          <div className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5">
            <StatusPill tier={tier} voice={voice} size="meta" />
            <span aria-hidden="true" className="text-muted-foreground text-xs">
              ·
            </span>
            <AgeLabel createdAt={item.createdAt} aging={aging} now={now} />
          </div>
          {/* #57 (follow-up to #50): a tinted "notification chip" — a compact
          rounded row with a soft aging/amber tint + subtle border and a clock
          icon, so the stale nudge reads as a notification instead of the muted
          background-noise text #50 left behind. Reuses the #40 aging/amber
          token family (the same bg/border/ink the resume-step banner + focus
          callouts use), so it stays WCAG-AA in light AND dark with no invented
          colours. Sits below the metadata line, above the action row, and stays
          subordinate to the text-lg title (text-sm, compact padding — no heavy
          box, the #50 lesson). Still-need-it / Dismiss keep ≥44px hit targets
          (touchTarget) and full keyboard access; the "Still need it" handler is
          unchanged (onFreshen → freshenItem), likewise Dismiss (dismissPrompt). */}
          {showStillNeededPrompt && (
            <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 rounded-lg border border-amber-500/40 bg-amber-50 px-2.5 py-1 text-sm text-amber-800 dark:bg-amber-950/20 dark:text-amber-300">
              <Clock aria-hidden="true" className="h-4 w-4 shrink-0" />
              <span className="min-w-0 flex-1">
                {t("prompt.stillNeeded", voice)}
              </span>
              <span className="flex shrink-0 items-center gap-1">
                <button
                  onClick={onFreshen}
                  className={cn(
                    "rounded-md border border-amber-500/40 px-2.5 font-medium hover:bg-amber-100 dark:hover:bg-amber-900/40",
                    touchTarget,
                  )}
                >
                  {t("action.stillNeeded", voice)}
                </button>
                <button
                  onClick={onDismissPrompt}
                  className={cn(
                    "rounded-md px-2 font-medium hover:underline",
                    touchTarget,
                  )}
                >
                  {t("action.dismiss", voice)}
                </button>
              </span>
            </div>
          )}
          <RowActions
            inline={[
              <button
                key="breakdown"
                onClick={onBreakdown}
                className={cn(
                  touchTarget,
                  "bg-primary text-primary-foreground rounded-md px-2.5 py-1 font-medium hover:opacity-90",
                )}
              >
                {t("action.breakdown", voice)} →
              </button>,
              // #253 — Add to-do left the row for the ▾ list. Four inline actions
              // remain, and they are the four every bucket sharing this shape now
              // shows: main CTA, Save, Complete, Note.
              <button
                key="save-for-later"
                onClick={onSaveForLater}
                // Named by its visible text. An earlier pass in #253 gave this an
                // `aria-label` of the full "Save for later", to compensate for
                // dropping the ▾ entry that carried those words — and that entry is
                // back, because the ▾ list is the row's CANONICAL list and the
                // inline bar a shortcut subset of it. So the compensation is not
                // only unnecessary, it was actively wrong: it put two controls
                // answering to "Save for later" in one row, which is an ambiguous
                // target for voice control (WCAG 2.5.3's neighbourhood) and breaks
                // every row-scoped query for either of them.
                //
                // `title` stays. It does not enter the accessible name while
                // visible text is present, so it adds the full wording on hover
                // without creating the collision.
                title={t("action.saveForLater", voice)}
                className={cn(
                  touchTarget,
                  "hover:bg-accent rounded-md px-2.5 py-1 font-medium",
                )}
              >
                {t("action.saveShort", voice)}
              </button>,
              <CompleteButton
                key="complete"
                voice={voice}
                onClick={onComplete}
              />,
              // #186 — beside Complete, the placement !270 settled for every
              // list row. Null on a row whose caller has not been given the
              // item's id, which `RowActions` renders as nothing.
              noteTrigger,
            ]}
            scheduled={scheduled}
            /* ── The ▾ list, #253's second half ──────────────────────────────

               THE PRINCIPLE, and it is the owner's: **the ▾ list is the canonical,
               complete list of a row's actions; the inline bar is a shortcut subset
               of it.** An earlier pass in this issue deleted every entry that
               mirrored an inline button, on the theory that a duplicate is clutter.
               It is withdrawn. #253 is a complaint about the ROW'S HEIGHT, and this
               list lives behind a trigger — its length costs no vertical space on
               the card, so tidying it bought nothing and cost the one place that can
               be relied on to hold everything. Four entries came back here:
               `action.breakdownFull`, `action.addTodoFull`, `action.saveForLater` and
               `action.completeFull`.

               ⚠️ **The nested `Move to…` picker is GONE, and this list is why.**
               The owner's observation on seeing it rendered: the four entries below
               ARE the buckets — `Break into multi-step to-do` → Multi-step,
               `Add as single-task to-do` → Single-task, `Save for later` → Saved,
               `Mark as completed` → Completed — so a submenu offering the same four
               was a second route to the same places, one tap deeper, and the only
               nested popup left in the list. Verified against `ACTION_FOR_BUCKET`
               (move-dispatch.ts) rather than assumed: it maps five buckets, the
               picker offered every bucket but this row's own, and those four are
               exactly the four it offered here. The fifth, `needsReview`, is this
               row's own bucket, so the picker never offered it and nothing is lost.
               Coverage on the other three renderers was NOT complete — see each of
               their menus for the entries added there.

               Drag is untouched, and `ACTION_FOR_BUCKET` / `dropPlan` stay: only the
               menu entry went. `MoveToMenu` itself is still rendered by the two
               compact inline 📥 controls (the idle Saved row and the Done row), so it
               is not orphaned.

               THE ORDER is the owner's. `Delete` is the destructive answer and stays
               last; the actions that reshape the item come first, in the order they
               escalate — break it up, keep it whole, park it, finish it — then the
               calendar pair. Groups are drawn with `rowMenuSeparator`, because
               sequence alone did not give the column any rhythm to read by.

               ⚠️ `Snooze 1h` is GONE from this list, by the owner's decision, and it
               is worth recording that this file's own long-standing note about it was
               half wrong. The note said snooze "is a SEPARATE action from Save for
               later" — the literal one-hour timer versus a bucket move — and treated
               collapsing them as a regression. Only the PATH differed. `dropPlan`'s
               `ACTION_FOR_BUCKET.savedLater` is `"snooze"` (move-dispatch.ts:15), so
               `moveItemToBucket(id, "savedLater")` runs the identical
               `snoozeBrainDumpItem(id, 60)` that entry ran; what the entry actually
               skipped was the dispatcher's no-op guard and its `role="status"` move
               announcement (#163/#225), which makes it the WORSE of the two routes for
               a screen-reader user. Nothing became unreachable: `Save for later` here,
               the inline `Save`, `Move to… → Saved for later`, a drag onto that bucket
               and the library bulk bar all still write it. */
            menu={groupedRowMenu([
              [
                // #253 F1 — the two break-up entries. FIRST is the navigating one,
                // deliberately: it is what this slot did before F1, so
                // behaviour-by-position is preserved and a user who reached for the
                // first entry still lands in the editor. Only its LABEL changed
                // (`action.breakdownFull` → `action.breakNow`), because the old one
                // named a bucket this action does not produce.
                <button
                  key="break-now-m"
                  onClick={onBreakdown}
                  className={rowMenuEntry()}
                >
                  {t("action.breakNow", voice)}
                </button>,
                // SECOND is the park, which this row did not have at all. Same label
                // as the Single-task row's Multi-step entry, since both land the
                // item in the same bucket by the same dispatcher.
                <button
                  key="multi-m"
                  onClick={onMoveToMultiStep}
                  className={rowMenuEntry()}
                >
                  {t("action.breakdownFull", voice)}
                </button>,
                <button
                  key="keep-m"
                  onClick={onKeep}
                  className={rowMenuEntry()}
                >
                  {t("action.addTodoFull", voice)}
                </button>,
                <button
                  key="save-for-later-m"
                  onClick={onSaveForLater}
                  className={rowMenuEntry()}
                >
                  {t("action.saveForLater", voice)}
                </button>,
                <button
                  key="complete-m"
                  onClick={onComplete}
                  className={rowMenuEntry()}
                >
                  {t("action.completeFull", voice)}
                </button>,
              ],
              [
                schedule ? (
                  <ScheduleControl
                    key="schedule-m"
                    {...schedule}
                    variant="menu"
                    label={scheduleMenuLabel(schedule.state, voice)}
                  />
                ) : null,
                icsMenu,
              ],
              [deleteControl("delete-m")],
            ])}
          />
          {scheduleError && (
            <p className="text-destructive mt-1 text-xs">{scheduleError}</p>
          )}
          {/* #186 — below the action line, still inside this row's <li>, so the
              note reads as belonging to this row. Also where the SAVED note is
              rendered while collapsed: #179 splits notes off at capture, so this
              is the bucket where one most often already exists. */}
          {noteBody}
        </div>
      </div>
    </li>
  );
}

function AgeLabel({
  createdAt,
  aging,
  now,
}: {
  createdAt: Date;
  aging: boolean;
  now: number;
}) {
  const ms = now - new Date(createdAt).getTime();
  const label = formatAgo(ms);
  return (
    <p
      className={cn(
        "text-xs",
        // AA-tuned per theme (WCAG 4.5:1 in BOTH light and dark), matching the
        // aging freshness tier in status-pill.tsx. The old flat `text-amber-600`
        // dropped to 3:1 on the #40 warm-tinted light background — a serious
        // color-contrast failure that only surfaces once a row ages (the axe
        // gate scans fresh items), exposed alongside the #57 stale nudge.
        aging ? "text-amber-700 dark:text-amber-400" : "text-muted-foreground",
      )}
    >
      captured {label}
    </p>
  );
}
/**
 * Persistent "N need triage" badge. Dismissable (✕); once dismissed it stays
 * hidden until a new item is captured or an item crosses into Aging (tracked
 * against the previous counts). Dismissal is not persisted, so it resets on
 * reload — matching the spec.
 */
function NavBadge({
  untriagedCount,
  agingCount,
}: {
  untriagedCount: number;
  agingCount: number;
}) {
  const [dismissed, setDismissed] = useState(false);
  const prev = useRef({ untriaged: untriagedCount, aging: agingCount });

  useEffect(() => {
    if (
      untriagedCount > prev.current.untriaged ||
      agingCount > prev.current.aging
    ) {
      setDismissed(false);
    }
    prev.current = { untriaged: untriagedCount, aging: agingCount };
  }, [untriagedCount, agingCount]);

  if (dismissed || untriagedCount === 0) return null;

  return (
    <div className="bg-secondary flex items-center justify-between rounded-lg px-3 py-2 text-sm">
      <span>
        <strong>{untriagedCount}</strong> need triage
        {/* amber-800 (not -700) in light: this count sits on the more saturated
            `bg-secondary` lavender, where -700 lands at 4.36:1 — just under
            AA-normal. dark:-400 matches the aging tier elsewhere. */}
        {agingCount > 0 && (
          <span className="text-amber-800 dark:text-amber-400">
            {" "}
            · {agingCount} aging 🟡
          </span>
        )}
      </span>
      <button
        aria-label="Dismiss"
        onClick={() => setDismissed(true)}
        className="text-muted-foreground hover:text-foreground px-1"
      >
        ✕
      </button>
    </div>
  );
}
