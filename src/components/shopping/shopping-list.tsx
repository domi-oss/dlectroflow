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
  /** A retry of THIS write is in flight. */
  retrying: boolean;
  /**
   * The exact call that failed, so Retry re-runs *that* rather than a rebuilt
   * guess at it — and so `markRetrying` and the success path can both ask "is the
   * record on screen the one this attempt owns?" by identity. Stable across
   * retries, because a retry passes the same closure back in.
   */
  fn: () => Promise<unknown>;
  /**
   * Set only for the add, the one write with a stake in the capture field:
   * `submit()` empties it before the round trip, so a failure has to put the
   * words back and a later success has to make sure they do not linger into a
   * duplicate.
   */
  draftText?: string;
};

/**
 * Which of the three messages a failure gets — ordered by how much the user can
 * be told, most-certain first. `stale` and `timedOut` both override the generic
 * copy because both change what the user should DO. Mirrors `captureMessageKey`
 * in `inbox-view.tsx` and `failureMessageKey` in `focus-timer.tsx`.
 */
function writeFailureKey(failure: WriteFailure): StringKey {
  if (failure.stale) return "shopping.errorSaveStale";
  if (failure.timedOut) return "shopping.errorSaveTimeout";
  return "shopping.errorSaveFailed";
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
  const [error, setError] = useState<"empty" | "too-long" | "full" | null>(
    null,
  );
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
   * Raise or drop `retrying`, and only on the record this attempt owns — a
   * failure that has since been displaced must not have its flag rewritten by an
   * older attempt settling. Same lesson `schedulingIds` applies per-row in
   * `inbox-view.tsx` (#169): a shared in-flight flag belongs to whichever request
   * settles last, not to the one it is guarding.
   */
  const markRetrying = (fn: () => Promise<unknown>, retrying: boolean) =>
    setFailure((prev) =>
      prev && prev.fn === fn && prev.retrying !== retrying
        ? { ...prev, retrying }
        : prev,
    );

  /**
   * Every write on this page goes through here, which is the point: five actions
   * that can each fail, and one place that says so.
   */
  const attempt = (
    fn: () => Promise<unknown>,
    subject: string,
    { fromRetry, draftText }: { fromRetry: boolean; draftText?: string },
  ) =>
    startTransition(async () => {
      let landed = false;
      try {
        await withActionTimeout(fn(), SHOPPING_ACTION_TIMEOUT_MS);
        landed = true;
      } catch (error) {
        // Restore the words, but ONLY into a field the user has not since typed
        // into: a ten-second hang is long enough to type the next item, and
        // overwriting that would be the same data loss wearing the other hat.
        // When we cannot restore, the notice quotes them instead, so they are
        // never only in a variable. A functional updater, so it stays pure under
        // StrictMode's double invocation.
        if (draftText !== undefined) {
          setDraft((current) => (current.trim() === "" ? draftText : current));
        }
        setFailure({
          fn,
          subject,
          draftText,
          stale: isStaleActionError(error),
          timedOut: error instanceof ActionTimeoutError,
          // A fresh record, so the retry flag starts down: this attempt is over,
          // whatever it was.
          retrying: false,
        });
      } finally {
        // Must run on every exit including a throw: a retry flag left up is a
        // Retry button that reads permanently busy.
        if (fromRetry) markRetrying(fn, false);
      }
      if (!landed) return;
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
      // Only this attempt's own record. A success says nothing about a different
      // write's failure, and clearing that one would be a silent no-op of its own.
      setFailure((prev) => (prev?.fn === fn ? null : prev));
      // Deliberately not in the `catch`'s path: the write did not happen, so
      // there is nothing new to fetch, and a refresh that itself failed would be
      // a second unreported error.
      router.refresh();
    });

  const run = (
    fn: () => Promise<unknown>,
    subject: string,
    draftText?: string,
  ) => attempt(fn, subject, { fromRetry: false, draftText });

  const retryFailedWrite = () => {
    if (!failure || failure.retrying) return;
    // Raised OUTSIDE the transition on purpose: React 19 holds an async
    // transition's own state updates until the action settles, so a busy flag set
    // inside it would first paint at the moment it stopped being true — a
    // double-submit guard that guards nothing (#169's lesson, from `runSchedule`).
    markRetrying(failure.fn, true);
    attempt(failure.fn, failure.subject, {
      fromRetry: true,
      draftText: failure.draftText,
    });
  };

  const { active, savedForLater } = splitShoppingList(items);
  const remaining = shoppingRemainingCount(items);

  const submit = () => {
    // The cap is checked first: at 500 rows "type something first" would be a
    // true but useless answer to why nothing happened.
    if (items.length >= MAX_SHOPPING_ITEMS) {
      setError("full");
      return;
    }
    const refusal = shoppingItemTextError(draft);
    if (refusal) {
      setError(refusal);
      return;
    }
    const text = draft;
    setDraft("");
    setError(null);
    // The third argument is what makes this the one write with a stake in the
    // field: it was emptied a line ago, so a failure has to put the words back.
    run(() => addShoppingItem(text), text, text);
  };

  const refusalMessage = (
    refusal: "empty" | "too-long" | "full" | null,
  ): string | null =>
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

  // 44px minimum touch target (WCAG 2.5.5), and the focus indicator is a RING
  // rather than a background swap: WCAG 2.4.11 Focus Appearance is AA in WCAG 2.2
  // and axe does not implement it, so a hover-coloured background alone would ship
  // green and fail (#117). --ring is the same token app-menu.tsx measured.
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
          run(() => setShoppingItemDone(i.id, e.target.checked), i.text)
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
            run(() => renameShoppingItem(i.id, value), value);
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
          onClick={() => setEditingId(i.id)}
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
          run(() => setShoppingItemSavedForLater(i.id, !saved), i.text)
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
        onClick={() => run(() => deleteShoppingItem(i.id), i.text)}
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
              if (error !== null) setError(null);
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
          draws and WCAG 2.4.11 is satisfied without a bespoke indicator. */}
      {failure && (
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
              {t(writeFailureKey(failure), voice)}{" "}
              <strong>&ldquo;{failure.subject}&rdquo;</strong>
            </span>
          </p>
          <div className="flex shrink-0 flex-col items-start gap-1 sm:items-end">
            {failure.stale ? (
              // Retrying re-posts the same action id the running deployment has
              // already forgotten, so a reload is the ONLY thing on offer.
              <button
                type="button"
                aria-describedby={failureId}
                onClick={() => window.location.reload()}
                className="bg-primary text-primary-foreground inline-flex min-h-[44px] items-center gap-1.5 rounded-md px-4 text-sm font-medium"
              >
                <RefreshCw aria-hidden="true" className="h-4 w-4 shrink-0" />
                {t("shopping.errorReload", voice)}
              </button>
            ) : (
              // `aria-disabled`, not `disabled`: a disabled element cannot hold
              // focus, so the browser would drop it to <body> the moment the
              // retry starts — the same fault this MR is fixing for the rename
              // editor, in the control that reports it. The press is guarded in
              // the handler instead, so a double-tap still cannot fire two writes.
              <button
                ref={retryRef}
                type="button"
                // While a retry runs, the reason AND the wait are both reachable
                // from the control.
                aria-describedby={
                  failure.retrying ? `${failureId} ${savingId}` : failureId
                }
                aria-disabled={failure.retrying}
                onClick={retryFailedWrite}
                className="bg-primary text-primary-foreground inline-flex min-h-[44px] items-center gap-1.5 rounded-md px-4 text-sm font-medium aria-disabled:opacity-50"
              >
                <RotateCcw aria-hidden="true" className="h-4 w-4 shrink-0" />
                {t("shopping.errorRetry", voice)}
              </button>
            )}
            {/* Deliberately NOT `role="status"`: a polite live region nested
                inside this assertive one is undefined enough in practice that
                "will it announce" has no answer. The wait rides the two
                mechanisms that do — the pressed button's `aria-disabled` state
                change, which a screen reader reports because focus is on it, and
                the `aria-describedby` above, which picks this node up while it
                shows. */}
            {failure.retrying && (
              <p id={savingId} className="text-muted-foreground text-xs">
                {t("shopping.errorSaving", voice)}
              </p>
            )}
          </div>
        </div>
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
