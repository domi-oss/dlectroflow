"use client";

import { useEffect, useId, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { RefreshCw, RotateCcw, TriangleAlert } from "lucide-react";
import {
  addShoppingItem,
  deleteShoppingItem,
  renameShoppingItem,
  setShoppingItemDone,
  setShoppingItemSavedForLater,
} from "@/app/actions/shopping";
import {
  MAX_SHOPPING_ITEMS,
  shoppingItemTextError,
  shoppingRemainingCount,
  splitShoppingList,
  type ShoppingItemView,
  type ShoppingWriteRefusal,
  type ShoppingWriteResult,
} from "@/lib/shopping";
import { COMPLETE_TEXT } from "@/lib/completion-style";
import {
  ActionTimeoutError,
  isStaleActionError,
  withActionTimeout,
} from "@/lib/server-action-failure";
import { t, type StringKey, type Voice } from "@/lib/strings";
import { cn } from "@/lib/utils";

/**
 * #199, Duo review round 4 (!294) — how long this page is willing to WAIT for a
 * write before calling it a failure.
 *
 * The third failure mode is silence rather than a rejection: a pod rolling
 * mid-request, a connection that never closes. From the user's side an
 * un-timed-out `await` is indistinguishable from the silent no-op this whole
 * notice exists to kill. Every action behind this page is one short Prisma
 * statement (the add's cap check is a SERIALIZABLE transaction, still short), so
 * ten seconds is already pathological; it matches `CAPTURE_TIMEOUT_MS` in
 * `inbox-view.tsx` and `ACTION_TIMEOUT_MS` in `focus-timer.tsx` for the same
 * class of call. The request itself carries on — a server action cannot be
 * aborted from the client — so a write that lands late still lands, and the next
 * `router.refresh()` picks it up. Exported so the test advances the real value
 * rather than a copy of it.
 */
export const SHOPPING_ACTION_TIMEOUT_MS = 10_000;

/**
 * The three refusals the capture field says about itself, and the only ones it
 * has words for. Server-side and client-side arrivals of the same three are the
 * same message — see `declineWrite`.
 */
type FieldRefusal = "empty" | "too-long" | "full";

const isFieldRefusal = (
  refusal: ShoppingWriteRefusal,
): refusal is FieldRefusal =>
  refusal === "empty" || refusal === "too-long" || refusal === "full";

/**
 * WHICH write a failure is about — Duo review round 6, !294.
 *
 * The notice used to recognise "the write this record is about has now
 * succeeded" by comparing the held closure in `fn` by REFERENCE, and only the
 * notice's own Retry ever hands the same closure back: every ordinary control
 * builds a fresh one on every render. So a user who simply pressed Add again, or
 * ticked the box again, could never match. The banner from the earlier attempt
 * stayed on screen beside the write that had just landed, and its Retry then
 * re-posted the OLD call with the OLD arguments — reverting a rename the user
 * had since made, or storing an item a second time.
 *
 * A failure belongs to a logical target, so that is what it is keyed by. `fn` is
 * still held, but only to re-run; it is no longer an identity.
 *
 * **The add is keyed by its WORDS**, because it has no row to name and the words
 * are the only thing that makes one add the same request as another. Adding
 * "bread" after "oat milk" failed leaves the "oat milk" notice up, correctly —
 * those are two different things to buy and its Retry still means what it says.
 * Adding "oat milk" again clears it, which is what stops the Retry storing a
 * second one.
 *
 * **A row write is keyed by row AND field**, not by row alone. A failed rename is
 * not answered by a successful tick of the same row: the words still did not
 * save, and re-posting them is still exactly the right thing. Keying by row
 * alone would throw away a failure the user has not been told about, which is
 * the same family of bug from the other side.
 */
type WriteTarget =
  | { kind: "add"; text: string }
  | { kind: "item"; id: string; field: "text" | "done" | "saved" | "delete" };

/** No collision between the two arms: an item key never starts with `add:`,
 *  whatever a user types. */
const targetKey = (target: WriteTarget): string =>
  target.kind === "add"
    ? `add:${target.text}`
    : `item:${target.id}:${target.field}`;

const sameTarget = (a: WriteTarget, b: WriteTarget): boolean =>
  targetKey(a) === targetKey(b);

/**
 * A write that did not land.
 *
 * ONE slot, not a queue: a second failure displaces the first. That boundary is
 * #210's, argued there at length and deliberately not re-opened here — stacking
 * is a parked design question, and inventing a second answer to it on this page
 * would be the divergence this fix exists to avoid.
 */
type WriteFailure = {
  /**
   * The words the failed write was about — the new text for an add or a rename,
   * the item's own text for a tick, a save-for-later or a delete. Held here, not
   * just referenced, so the notice is itself a copy of them: for an add they are
   * otherwise only in a closure.
   */
  subject: string;
  /**
   * The browser is running a different deployment than the server. Next
   * regenerates server-action ids on every build, so a retry re-posts the same
   * dead id — the only thing that can work is a reload.
   */
  stale: boolean;
  /**
   * The write never answered, so **whether it landed is unknown**. The timeout
   * bounds how long the UI waits, not the request, so the write may still
   * complete. Kept distinct from the generic failure because "couldn't save
   * that" would then be a claim the client cannot support.
   */
  timedOut: boolean;
  /**
   * The server answered, and the answer was no — Duo review round 5, !294.
   *
   * A THIRD way a write fails to land, and the one nothing here could see:
   * `stale` and `timedOut` are both silence, this one is a reply. It sits beside
   * them rather than in a state of its own because everything downstream — the
   * one slot, the quoted words, the retry-by-identity — is the same; only the
   * message and which control to offer differ, and both are decided from here.
   *
   * `undefined` covers two cases that behave identically: a transport failure,
   * and an answer that was not a result at all (an action from another build can
   * resolve to nothing). Both get the generic copy and a Retry.
   */
  refused?: ShoppingWriteRefusal;
  /** A retry of THIS write is in flight. */
  retrying: boolean;
  /**
   * What the failed write was aimed at — see {@link WriteTarget}. This is the
   * identity every "is the record on screen the one this attempt is about?"
   * question is answered by.
   */
  target: WriteTarget;
  /**
   * Which attempt produced this record, from the page's own monotonic counter.
   *
   * Held so an OLDER attempt settling late cannot rewrite a newer record for the
   * same target — a success only clears a notice it is strictly newer than.
   * Round 4 established the same rule for the in-flight flag (`markRetrying`);
   * this is it applied to the record itself.
   */
  seq: number;
  /**
   * The exact call that failed, so Retry re-runs *that* rather than a rebuilt
   * guess at it. Deliberately NOT an identity any more (Duo review round 6,
   * !294): every ordinary control builds a new closure on every render, so
   * comparing references could only ever match the notice's own Retry.
   */
  fn: () => Promise<ShoppingWriteResult>;
  /**
   * Set only for the add, the one write with a stake in the capture field:
   * `submit()` empties it before the round trip, so a failure has to put the
   * words back and a later success has to make sure they do not linger into a
   * duplicate.
   */
  draftText?: string;
};

/**
 * Which message a failure gets — ordered by how much the user can be told,
 * most-certain first. `stale` and `timedOut` both override the generic copy
 * because both change what the user should DO. Mirrors `writeFailureKey` in
 * `inbox-view.tsx`, and `captureMessageKey` there / `failureMessageKey` in
 * `focus-timer.tsx` for the two notices that have no row to lose.
 *
 * Every cell of it is enforced across surfaces by `write-notice-hygiene` (#246),
 * which exists because this function was one cell short for a release and nothing
 * failed: it read as complete to anyone auditing by grep for the helper.
 */
function writeFailureKey(failure: WriteFailure, rowGone: boolean): StringKey {
  if (failure.stale) return "shopping.errorSaveStale";
  // #246 — the two facts together, and neither of the messages below is honest
  // about the pair. `writeFailureRemedy` has already withdrawn every control by
  // the time this is true, so the timeout's "before trying again" promises a
  // button that is not on the screen; and the user is being sent to check a list
  // the page has itself just checked. Kept ABOVE `timedOut` for that reason, and
  // separate from `errorSaveGone` because it must not inherit "nothing changed" —
  // see the note below, which applies to this arm too.
  if (failure.timedOut && rowGone) return "shopping.errorSaveTimeoutGone";
  // Stays ABOVE `rowGone`: a timeout's verdict is genuinely unknown, and "nothing
  // changed" would be a claim the client cannot support — the row may be absent
  // BECAUSE the write it is unsure about landed. While the row is still on the
  // list, "check the list" is the honest instruction, the list is exactly where
  // the answer is, and a Retry is offered to act on what is found.
  if (failure.timedOut) return "shopping.errorSaveTimeout";
  // A refusal is not a breakage, and saying "couldn't save that just now" about
  // one would send the user to look at their connection. Only the two the
  // capture field has no words for reach this: the other three are said by the
  // field, about itself (see `declineWrite`), and `conflict` genuinely is
  // "couldn't save that just now", so it falls through on purpose.
  if (failure.refused === "unavailable") return "shopping.errorSaveOff";
  // The server saying the row is gone and the page rendering a list without it
  // are the same situation, so they get the same words (Duo review round 6,
  // !294). Otherwise a withdrawn Retry would be unexplained: a notice reading
  // "couldn't save that just now" with no button to press is a dead end.
  if (failure.refused === "missing" || rowGone) return "shopping.errorSaveGone";
  return "shopping.errorSaveFailed";
}

/**
 * What, if anything, the notice can offer that could actually work.
 *
 * Was a binary `stale ? reload : retry`, which was right while every failure was
 * silence. A refusal is a reasoned answer, so re-posting the identical call is
 * refused for the identical reason — offering a Retry there is a button whose
 * only possible outcome is the message already on screen (Duo review round 5,
 * !294).
 */
function writeFailureRemedy(
  failure: WriteFailure,
  rowGone: boolean,
): "reload" | "retry" | "none" {
  // Retrying re-posts an action id the running deployment has forgotten.
  if (failure.stale) return "reload";
  // The feature was switched off elsewhere, so this page is no longer live; a
  // reload is what shows the user where they now are.
  if (failure.refused === "unavailable") return "reload";
  // The row is gone. Matching it again matches nothing again, every time — and
  // the refresh that accompanies this refusal has already taken it off screen.
  //
  // `rowGone` is the same fact arriving the other way round (Duo review round 6,
  // !294): the rendered list no longer holds the row, so the page can say this
  // without a round trip whose only possible answer is `missing`. Offering a
  // button that cannot work is the display half of the finding this round fixes.
  //
  // #246 — this arm swallows `timedOut`, and that is the decision rather than the
  // oversight. A timeout does not weaken the case for withdrawing the button, it
  // strengthens it: retrying either re-posts a write that already landed or matches
  // nothing, and BOTH settle as a silent success that clears the notice. A false
  // "saved this time" is worse than the dead end it would replace.
  // `writeFailureKey` carries the other half — a message that no longer offers a
  // "trying again" this function is about to take away.
  if (failure.refused === "missing" || rowGone) return "none";
  return "retry";
}

/**
 * #199 — shopping-list mode.
 *
 * ## What is not here is the point
 *
 * No estimate field, no "break into steps", no Schedule menu, no ▶ Focus. Every
 * other list surface in this app offers all four, and a row here that grew one
 * would put a shopping item into machinery the model deliberately keeps it out of
 * — so their absence is asserted in `shopping-list.test.tsx` rather than left to
 * be noticed. The intro copy says the same thing to the reader, because a list
 * that quietly lacks the app's usual affordances otherwise reads as unfinished.
 *
 * ## Server-rendered rows, client-side capture
 *
 * `items` are props from the `force-dynamic` page; each action revalidates
 * `/shopping` and this component calls `router.refresh()`, which is the pattern
 * the Settings sections use. Deliberately NOT an optimistic local copy: the list
 * is short, every write is one round trip, and an optimistic list is a second
 * source of truth for a count that #199 part 2 has to keep in sync with an inbox
 * row. One source of truth is worth more here than one frame of latency.
 *
 * ## The refusals are three messages, not one
 *
 * Empty, too long, and list-full are separate strings, and the field is marked
 * `aria-invalid` and wired to the message with `aria-describedby` (WCAG 3.3.1
 * Error Identification, 3.3.3 Error Suggestion). A capture field that fails
 * without saying which rule was broken is the failure mode that makes people stop
 * trusting it — and a silent no-op looks exactly like a lost item.
 *
 * ## …and a write that does not land is a fourth
 *
 * Duo review round 4, !294: the paragraph above was true of the three refusals
 * this component decides for itself, and false of everything the server decides.
 * `run()` awaited the action with no `catch`, so a genuine failure in add,
 * rename, tick, save-for-later or delete produced exactly the silent no-op the
 * paragraph warns about — and for an add it is worse than a no-op, because
 * `submit()` empties the field before the round trip.
 *
 * The fix is #210's inbox capture notice, applied here rather than reinvented:
 * the same three-way split from `server-action-failure.ts` (stale bundle /
 * no answer / everything else), the same `role="alert"` notice quoting the words,
 * the same `aria-disabled`-not-`disabled` Retry. Two capture surfaces that fail
 * in two different shapes is a worse outcome than either shape.
 *
 * ## …and a write the server DECLINED is a fifth
 *
 * Duo review round 5, !294, and it is a different mechanism from the paragraph
 * above rather than more of it. Nothing throws: `addShoppingItem`'s cap check
 * `return`s from inside its transaction, so a blocked add resolved exactly like a
 * stored one. `attempt()` read "did not throw" as "landed", cleared the draft and
 * refreshed — and the typed words were gone with no message anywhere.
 *
 * The client's own pre-check cannot close it. `items.length >= MAX_SHOPPING_ITEMS`
 * in `submit()` reads the last server-rendered prop, which is a round trip behind
 * the moment a second submission or another tab is involved; that is the point of
 * a cap enforced on the server. So the pre-check stays as the fast local answer
 * and the server's refusal is now the authoritative one.
 *
 * **Each refusal is said by whichever of this page's two voices already says it.**
 * Empty, too long and full are the capture field's own three refusals, so a
 * server-side one of those is the same message on the same control, decided a
 * round trip later (WCAG 3.3.1 — the error is identified on the thing it is
 * about). Everything the field has no words for — the row has gone, the feature
 * was switched off, the write lost its race twice — goes to the notice. What is
 * NOT done is a third vocabulary: no new component, no second notice, no
 * "declined" state living apart from `WriteFailure`.
 *
 * ## …and the notice going away is the sixth
 *
 * Duo review round 6, !294. The five above are all about SAYING something; this
 * one is about unsaying it. The notice recognised the write it was about by
 * comparing a held closure by reference, which only its own Retry can ever
 * satisfy — so pressing Add again, or ticking the box again, left the banner
 * from the earlier attempt sitting beside the write that had just landed, and
 * its Retry then re-posted the older call with the older arguments. A failure is
 * keyed by a logical target instead; the argument for which target, and why the
 * add's is its words rather than "the capture field", is on {@link WriteTarget}.
 */
export function ShoppingList({
  items,
  voice,
}: {
  items: readonly ShoppingItemView[];
  voice: Voice;
}) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<FieldRefusal | null>(null);
  /**
   * The words of an add the SERVER refused, held so the refusal message can quote
   * them — but only on the occasion they are nowhere else.
   *
   * `submit()` empties the field before the round trip, and the restore below
   * declines to overwrite anything the user has typed since. When it declines,
   * this is the words' only remaining copy; when it does not, `draft` holds them
   * and quoting them again would be the message repeating the field back at it.
   * Which of the two happened is read off `draft` at render, so nothing has to
   * track the outcome of a state update.
   */
  const [refusedWords, setRefusedWords] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  /**
   * Why the rename has its OWN refusal state rather than sharing `error`:
   * a rename can be refused while the capture field is untouched (and vice versa),
   * and one shared slot would let a rename's message appear under the Add field —
   * pointing `aria-describedby` at a message about a different control.
   *
   * Duo review, !294: a rename had no validation and no feedback at all. An
   * over-long or blanked value called the action, which returned silently, and the
   * row reverted with no explanation — the exact "a silent no-op looks like a lost
   * item" failure this file's docblock warns about for the Add flow. Both flows now
   * run through `shoppingItemTextError`.
   *
   * It is still ONE slot across all the rows, which is fine only because exactly
   * one editor is ever open. Opening another row's editor therefore clears it (see
   * the trigger's `onClick`): without that, the same "a message about a different
   * control" fault this comment describes reappeared one level down, between two
   * rows instead of between the row and the Add field. Found while fixing the
   * round-4 findings — the paragraph above was already the argument against it.
   */
  const [editError, setEditError] = useState<"empty" | "too-long" | null>(null);
  const errorId = useId();
  const editErrorId = useId();
  const addFieldId = useId();
  const failureId = useId();
  const savingId = useId();
  const addFieldRef = useRef<HTMLInputElement | null>(null);

  /**
   * Duo review round 4, !294 — hand focus back when the rename editor closes
   * (WCAG 2.4.3 Focus Order).
   *
   * Closing unmounts the focused `<input>` and remounts the trigger in its place,
   * and the browser does not connect the two: focus falls to `<body>`, so a
   * keyboard or screen-reader user loses their place on the page the instant they
   * finish editing. This file already reasons about focus on the way IN
   * (`autoFocus`, and hiding the trigger rather than disabling it); this is the
   * same reasoning applied to the way out.
   *
   * A ref map keyed by item id rather than one ref, because the trigger to
   * return to belongs to a specific row and the rows are a list. Entries are
   * removed on unmount, so a deleted row cannot pin its button.
   */
  const renameTriggers = useRef(new Map<string, HTMLButtonElement>());
  /**
   * Which row's trigger is owed focus — set by `stopEditing` alone, which is why
   * switching straight to another row's editor does not steal focus back, and a
   * refused rename (editor stays open) does not move it at all. A ref rather than
   * state: a one-shot instruction to the effect below, not something anything
   * renders.
   */
  const returnFocusToTrigger = useRef<string | null>(null);
  useEffect(() => {
    // In an effect rather than beside the state update: the trigger does not
    // exist yet at that point — it is what replaces the editor being closed.
    if (editingId !== null) return;
    const id = returnFocusToTrigger.current;
    if (id === null) return;
    returnFocusToTrigger.current = null;
    renameTriggers.current.get(id)?.focus();
  }, [editingId]);

  /** Close the editor and drop any refusal with it — the message describes a value
   *  that is no longer on screen. Takes the row's id because closing owes that
   *  row's trigger the focus it is about to take. */
  const stopEditing = (id: string) => {
    returnFocusToTrigger.current = id;
    setEditingId(null);
    setEditError(null);
  };

  const [failure, setFailure] = useState<WriteFailure | null>(null);
  const retryRef = useRef<HTMLButtonElement | null>(null);
  /**
   * The notice's Retry was the focused element when it succeeded, so its unmount
   * is about to drop focus to `<body>` — the same WCAG 2.4.3 fault as the rename
   * editor above, in the control that reports it. Focus goes to the capture
   * field, which is the notice's nearest surviving neighbour and the thing a user
   * who has just recovered a lost add most likely wants.
   */
  const returnFocusToAddField = useRef(false);
  useEffect(() => {
    if (failure || !returnFocusToAddField.current) return;
    returnFocusToAddField.current = false;
    addFieldRef.current?.focus();
  }, [failure]);

  /**
   * How many writes this page has started, and how many are still outstanding.
   *
   * Refs, not state: nothing renders either, and a counter that triggered a
   * render would re-run the very effects the page uses to move focus.
   */
  const attempts = useRef(0);
  const outstanding = useRef(0);
  /**
   * The newest attempt at each target that LANDED — Duo review round 6, !294.
   *
   * Without it, two writes at the same target where the older one loses the race
   * end with a notice about a write that succeeded: the second add lands, the
   * first gives up, and the page reports words that are on the server while
   * restoring them into the field for the user to send a third time. An
   * impatient double-submit is the ordinary way to get there.
   *
   * Emptied whenever nothing is outstanding, because at that instant nothing can
   * read it — otherwise a long session accumulates one entry per distinct thing
   * ever bought.
   */
  const landedAt = useRef(new Map<string, number>());

  /**
   * Raise or drop `retrying`, and only on a record about this attempt's own
   * target — a failure that has since been displaced by one about something else
   * must not have its flag rewritten by an older attempt settling. Same lesson
   * `schedulingIds` applies per-row in `inbox-view.tsx` (#169): a shared
   * in-flight flag belongs to whichever request settles last, not to the one it
   * is guarding.
   *
   * No sequence test, unlike `clearFailureFor`: a record for this target can
   * only be showing `retrying` because THIS retry raised it, since a fresh
   * record always starts with the flag down.
   */
  const markRetrying = (target: WriteTarget, retrying: boolean) =>
    setFailure((prev) =>
      prev && sameTarget(prev.target, target) && prev.retrying !== retrying
        ? { ...prev, retrying }
        : prev,
    );

  /**
   * Drop the notice, if it is about this target and this attempt is newer than
   * the one that raised it.
   *
   * The target test is the fix (Duo review round 6, !294) and the sequence test
   * is its guard rail: a late success must not clear a fresher failure at the
   * same target, which would be a silent no-op of exactly the kind the last two
   * rounds removed.
   */
  const clearFailureFor = (target: WriteTarget, seq: number) =>
    setFailure((prev) =>
      prev && sameTarget(prev.target, target) && prev.seq < seq ? null : prev,
    );

  /**
   * Put the words back where the user left them — but never over the top of
   * something they have typed since.
   *
   * A ten-second hang is long enough to start the next item, and overwriting that
   * is the same data loss wearing the other hat. A functional updater, so it
   * stays pure under StrictMode's double invocation. Shared by the failure path
   * and the refusal path because it is the same promise to the user, and two
   * copies of it is how one of them stops being kept.
   */
  const restoreDraft = (draftText: string | undefined) => {
    if (draftText === undefined) return;
    setDraft((current) => (current.trim() === "" ? draftText : current));
  };

  /**
   * The server answered, and the answer was no — Duo review round 5, !294.
   *
   * Neither of the two outcomes `attempt` already had. The write did not land, so
   * it cannot be treated as a success; but nothing failed either, so the failure
   * notice's "couldn't save that just now" would point at the connection, and its
   * Retry would re-post a call that is refused for the same reason every time.
   */
  const declineWrite = (
    refused: ShoppingWriteRefusal | undefined,
    base: Omit<WriteFailure, "stale" | "timedOut" | "refused">,
  ) => {
    const draftText = base.draftText;
    restoreDraft(draftText);
    if (
      draftText !== undefined &&
      refused !== undefined &&
      isFieldRefusal(refused)
    ) {
      // The capture field already says all three of these, on the control they
      // are about (WCAG 3.3.1). Reaching for the notice instead would be a
      // second way to say something this page has words for — and the notice's
      // Retry would offer to re-post into a list that is still full.
      setError(refused);
      setRefusedWords(draftText);
      // A refusal answers the question a leftover notice about THIS target was
      // asking, so leaving it up would have the page contradict itself.
      clearFailureFor(base.target, base.seq);
    } else {
      setFailure({ ...base, refused, stale: false, timedOut: false });
    }
    // These two mean the server knows something the rendered `items` do not: the
    // list is full, or the row has gone. Re-reading is what corrects the page —
    // and, for the cap, what un-stales the pre-check that let the call through.
    // Deliberately not for the others: nothing changed for them to fetch.
    if (refused === "full" || refused === "missing") router.refresh();
  };

  /**
   * Every write on this page goes through here, which is the point: five actions
   * that can each fail, and one place that says so.
   */
  const attempt = (
    fn: () => Promise<ShoppingWriteResult>,
    target: WriteTarget,
    subject: string,
    { fromRetry, draftText }: { fromRetry: boolean; draftText?: string },
  ) =>
    startTransition(async () => {
      const seq = (attempts.current += 1);
      outstanding.current += 1;
      const key = targetKey(target);
      /**
       * A newer write at this same target has already landed, so whatever this
       * one has to say about it is out of date — and saying it would put the
       * user back where the last two rounds took them from: a page reporting
       * something other than what happened.
       */
      const overtaken = () => (landedAt.current.get(key) ?? 0) > seq;
      // A fresh record, so the retry flag starts down: this attempt is over,
      // whatever it was.
      const base = { fn, target, seq, subject, draftText, retrying: false };
      try {
        let answered = false;
        let result: ShoppingWriteResult | undefined;
        try {
          result = await withActionTimeout(fn(), SHOPPING_ACTION_TIMEOUT_MS);
          answered = true;
        } catch (error) {
          if (overtaken()) return;
          // When we cannot restore, the notice quotes the words instead, so they
          // are never only in a variable.
          restoreDraft(draftText);
          setFailure({
            ...base,
            stale: isStaleActionError(error),
            timedOut: error instanceof ActionTimeoutError,
          });
        }
        if (!answered) return;
        // `result?.ok`, not `result.ok`: an action from another build can resolve
        // to something that is not a result at all, and taking an unrecognised
        // answer for a success is precisely the bug round 5 removed. An
        // unnameable refusal gets the generic copy and a Retry.
        if (!result?.ok) {
          if (!overtaken()) declineWrite(result?.refused, base);
          return;
        }
        // `max`, because an attempt that started earlier can still land later.
        landedAt.current.set(
          key,
          Math.max(landedAt.current.get(key) ?? 0, seq),
        );
        // Read while the button still exists, and gated on `fromRetry` because
        // that is the only way it can be holding focus.
        if (fromRetry && retryRef.current === document.activeElement) {
          returnFocusToAddField.current = true;
        }
        // The words are on the server now, so leaving them in the field would
        // invite a duplicate on the next Enter — but only clear what is still
        // verbatim theirs, for the same reason the restore above is conditional.
        if (draftText !== undefined) {
          setDraft((current) => (current === draftText ? "" : current));
        }
        // Any notice about THIS target, not just the one this closure raised: a
        // fresh attempt at the same thing is how a user actually retries, and a
        // banner outliving the write it is about is what round 6 fixes.
        clearFailureFor(target, seq);
        // Deliberately not in the `catch`'s path: the write did not happen, so
        // there is nothing new to fetch, and a refresh that itself failed would be
        // a second unreported error.
        router.refresh();
      } finally {
        // Must run on every exit including a throw: a retry flag left up is a
        // Retry button that reads permanently busy.
        if (fromRetry) markRetrying(target, false);
        outstanding.current -= 1;
        if (outstanding.current === 0) landedAt.current.clear();
      }
    });

  const run = (
    fn: () => Promise<ShoppingWriteResult>,
    target: WriteTarget,
    subject: string,
    draftText?: string,
  ) => attempt(fn, target, subject, { fromRetry: false, draftText });

  const retryFailedWrite = () => {
    if (!failure || failure.retrying) return;
    // Raised OUTSIDE the transition on purpose: React 19 holds an async
    // transition's own state updates until the action settles, so a busy flag set
    // inside it would first paint at the moment it stopped being true — a
    // double-submit guard that guards nothing (#169's lesson, from `runSchedule`).
    markRetrying(failure.target, true);
    attempt(failure.fn, failure.target, failure.subject, {
      fromRetry: true,
      draftText: failure.draftText,
    });
  };

  /**
   * A failure aimed at a row the rendered list no longer holds — Duo review
   * round 6, !294.
   *
   * Derived from `items` rather than tracked, for the same reason `refusedWords`
   * is compared against `draft`: a second copy of a fact is how the page ends up
   * disagreeing with itself. `items` comes from the `force-dynamic` page, so its
   * losing a row IS the server saying the row has gone.
   */
  const failedRowId =
    failure?.target.kind === "item" ? failure.target.id : undefined;
  const failureRowGone =
    failedRowId !== undefined && !items.some((i) => i.id === failedRowId);

  const { active, savedForLater } = splitShoppingList(items);
  const remaining = shoppingRemainingCount(items);

  /** Both refusal slots move together: the words only ever accompany a message,
   *  and a stale pair is how a message ends up quoting the wrong item. */
  const showRefusal = (refusal: FieldRefusal | null) => {
    setError(refusal);
    setRefusedWords(null);
  };

  const submit = () => {
    // A fast local answer, NOT the authority. `items` is the last server-rendered
    // prop, so this is a round trip behind as soon as a second submission or
    // another tab is involved — which is why the server refuses too, and why a
    // refusal coming back is an ordinary outcome rather than a contradiction
    // (Duo review round 5, !294). The cap is checked before the text, because at
    // 500 rows "type something first" would be a true but useless answer to why
    // nothing happened.
    if (items.length >= MAX_SHOPPING_ITEMS) {
      showRefusal("full");
      return;
    }
    const refusal = shoppingItemTextError(draft);
    if (refusal) {
      showRefusal(refusal);
      return;
    }
    const text = draft;
    setDraft("");
    showRefusal(null);
    // The `draftText` argument is what makes this the one write with a stake in
    // the field: it was emptied a line ago, so a failure has to put the words
    // back. It repeats `text` because the two mean different things — the words
    // the notice quotes, and the words the field is owed back — and only the add
    // has both.
    run(() => addShoppingItem(text), { kind: "add", text }, text, text);
  };

  const refusalMessage = (refusal: FieldRefusal | null): string | null =>
    refusal === "empty"
      ? t("shopping.errorEmpty", voice)
      : refusal === "too-long"
        ? t("shopping.errorTooLong", voice)
        : refusal === "full"
          ? t("shopping.errorFull", voice)
          : null;

  // ONE mapping, shared with the per-row rename refusal (Duo review round 3, !294).
  // It was two copies of the same three-way switch, which is how a new refusal type
  // or a reworded message ends up in one and not the other.
  const errorMessage = refusalMessage(error);

  const countLabel = `${remaining} ${t(
    remaining === 1 ? "shopping.itemOne" : "shopping.itemMany",
    voice,
  )} ${t("shopping.stillToBuy", voice)}`;

  // A 44x44 touch target — the app's own floor, which is 2.5.5 Target Size
  // (Enhanced, AAA); the AA one is 2.5.8 (Minimum) at 24x24. And the focus
  // indicator is a RING rather than a background swap: a hover-coloured
  // background alone leaves nothing visible (2.4.7 Focus Visible, AA) and the
  // ring is what clears 2.4.13 Focus Appearance (AAA) too. axe implements no rule
  // for any of them, so the broken version would ship green (#117, #258). --ring
  // is the same token app-menu.tsx measured.
  const ICON_BUTTON =
    "text-muted-foreground hover:bg-accent hover:text-accent-foreground focus-visible:ring-ring inline-flex min-h-[44px] min-w-[44px] items-center justify-center rounded-md px-2 text-xs outline-none focus-visible:ring-2";

  const row = (i: ShoppingItemView, saved: boolean) => (
    <li key={i.id} className="flex min-h-[44px] items-center gap-2 text-sm">
      <input
        type="checkbox"
        checked={i.done}
        // The item's own text IS the accessible name. A checkbox named "Tick off"
        // twelve times down a list is unusable in a screen reader's element list,
        // which is the same reasoning every button below follows.
        aria-label={`${t("shopping.tickOff", voice)} ${i.text}`}
        onChange={(e) =>
          run(
            () => setShoppingItemDone(i.id, e.target.checked),
            { kind: "item", id: i.id, field: "done" },
            i.text,
          )
        }
        // A checkbox is a 16px control inside a 44px row: the row supplies the
        // target height, and the label wrapping it is not used here because the
        // row also holds three buttons, which a <label> may not contain.
        className="focus-visible:ring-ring h-4 w-4 shrink-0 outline-none focus-visible:ring-2"
      />
      {editingId === i.id ? (
        <RenameInput
          initial={i.text}
          label={`${t("shopping.rename", voice)} ${i.text}`}
          invalid={editError !== null}
          describedBy={editError !== null ? editErrorId : undefined}
          onChange={() => setEditError(null)}
          onCancel={() => stopEditing(i.id)}
          onSave={(value) => {
            // Unchanged is not a refusal: it is a no-op, and the editor closes.
            if (value === i.text) {
              stopEditing(i.id);
              return;
            }
            const refusal = shoppingItemTextError(value);
            if (refusal) {
              // Editor stays OPEN. Reverting would throw away what they typed as
              // well as failing silently, which is worse than either alone.
              setEditError(refusal);
              return;
            }
            stopEditing(i.id);
            // The NEW words are what is at stake, so they are what the notice
            // quotes if the write does not land — the row still shows the old
            // text, and quoting that would name the thing that did not change.
            run(
              () => renameShoppingItem(i.id, value),
              { kind: "item", id: i.id, field: "text" },
              value,
            );
          }}
        />
      ) : (
        <span
          // The strike comes from the shared completion token, never a hard-coded
          // `line-through`: it is an Appearance setting and re-hardcoding it is
          // what completion-style.ts exists to prevent. Ticked state is also
          // carried by the checkbox itself, so this is never colour-or-decoration
          // only (WCAG 1.4.1).
          className={cn("min-w-0 flex-1 break-words", i.done && COMPLETE_TEXT)}
        >
          {i.text}
        </span>
      )}
      {/* Hidden while THIS row's editor is open (Duo review round 2, !294). Two
          controls carrying the identical accessible name "Rename <item>" were on
          screen at once — the open textbox and this trigger — and the trigger sat in
          the tab order immediately after the field, so tabbing out of the input
          landed on a button that re-opens the editor already open.

          Removed rather than `disabled`: a disabled control cannot hold focus, and
          there is nothing here for a keyboard user to need it for while the field is
          open. That is the opposite call from the timer's retry button, which uses
          `aria-disabled` precisely because dropping it would strand focus — here the
          field it belongs to is right there and already focused. Another row's
          trigger is untouched. */}
      {editingId !== i.id && (
        <button
          type="button"
          // Registered so closing the editor can hand focus back to it (WCAG
          // 2.4.3) — see `returnFocusToTrigger`. Cleaned up on unmount so a
          // deleted row cannot pin its button in the map.
          ref={(el) => {
            if (el) renameTriggers.current.set(i.id, el);
            else renameTriggers.current.delete(i.id);
          }}
          aria-label={`${t("shopping.rename", voice)} ${i.text}`}
          // The refusal goes with the editor being left behind. `editError` is
          // ONE slot shared by every row, so opening this editor while another
          // row's refusal was showing used to carry it across — the new field
          // came up `aria-invalid` and pointed `aria-describedby` at a message
          // about the row above it (WCAG 3.3.1). That is verbatim the fault the
          // comment on `editError` says the state exists to prevent, one level
          // down: found while fixing Duo review round 4, !294.
          onClick={() => {
            setEditingId(i.id);
            setEditError(null);
          }}
          className={ICON_BUTTON}
        >
          {t("shopping.rename", voice)}
        </button>
      )}
      <button
        type="button"
        // `<action> <item>`, the same shape as the tick, rename and delete names
        // above. Deliberately not an interpolated sentence ("Save Apples for
        // later"): that needs the string to carry a placeholder in a fixed
        // grammatical position, and #86's voice layer is a flat label table with
        // no interpolation. A consistent `label — item` reads correctly in both
        // voices and stays correct if a label is reworded.
        aria-label={`${
          saved
            ? t("shopping.moveBackUp", voice)
            : t("shopping.saveForLater", voice)
        }: ${i.text}`}
        onClick={() =>
          run(
            () => setShoppingItemSavedForLater(i.id, !saved),
            { kind: "item", id: i.id, field: "saved" },
            i.text,
          )
        }
        className={ICON_BUTTON}
      >
        {saved
          ? t("shopping.moveBackUp", voice)
          : t("shopping.saveForLater", voice)}
      </button>
      <button
        type="button"
        aria-label={`${t("shopping.delete", voice)} ${i.text}`}
        onClick={() =>
          run(
            () => deleteShoppingItem(i.id),
            { kind: "item", id: i.id, field: "delete" },
            i.text,
          )
        }
        className={ICON_BUTTON}
      >
        {t("shopping.delete", voice)}
      </button>
    </li>
  );

  /** The refusal for a rename in progress, rendered as its own list item so it sits
   *  under the row it belongs to rather than beside the row's controls. */
  const renameRefusal = (i: ShoppingItemView) =>
    editingId === i.id && editError !== null ? (
      <li key={`${i.id}-refusal`} className="pb-1">
        <p id={editErrorId} role="alert" className="text-destructive text-sm">
          {refusalMessage(editError)}
        </p>
      </li>
    ) : null;

  return (
    <div className="space-y-6">
      <p className="text-muted-foreground text-sm">
        {t("shopping.intro", voice)}
      </p>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
        className="space-y-1"
      >
        <label htmlFor={addFieldId} className="block text-sm font-medium">
          {t("shopping.addLabel", voice)}
        </label>
        <div className="flex gap-2">
          <input
            id={addFieldId}
            ref={addFieldRef}
            value={draft}
            placeholder={t("shopping.addPlaceholder", voice)}
            // Only set when there IS an error: a permanent `aria-invalid="false"`
            // is noise, and the attribute's absence is the accessible default.
            aria-invalid={error !== null || undefined}
            aria-describedby={error !== null ? errorId : undefined}
            onChange={(e) => {
              setDraft(e.target.value);
              // Clearing on the next keystroke rather than on submit: a message
              // that outlives the mistake gets read as the field's own state.
              if (error !== null) showRefusal(null);
            }}
            className="border-input bg-background focus-visible:ring-ring min-w-0 flex-1 rounded-md border px-2 py-2 text-sm outline-none focus-visible:ring-2"
          />
          <button
            type="submit"
            className="bg-primary text-primary-foreground focus-visible:ring-ring focus-visible:ring-offset-background inline-flex min-h-[44px] items-center rounded-md px-4 text-sm font-medium outline-none focus-visible:ring-2 focus-visible:ring-offset-2"
          >
            {t("shopping.add", voice)}
          </button>
        </div>
        {errorMessage && (
          // `role="alert"` so the refusal is announced without moving focus. The
          // element only exists while there is a message, which is what makes the
          // announcement fire — a permanently-present live region that changes
          // text is announced inconsistently across screen readers.
          <p id={errorId} role="alert" className="text-destructive text-sm">
            {errorMessage}
            {/* Only when the words are nowhere else. `submit()` emptied the
                field and the restore declined because the user had typed
                something new, so this message is the last copy of them — the
                same job the failure notice's quote does, done by whichever of
                the two is on screen. Compared against `draft` rather than
                tracked, so it cannot disagree with what the field is showing. */}
            {refusedWords !== null && draft !== refusedWords && (
              <>
                {" "}
                {t("shopping.errorUnsaved", voice)}{" "}
                <strong className="break-words">
                  &ldquo;{refusedWords}&rdquo;
                </strong>
              </>
            )}
          </p>
        )}
      </form>

      {/* Outside the form, and above the sections, because it reports on any of
          the five writes rather than on the capture field alone — but next to
          that field, which is where focus goes when a Retry succeeds.

          Colour: the failure is carried by the icon and the words, never by the
          red alone (WCAG 1.4.1). `text-destructive` / `border-destructive/40` /
          `bg-destructive/5` is the token pairing globals.css documents as AA in
          both themes and the one inbox-view.tsx and focus-timer.tsx already use
          — not a raw palette shade, which is what dropped a confirmation below
          4.5:1 in #40. Neither control sets `outline-none`, so the UA focus ring
          draws and WCAG 2.4.7 Focus Visible is satisfied without a bespoke
          indicator. */}
      {failure && (
        <>
          <div
            role="alert"
            className="border-destructive/40 bg-destructive/5 flex flex-col gap-2 rounded-md border p-3 sm:flex-row sm:items-start sm:justify-between"
          >
            <p
              id={failureId}
              className="text-destructive flex min-w-0 items-start gap-1.5 text-sm font-medium"
            >
              <TriangleAlert
                aria-hidden="true"
                className="mt-0.5 h-4 w-4 shrink-0"
              />
              <span className="break-words">
                {t(writeFailureKey(failure, failureRowGone), voice)}{" "}
                <strong>&ldquo;{failure.subject}&rdquo;</strong>
              </span>
            </p>
            {/* No control at all when nothing could work — a refusal naming a row
                that is gone is answered by the refresh that came with it, and a
                button whose only possible outcome is the message already on screen
                is worse than none (Duo review round 5, !294). */}
            {writeFailureRemedy(failure, failureRowGone) !== "none" && (
              <div className="flex shrink-0 flex-col items-start gap-1 sm:items-end">
                {writeFailureRemedy(failure, failureRowGone) === "reload" ? (
                  // Retrying re-posts the same action id the running deployment
                  // has already forgotten — or, for a switched-off feature, walks
                  // into the same refusal. Either way a reload is the ONLY thing
                  // on offer.
                  <button
                    type="button"
                    aria-describedby={failureId}
                    onClick={() => window.location.reload()}
                    className="bg-primary text-primary-foreground inline-flex min-h-[44px] items-center gap-1.5 rounded-md px-4 text-sm font-medium"
                  >
                    <RefreshCw
                      aria-hidden="true"
                      className="h-4 w-4 shrink-0"
                    />
                    {t("shopping.errorReload", voice)}
                  </button>
                ) : (
                  // `aria-disabled`, not `disabled`: a disabled element cannot
                  // hold focus, so the browser would drop it to <body> the moment
                  // the retry starts — the same fault !294 fixed for the rename
                  // editor, in the control that reports it. The press is guarded
                  // in the handler instead, so a double-tap still cannot fire two
                  // writes.
                  <button
                    ref={retryRef}
                    type="button"
                    // The SECOND channel for the wait, not the only one (#236). A
                    // description is computed when focus LANDS on a control, so
                    // this covers the notice mounting with a retry already in
                    // flight. It cannot cover the press itself, because that
                    // happens on a control that already holds focus and keeps it
                    // by design; the live region below is what covers that.
                    aria-describedby={
                      failure.retrying ? `${failureId} ${savingId}` : failureId
                    }
                    aria-disabled={failure.retrying}
                    onClick={retryFailedWrite}
                    className="bg-primary text-primary-foreground inline-flex min-h-[44px] items-center gap-1.5 rounded-md px-4 text-sm font-medium aria-disabled:opacity-50"
                  >
                    <RotateCcw
                      aria-hidden="true"
                      className="h-4 w-4 shrink-0"
                    />
                    {t("shopping.errorRetry", voice)}
                  </button>
                )}
                {/* #236 — the SIGHTED copy of the wait, and only that.
                    `aria-hidden` because the announcement is the sibling region
                    below, and one sentence in two nodes is how it gets said
                    twice. Hiding it also stops the insertion mutating this
                    `role="alert"`: an alert is assertive AND atomic, so a visible
                    child appearing inside it mid-retry re-reads the whole notice
                    over the polite announcement. Nothing changes on screen. */}
                {failure.retrying && (
                  <p
                    data-testid="shopping-saving-visible"
                    aria-hidden="true"
                    className="text-muted-foreground text-xs"
                  >
                    {t("shopping.errorSaving", voice)}
                  </p>
                )}
              </div>
            )}
          </div>
          {/* #236 — where the wait is actually ANNOUNCED.
              This notice shipped `!290`'s shape, which `!303` (#218) then found
              to be half a fix and `!306` mirrored onto the inbox; the comment that
              stood here argued, correctly, against NESTING a polite region inside
              this assertive one — and then left `aria-describedby` to carry the
              wait alone, which only moved the hole onto the button. A description
              is read when focus LANDS on a control, and Retry is pressed on a
              control that already holds focus and keeps it by design, so the value
              gaining `savingId` mid-flight is a change nothing goes back to
              re-read. A live region is the one channel defined for content that
              changes while the user is stationary.
              A SIBLING of the alert, never a descendant: a polite region nested
              one level in inherits the container's politeness across its whole
              subtree, which is the original bug rather than a fix for it.
              Rendered whenever the notice is, and EMPTY until there is something
              to say, because assistive technology announces a CHANGE to a region
              already in the accessibility tree and one arriving with its first
              message is silent. `sr-only` rather than `hidden` for the same
              reason: a live region has to be rendered to be observed.
              Outside the `writeFailureRemedy !== "none"` gate on purpose. A row
              can vanish mid-retry, which withdraws the control and the sighted
              line with it; the write is still running and this is still the honest
              place to say so.
              It keeps `savingId`, so the Retry's description still resolves to
              real text. Kept identical to `inbox-view.tsx` and `focus-timer.tsx` —
              these have drifted apart twice already, which is what produced #218
              and then #236. `write-notice-hygiene` rule E now fails if any of the
              three loses it. */}
          <p
            id={savingId}
            data-testid="shopping-saving-announcer"
            role="status"
            aria-live="polite"
            aria-atomic="true"
            className="sr-only"
          >
            {failure.retrying && t("shopping.errorSaving", voice)}
          </p>
        </>
      )}

      {/* `region` + an accessible name carrying the count, so the count is
          reachable without hunting for the heading it sits beside. */}
      <section
        aria-label={`${t("shopping.sectionActive", voice)} — ${countLabel}`}
      >
        <h2 className="text-sm font-semibold">
          {t("shopping.sectionActive", voice)}{" "}
          <span className="text-muted-foreground font-normal tabular-nums">
            ({countLabel})
          </span>
        </h2>
        {active.length === 0 ? (
          <p className="text-muted-foreground mt-1 text-sm">
            {t("shopping.empty", voice)}
          </p>
        ) : (
          <ul className="mt-1 divide-y">
            {active.flatMap((i) => [row(i, false), renameRefusal(i)])}
          </ul>
        )}
      </section>

      {/* Rendered only when it holds something. An always-present empty section
          below an empty list is two headings and no content on a brand-new
          workspace; the per-row "Save … for later" button is how the section is
          discovered, and it appears the moment there is something in it. */}
      {savedForLater.length > 0 && (
        <section aria-label={t("shopping.sectionSaved", voice)}>
          <h2 className="text-sm font-semibold">
            {t("shopping.sectionSaved", voice)}
          </h2>
          <p className="text-muted-foreground mt-1 text-sm">
            {t("shopping.savedHint", voice)}
          </p>
          <ul className="mt-1 divide-y">
            {savedForLater.flatMap((i) => [row(i, true), renameRefusal(i)])}
          </ul>
        </section>
      )}
    </div>
  );
}

/** Inline text editor swapped in for a row's text. Enter saves, Escape cancels —
 *  mirrors `EditTitleInput` in inbox-view.tsx and the step editor in
 *  task-steps.tsx, which is the established shape for this in the repo. */
function RenameInput({
  initial,
  label,
  invalid,
  describedBy,
  onChange,
  onSave,
  onCancel,
}: {
  initial: string;
  label: string;
  /** Set when the last attempt was refused — WCAG 3.3.1 Error Identification. */
  invalid: boolean;
  /** The id of the refusal message, so the field points at its own explanation. */
  describedBy?: string;
  /** Editing again clears the refusal: a message that outlives the mistake gets
   *  read as the field's own state. */
  onChange: () => void;
  onSave: (value: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(initial);
  return (
    <input
      autoFocus
      value={value}
      aria-label={label}
      aria-invalid={invalid || undefined}
      aria-describedby={describedBy}
      onChange={(e) => {
        setValue(e.target.value);
        onChange();
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          onSave(value.trim());
        }
        if (e.key === "Escape") onCancel();
      }}
      className="border-input bg-background focus-visible:ring-ring min-w-0 flex-1 rounded-md border px-2 py-1 text-sm outline-none focus-visible:ring-2"
    />
  );
}
