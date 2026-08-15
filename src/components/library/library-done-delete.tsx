"use client";

import { useEffect, useId, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { TriangleAlert, RotateCcw, RefreshCw } from "lucide-react";
import { cn, touchTarget } from "@/lib/utils";
import { deleteBrainDumpItem } from "@/app/actions/braindump";
import {
  ActionTimeoutError,
  isStaleActionError,
  withActionTimeout,
} from "@/lib/server-action-failure";
import { t, type StringKey, type Voice } from "@/lib/strings";

/**
 * The Done panel's heading — `library/page.tsx` renders it as the section's
 * `aria-labelledby` target and this component hands focus to it.
 *
 * Exported and shared rather than written twice, because the two halves are
 * load-bearing for each other: the heading needs `tabIndex={-1}` or it cannot
 * receive the hand-off at all, and this component needs the id to find it.
 * `library.test.tsx` asserts the page renders both, so dropping either one fails
 * a test rather than silently returning focus to `<body>`.
 */
export const LIB_PANEL_HEADING_ID = "lib-panel-heading";

/**
 * How long the UI is willing to wait for the delete before it stops claiming to
 * be working. 10s, the same bound `CAPTURE_FLUSH_TIMEOUT_MS`,
 * `SHOPPING_ACTION_TIMEOUT_MS` and `INBOX_ACTION_TIMEOUT_MS` use, and generous
 * for the reason `withActionTimeout` gives: it bounds the WAIT, not the request.
 * A server action cannot be aborted from the client, so the delete may still
 * land — which is exactly why the timeout cell reports rather than fails.
 */
export const LIBRARY_ACTION_TIMEOUT_MS = 10_000;

/** What went wrong, in the two dimensions that change what the user should do. */
type DeleteFailure = {
  stale: boolean;
  timedOut: boolean;
  /**
   * A retry was pressed for this failure. Raised urgently, outside the
   * transition, so the wait paints on the press rather than at the transition's
   * first commit — it is one of the two inputs to `waiting`, not the whole
   * announced wait, which is the over-claim #251's review corrected.
   */
  retrying: boolean;
};

/**
 * Which message the failure gets, most-certain first.
 *
 * ── Why this is not the `errorSave*` family ─────────────────────────────────
 *
 * The inbox and shopping notices carry a four-cell `timedOut × rowGone` matrix,
 * and `write-notice-hygiene` rules A-C enforce it across every surface that owns
 * a `<prefix>.errorSaveTimeout` key. That matrix exists **for the `rowGone`
 * dimension**: a rename, a complete or a snooze needs a row to act on, so once
 * the row is gone the Retry can only ever be refused again and the copy has to
 * stop promising it.
 *
 * **A delete is the one write for which the row being gone is the goal.** There
 * is no state in which "that item is not on the list any more" is bad news here,
 * so `errorSaveGone` and `errorSaveTimeoutGone` could never be honestly selected
 * — and rule C would then force them to be selected from branches that cannot
 * run. `focus-timer.tsx` is the recorded precedent for a notice with no row to
 * lose ("the two notices that have no row to lose", `writeFailureKey` in
 * shopping-list.tsx), and this follows its `<surface>.error.*` naming for the
 * same reason. Rules D and E still watch this file — it is registered in
 * `LIVE_REGION_FILES` — and they are the half that can see a mis-nested or
 * missing announcement, which is the part that has actually shipped broken.
 */
function failureMessageKey(failure: DeleteFailure): StringKey {
  if (failure.stale) return "lib.error.stale";
  if (failure.timedOut) return "lib.error.deleteTimeout";
  return "lib.error.delete";
}

/**
 * Delete, and only delete, for a row in the Library hub's Done tab (#251).
 *
 * ── Why not just render `<LibraryRows>` here ────────────────────────────────
 *
 * That was the obvious move — `plated`/`pantry` already use it and it carries a
 * delete. But it also carries **▶ Start focusing, Complete, an inline estimate
 * editor, an editable task note, a row number, an age label and select mode**,
 * and every one of those is meaningless on a closed to-do: there is nothing left
 * to focus, nothing to complete, and no estimate worth revising. Its `tab` prop
 * is typed `"plated" | "pantry"` precisely because those affordances are tied to
 * an in-flight row. So the narrow control goes in and the row stays the closure
 * view it is — one new affordance rather than eight, seven of which would then
 * need suppressing.
 *
 * That also keeps `LibraryRow` a **server** component. The Done tab renders the
 * whole pile uncapped, and turning every row into a client component to reach one
 * button would ship the row's markup twice for every finished to-do the user has.
 *
 * ── Two-step confirm, matching every other delete in the app ────────────────
 *
 * The first press arms; only the confirming press writes. Copied in shape from
 * `library-rows.tsx` and the Inbox's own `deleteControl` — not shared with them
 * because both of those close over a list-wide `confirmDeleteId` (they render the
 * same control twice per row, inline and in the ▾ menu, and keep the two in sync).
 * There is one control per row here and no menu, so the state is local and the
 * coupling is not worth buying.
 *
 * A completed to-do is the row a user is least likely to want back by accident
 * and least able to re-derive — the steps, the note and the estimate go with it
 * — so the confirm is not ceremony.
 *
 * ── The failure path (#251 review) ──────────────────────────────────────────
 *
 * This shipped with none, and the review that caught it is the reason for
 * everything below. `setConfirming(false)` runs synchronously, so the confirming
 * button unmounts and the resting 🗑 is live again **while the write is still in
 * flight**. With a bare `await` and no `try`, a rejection left the transition as
 * an unhandled rejection — no `error.tsx` anywhere in `src/` to catch it — the
 * refresh and the focus hand-off never ran, and the user was left on `<body>`
 * with nothing said and a button that would start a second concurrent delete.
 * That is the failure class #210 and #225 exist for.
 *
 * Four things close it, and they are the same four those issues settled:
 *
 *  1. **A bound on the wait.** `withActionTimeout` — a write that neither
 *     resolves nor rejects (a pod rolling mid-request on Autopilot) otherwise
 *     leaves the row looking untouched forever.
 *  2. **A `role="alert"` notice that names the row.** The Done pile is uncapped,
 *     so "it failed" with no subject leaves the user guessing which of forty rows
 *     it was about.
 *  3. **A single-flight guard.** A ref, not `disabled`: a disabled element cannot
 *     hold focus, so the browser would drop it to `<body>` the moment the write
 *     starts — the fault this notice exists to avoid, arriving from the control
 *     that reports it. The resting button carries `aria-busy` instead.
 *  4. **Focus that is repaired, never stolen.** See below.
 *
 * ── Focus ───────────────────────────────────────────────────────────────────
 *
 * On success the row goes and focus would fall to `<body>` (WCAG 2.4.3), so it
 * is handed to the panel heading: it survives the refresh, it is the section's
 * accessible name, and it carries `tabIndex={-1}` so it takes the hand-off
 * without entering the tab order. That is the house pattern rather than a choice
 * made here — `SectionHeading` (components/nav/section-heading.tsx) lists "a
 * landing place for focus" as one of its four jobs, for the same stated reason.
 *
 * On failure focus goes to the notice's own control instead, because that is
 * where the user now has to act.
 *
 * **Repair, never steal**, in both directions: each move is gated on focus having
 * actually been lost. A user who moved to the tab strip or another row while the
 * write was in flight stays where they are. Collapsing that condition is what
 * made the Inbox's own hand-off grabby before `!306`.
 */
export function LibraryDoneDelete({
  id,
  title,
  voice,
}: {
  id: string;
  /** The row's text, quoted by the notice so it names what did not delete. */
  title: string;
  voice: Voice;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [confirming, setConfirming] = useState(false);
  const [failure, setFailure] = useState<DeleteFailure | null>(null);
  const failureId = useId();
  const savingId = useId();

  /**
   * Single-flight guard. A ref rather than state for the reason `attemptWrite`
   * gives (#169): React 19 holds an async transition's own state updates until it
   * settles, so a flag raised inside one would first paint at the moment it
   * stopped being true — a double-submit guard that guards nothing.
   */
  const inFlight = useRef(false);
  const remedyRef = useRef<HTMLButtonElement | null>(null);
  const noticeRef = useRef<HTMLParagraphElement | null>(null);
  const rootRef = useRef<HTMLSpanElement | null>(null);

  /**
   * Is the user still standing on this control, or nowhere at all?
   *
   * `<body>` is the browser's word for "focus is nowhere", and it is NOT the only
   * case here — which is the correction the review's own test forced. React
   * reconciles the confirming `<span><button>Delete</button>…</span>` against the
   * resting `<span><button>🗑</button>…</span>` and **reuses the button node**, so
   * confirming does not drop focus the way the two-step controls elsewhere do:
   * focus is still on this control when the write settles, and the row it lives
   * in is about to be removed by the refresh. Checking only for `<body>` skipped
   * the hand-off and left the user on `<body>` a moment later, once the unmount
   * this component cannot observe had happened.
   *
   * Anything outside this subtree means the user moved on under their own steam
   * and is left alone — the repair-not-steal rule, and the reason this is a
   * containment test rather than an unconditional move.
   */
  const focusIsOursToMove = () => {
    const active = document.activeElement;
    return active === document.body || !!rootRef.current?.contains(active);
  };

  useEffect(() => {
    if (!failure) return;
    // ONE condition, decided after the commit rather than a one-shot flag armed
    // at settle time — which is the conclusion `inbox-view.tsx` reaches in its
    // own note, after shipping the flag version: "a user who moved focus in
    // between would have had it taken anyway, by a flag whose stated purpose is
    // to leave them alone. Deciding it once, at the later moment, is both simpler
    // and correct." The flag version was written here first and this component's
    // own review test caught it doing exactly that.
    if (!focusIsOursToMove()) return;
    // The paragraph is the fallback and carries `tabIndex={-1}` for it: a notice
    // with nothing focusable in it cannot receive the hand-off at all.
    (remedyRef.current ?? noticeRef.current)?.focus();
  }, [failure]);

  const runDelete = (fromRetry: boolean) => {
    if (inFlight.current) return;
    inFlight.current = true;
    // Outside the transition and urgent, for the same reason the guard is a ref.
    if (fromRetry) setFailure((f) => (f ? { ...f, retrying: true } : f));
    startTransition(async () => {
      try {
        await withActionTimeout(
          deleteBrainDumpItem(id),
          LIBRARY_ACTION_TIMEOUT_MS,
        );
        setFailure(null);
        // The hub re-reads live data on refresh; the action revalidates the routes
        // it knows about, not whichever one this press came from.
        //
        // Its OWN catch, and swallowing on purpose — the same decision
        // `attemptWrite` records: the delete landed, so "couldn't delete" would be
        // a lie, and the only casualty is a list one fetch stale. Letting it throw
        // here would leave the transition as the unhandled rejection this whole
        // block exists to remove.
        try {
          router.refresh();
        } catch {
          // Intentionally empty — see above.
        }
        if (focusIsOursToMove())
          document.getElementById(LIB_PANEL_HEADING_ID)?.focus();
      } catch (error) {
        setFailure({
          stale: isStaleActionError(error),
          timedOut: error instanceof ActionTimeoutError,
          // A fresh record, so the wait starts down: this attempt is over,
          // whatever it was.
          retrying: false,
        });
      } finally {
        // Must run on every exit including a throw: a guard left raised is a
        // control that silently does nothing for the rest of the session.
        inFlight.current = false;
      }
    });
  };

  const confirm = () => {
    setConfirming(false);
    runDelete(false);
  };

  if (confirming) {
    return (
      // `rootRef` on BOTH branches, and the confirming one is the branch that
      // needs it (#251 review). React reconciles this `<span>` against the
      // resting one, reuses the DOM node and detaches whatever ref the previous
      // element carried — so a confirming render with no `ref` leaves
      // `rootRef.current` null exactly while focus is inside this subtree, and
      // `focusIsOursToMove()` collapses to "is focus on <body>". It is not: the
      // reused button is holding it. The success hand-off was therefore skipped
      // and `router.refresh()` then unmounted the row from under the user,
      // dropping focus to <body> a moment later — the WCAG 2.4.3 fault this
      // component's hand-off exists to close, reached from the very state the
      // single-flight guard exists to tolerate (🗑 pressed again on a slow write).
      <span ref={rootRef} className="flex items-center gap-2">
        <button
          type="button"
          className={cn(
            touchTarget,
            "text-destructive rounded-md px-2.5 py-1 font-medium",
          )}
          onClick={confirm}
        >
          {t("action.delete", voice)}
        </button>
        <span aria-hidden="true" className="text-muted-foreground">
          ·
        </span>
        <button
          type="button"
          className={cn(
            touchTarget,
            "text-muted-foreground hover:text-foreground rounded-md px-2.5 py-1",
          )}
          onClick={() => setConfirming(false)}
        >
          {t("action.cancel", voice)}
        </button>
      </span>
    );
  }

  const busyLabel = pending
    ? `${t("action.delete", voice)} — already in progress for this row`
    : t("action.delete", voice);

  /**
   * Is a delete for this row in flight while the notice is on screen — #251
   * review.
   *
   * This used to be `failure.retrying` alone, and that flag is only raised by the
   * Retry button. There are TWO routes to a second attempt: the Retry, and the
   * resting 🗑 the user already knows, which is live again the moment `confirm()`
   * collapses the confirm. Taking the second route left a Retry reading
   * `aria-disabled="false"` that `inFlight` silently refused, with nothing saying
   * why. `focus-timer.tsx` gates the same three things on `pending` and has no
   * such hole.
   *
   * Both flags rather than just `pending`, and they are not redundant:
   * `setFailure({ retrying: true })` is raised OUTSIDE the transition and is
   * therefore urgent, so the Retry path paints and announces the wait immediately
   * instead of at the transition's first commit. `pending` is what covers the
   * press that came through the 🗑.
   */
  const waiting = pending || !!failure?.retrying;

  return (
    <span ref={rootRef} className="flex w-full flex-col items-end gap-2">
      <button
        type="button"
        // The visible label is a glyph, so the `aria-label` is the whole
        // accessible name and `title` is the pointer user's half of the same fact
        // — the treatment the Inbox's end-cluster icons already use. The busy
        // reason rides on the NAME rather than on `disabled`, because a disabled
        // element is skipped by most screen readers and cannot hold focus.
        aria-label={busyLabel}
        title={busyLabel}
        aria-busy={pending || undefined}
        className={cn(
          touchTarget,
          "text-muted-foreground hover:bg-accent hover:text-destructive rounded-md px-2 py-1 text-sm",
          pending && "opacity-50",
        )}
        onClick={() => setConfirming(true)}
      >
        🗑
      </button>

      {/* Colour: the failure is carried by the icon and the words, never by the
          red alone (WCAG 1.4.1). `text-destructive` / `border-destructive/40` /
          `bg-destructive/5` is the token pairing globals.css documents as AA in
          both themes and the one inbox-view.tsx, shopping-list.tsx and
          focus-timer.tsx already use — not a raw palette shade, which is what
          a11y-class-hygiene's Rule A exists to stop. Neither control sets
          `outline-none`, so the UA focus ring draws and WCAG 2.4.7 Focus Visible
          is satisfied without a bespoke indicator. */}
      {failure && (
        <>
          <div
            role="alert"
            className="border-destructive/40 bg-destructive/5 flex w-full flex-col gap-2 rounded-md border p-3 text-left"
          >
            <p
              id={failureId}
              ref={noticeRef}
              tabIndex={-1}
              className="text-destructive flex min-w-0 items-start gap-1.5 text-sm font-medium"
            >
              <TriangleAlert
                aria-hidden="true"
                className="mt-0.5 h-4 w-4 shrink-0"
              />
              <span className="break-words">
                {t(failureMessageKey(failure), voice)}{" "}
                <strong>&ldquo;{title}&rdquo;</strong>
              </span>
            </p>
            <div className="flex flex-col items-start gap-1">
              {failure.stale ? (
                // Retrying re-posts an action id the running deployment has
                // already forgotten, so a reload is the only thing on offer.
                <button
                  ref={remedyRef}
                  type="button"
                  aria-describedby={failureId}
                  onClick={() => window.location.reload()}
                  className={cn(
                    touchTarget,
                    "bg-primary text-primary-foreground inline-flex items-center gap-1.5 rounded-md px-4 text-sm font-medium",
                  )}
                >
                  <RefreshCw aria-hidden="true" className="h-4 w-4 shrink-0" />
                  {t("lib.error.reload", voice)}
                </button>
              ) : (
                // `aria-disabled`, not `disabled`: a disabled element cannot hold
                // focus, so the browser would drop it to <body> the moment the
                // retry starts — in the control reporting that very fault. The
                // press is guarded by `inFlight` instead.
                <button
                  ref={remedyRef}
                  type="button"
                  // The SECOND channel for the wait, not the only one (#236). A
                  // description is computed when focus LANDS on a control, so this
                  // covers the notice mounting with a retry already in flight. It
                  // cannot cover the press itself, because that happens on a
                  // control that already holds focus and keeps it by design; the
                  // live region below is what covers that.
                  aria-describedby={
                    waiting ? `${failureId} ${savingId}` : failureId
                  }
                  aria-disabled={waiting}
                  onClick={() => runDelete(true)}
                  className={cn(
                    touchTarget,
                    "bg-primary text-primary-foreground inline-flex items-center gap-1.5 rounded-md px-4 text-sm font-medium aria-disabled:opacity-50",
                  )}
                >
                  <RotateCcw aria-hidden="true" className="h-4 w-4 shrink-0" />
                  {t("lib.error.retry", voice)}
                </button>
              )}
              {/* #236 — the SIGHTED copy of the wait, and only that.
                  `aria-hidden` because the announcement is the sibling region
                  below, and one sentence in two nodes is how it gets said twice.
                  Hiding it also stops the insertion mutating this `role="alert"`:
                  an alert is assertive AND atomic, so a visible child appearing
                  inside it mid-retry re-reads the whole notice over the polite
                  announcement. Nothing changes on screen. */}
              {waiting && (
                <p aria-hidden="true" className="text-muted-foreground text-xs">
                  {t("lib.error.retrying", voice)}
                </p>
              )}
            </div>
          </div>
          {/* #218 / #236 — where the wait is actually ANNOUNCED.
              A SIBLING of the alert, never a descendant: a polite region nested
              one level in inherits the container's politeness across its whole
              subtree, which is the original bug rather than a fix for it.
              Rendered whenever the notice is, and EMPTY until there is something
              to say, because assistive technology announces a CHANGE to a region
              already in the accessibility tree and one arriving with its first
              message is silent. `sr-only` rather than `hidden` for the same
              reason: a live region has to be rendered to be observed.

              The region's SHAPE and PLACEMENT are identical to inbox-view.tsx,
              shopping-list.tsx and focus-timer.tsx — those drifted apart twice,
              which is what produced #218 and then #236, and
              `write-notice-hygiene` rule D now watches this file for the same
              reason. Its CONDITION is not identical and cannot be: this control
              has two routes to a second attempt (the Retry, and the resting 🗑
              that is live again the moment the confirm collapses), where the
              others have one. `waiting` covers both. This comment claimed
              identity outright until #251's review, and the part it was wrong
              about was the part that mattered — the gate was `failure.retrying`
              while `focus-timer.tsx`'s was `pending`, so the second route
              announced nothing at all. */}
          <p
            id={savingId}
            data-testid="library-delete-announcer"
            role="status"
            aria-live="polite"
            aria-atomic="true"
            className="sr-only"
          >
            {waiting && t("lib.error.retrying", voice)}
          </p>
        </>
      )}
    </span>
  );
}
