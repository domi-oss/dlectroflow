"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { RotateCcw } from "lucide-react";
import { ejectStepToInbox } from "@/app/actions/breakdown";
import {
  completeStep,
  uncompleteStep,
  renameStep,
  updateStepEstimate,
} from "@/app/actions/focus";
import { CompleteButton } from "@/components/inbox/complete-button";
import { RowActions } from "@/components/inbox/row-actions";
import { rowMenuEntry } from "@/components/ui/anchored-popup";
import { groupedRowMenu } from "@/components/ui/row-menu-separator";
import { useVoice } from "@/components/voice-provider";
import { t, type Voice } from "@/lib/strings";
import { cn, touchTarget } from "@/lib/utils";
import { COMPLETE_TEXT } from "@/lib/completion-style";
import { DonePill } from "@/components/completion/done-pill";
import { StepNote } from "@/components/breakdown/task-note";
import { NoteText } from "@/components/breakdown/note-field";

/**
 * Word-for-word the sentence `row-actions.tsx` uses for the same state (#169).
 * Deliberately identical: two different phrasings for "this row's own action is
 * still running" would be two things for a screen-reader user to learn.
 */
const UNDO_BUSY_REASON = "already in progress for this row";

export type TaskStepRow = {
  id: string;
  order: number;
  total: number;
  text: string;
  subtaskEmoji: string | null;
  estMinutes: number;
  done: boolean;
  /** #44 — this step's own freeform note. Null when it has none, which is the
   *  common case and the reason the field is a disclosure rather than a box. */
  notes: string | null;
  /** True when the step has an unfinished FocusSession (started, never ended) —
   * surfaces "Resume Focus" instead of "Start Focus". NOTE: this is the
   * "unfinished session" heuristic, not a true pause/resume (see #25). */
  resumable: boolean;
};

/**
 * Interactive working-view step list. Each NOT-done row mirrors the inbox
 * ItemRow: a title line (order/total + emoji + text + estimate) above an action
 * line (Complete · Start/Resume Focus · a 🔽 dropdown of every option), reusing
 * the shared CompleteButton + RowActions v6 pattern. Sending a step "back to
 * review" extracts it to the inbox as its own bigger task; extracting the last
 * step empties the task, so we surface a chooser (re-plan with AI / manually /
 * keep as a single to-do) instead of leaving an empty task.
 */
export function TaskSteps({
  taskId,
  steps,
  voice: voiceProp,
}: {
  taskId: string;
  steps: TaskStepRow[];
  /** Resolved voice. Inbox passes its own; the tasks-page subtree resolves it
   * from the layout's VoiceProvider via `useVoice()` below. */
  voice?: Voice;
}) {
  const contextVoice = useVoice();
  const voice = voiceProp ?? contextVoice;
  const router = useRouter();
  const [pending, start] = useTransition();
  const [emptied, setEmptied] = useState(false);
  // At most one step edits its title / estimate inline at a time.
  const [editTitleId, setEditTitleId] = useState<string | null>(null);
  const [editEstId, setEditEstId] = useState<string | null>(null);

  function sendToReview(stepId: string) {
    start(async () => {
      const res = await ejectStepToInbox(stepId);
      if (!res) return;
      if (res.remaining === 0) setEmptied(true);
      else router.refresh();
    });
  }

  const complete = (stepId: string) =>
    start(async () => {
      await completeStep(stepId);
      router.refresh();
    });

  // #198 — the row-level half of the undo. The timer's done screen carries the
  // one that matters most (it is where an accidental completion is discovered),
  // but a mistake noticed later still has to be fixable, and this is the only
  // screen that shows a done step inside an unfinished task.
  //
  // #169's shape, keyed per step (review round 10). `undoingIds` is the ONLY thing
  // the undo controls read for their disabled state. `pending` above comes from one
  // `useTransition` shared by every action in this file — complete, rename,
  // re-estimate, send-to-review — so reading it here meant re-estimating step 3
  // greyed out step 1's undo, and a press landing in that window was discarded
  // with no error and no toast. That is #169 exactly, and it is worth not
  // reintroducing one MR after it was fixed in the inbox.
  const [undoingIds, setUndoingIds] = useState<ReadonlySet<string>>(
    () => new Set(),
  );

  // #198 round 11 — this handler had no `catch`, so a failed undo cleared the
  // spinner and left the row looking idle with nothing said: no notice, no retry,
  // and `router.refresh()` skipped. The timer's undo has surfaced exactly this
  // failure since round 4, and #198's own CHANGELOG entry promises "an undo that
  // fails is an undo you can retry" — true there, false here, which makes it a
  // defect in this MR rather than a gap it inherited.
  //
  // Keyed per step for the same reason `undoingIds` is: a page-level banner would
  // leave the user working out which of several identical-looking done rows it
  // referred to.
  const [undoFailedIds, setUndoFailedIds] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const withoutId = (ids: ReadonlySet<string>, stepId: string) => {
    const next = new Set(ids);
    next.delete(stepId);
    return next;
  };

  // #206 / review round 12 — WCAG 2.4.3, and the same class this MR already fixed
  // for the timer's undo in round 7. `steps.map()` renders two structurally
  // different subtrees for the SAME `key={s.id}` depending on `s.done`, so when
  // the refresh flips this row to not-done React reconciles in place and swaps the
  // children — unmounting the button the user just pressed. Nothing moved focus,
  // so a keyboard or screen-reader user was dropped to `<body>` at the exact
  // moment their correction succeeded.
  //
  // Mirrors `focus-timer.tsx`'s `setupCtaRef` hand-off (gated there on
  // `undone && phase === "setup"`): remember which id this component just undid,
  // and once the row has actually re-rendered as not-done, focus its primary
  // control. Gated on *this component having done the undo* so that a row
  // reopening for any other reason — the timer, another tab, a routine
  // revalidation — cannot yank focus out from under whatever the user is doing.
  // Both of these are refs, not state, and deliberately so: `react-hooks/
  // set-state-in-effect` is right that clearing a flag from inside an effect
  // causes a cascading render, and none of this needs to drive one. The hand-off
  // is a one-shot side effect on the DOM, which is exactly what a ref is for.
  //
  // Round 15 — a Set, not a single slot, mirroring `undoingIds` and
  // `undoFailedIds` and for the same reason they are keyed: `undoingIds` is a Set
  // precisely because two rows CAN be un-completing at once, so a one-id slot
  // meant the undo that resolved second overwrote the id the first had stored,
  // and the first row's reopened control then received nothing. That is the
  // round-12 bug again, silently, for that row — the worst version of it, since
  // the fix looks present.
  const justUndidRef = useRef<Set<string>>(new Set());
  const ctaRefs = useRef(new Map<string, HTMLAnchorElement | null>());

  // #215 — WCAG 2.4.3, the residual half of what round 15 fixed. Swapping both
  // undo controls to `aria-disabled` covers the case where the pressed element is
  // merely HELD; the Retry has a second, independent route to the same drop.
  // Pressing it clears this row from `undoFailedIds` (see `uncomplete` below),
  // which unmounts the `role="alert"` the button lives inside — it is destroyed,
  // not disabled, so no attribute choice can keep focus on it.
  //
  // THE DECISION, recorded here so it sits beside the round-14 one it has to
  // coexist with rather than appearing to contradict it. #215 offered two routes:
  //
  //   (a) keep the notice mounted across the retry, as `focus-timer.tsx` does;
  //   (b) hand focus to the row's own undo control, which never unmounts.
  //
  // (b), for three reasons. It leaves round 14's clear-on-the-way-in intact —
  // that decision is right, and a notice still reading "it is still marked done"
  // while the retry that may already have fixed it is in flight is its own
  // confusion. The row's undo is the SAME action, so focus has not wandered to
  // something unrelated; the user is on the control that would repeat what they
  // just asked for. And it is the better landing spot for the announcement too:
  // that button carries `aria-busy` and appends the busy reason to its accessible
  // name while `undoing`, so a screen-reader user who lands on it hears that the
  // retry is running.
  //
  // That last point is why #218's live region has NO counterpart here, and the
  // difference is worth being precise about (Duo round 16 on `!303` raised it).
  // #218 is about text that changes while the user stands still: focus is held
  // on the timer's Retry across the whole attempt, and neither a description nor
  // an accessible name is re-read under held focus, so the wait there needs a
  // live region to reach anyone. Here focus MOVES — onto a control whose
  // accessible name already ends in the busy reason at the moment it lands, and
  // a name is read on arrival by every screen reader. Adding a live region on
  // top would say it a second time. Pinned by "hands focus to the row's own undo
  // when Retry withdraws the notice", which asserts the busy name and the focus
  // together.
  //
  // The timer is NOT inconsistent with this: it keeps its notice mounted because
  // its notice is page-level and has nowhere else to send focus, whereas every row
  // here owns a permanent control for the identical action.
  //
  // A Set, and keyed, for exactly the reason round 15 gives for `justUndidRef`:
  // every other per-row record in this file is keyed, and a single slot is what
  // let the second row's hand-off overwrite the first's, leaving the row that had
  // been waiting longest with nothing. Refs, not state — the hand-off is a
  // one-shot DOM side effect and must not drive a render.
  //
  // #237 — and ARMED only when the press held focus, which is the question that
  // has to be settled before "where does focus go": see the gate at the Retry's
  // own `onClick`, and `justUndidRef`'s matching one in `uncomplete`.
  const retryHandoffRef = useRef<Set<string>>(new Set());
  const undoRefs = useRef(new Map<string, HTMLButtonElement | null>());

  useEffect(() => {
    const handoffs = retryHandoffRef.current;
    if (handoffs.size === 0) return;
    // Keyed on `undoFailedIds` because that is the state whose change unmounts the
    // notice, and the arm and the clear happen in the same event — so the first
    // run after arming is always the render in which the Retry has gone. Draining
    // unconditionally is deliberate: an id whose row has since disappeared
    // resolves to no element and no-ops, rather than staying armed to fire at some
    // unrelated later render. Deleting the id being visited is defined behaviour
    // for a Set iterator, the same as in the effect below.
    for (const id of handoffs) {
      handoffs.delete(id);
      undoRefs.current.get(id)?.focus();
    }
  }, [undoFailedIds]);

  useEffect(() => {
    const handoffs = justUndidRef.current;
    if (handoffs.size === 0) return;
    for (const id of handoffs) {
      const row = steps.find((s) => s.id === id);
      // Still `done` means the refresh has not landed for THIS row yet — leave
      // its id in place and let the effect re-run on the next `steps` change.
      // One row lagging must not drain another's pending hand-off, which is
      // exactly what a shared slot did. A row that vanished entirely has nothing
      // to receive focus, but its id still has to be dropped or it would fire at
      // some unrelated later render.
      if (row?.done) continue;
      handoffs.delete(id);
      if (row) ctaRefs.current.get(id)?.focus();
    }
    // Deleting the id being visited is defined behaviour for a Set iterator, so
    // the drain is safe in place. If two rows reopen in the SAME render the last
    // focus() call wins — unavoidable, one focus per document, and harmless:
    // both undos were this user's own, and the alternative is dropping one id
    // permanently rather than losing a race for one commit.
  }, [steps]);

  const uncomplete = (stepId: string) => {
    setUndoingIds((ids) => new Set(ids).add(stepId));
    // Round 14 — cleared on the way in, not only on success: a retry that is still
    // in flight must not still be showing the previous attempt's failure. #215
    // kept this and paid for it on the focus side instead (`retryHandoffRef`
    // above), rather than reversing it and leaving a stale notice on screen.
    setUndoFailedIds((ids) => withoutId(ids, stepId));
    start(async () => {
      try {
        await uncompleteStep(stepId);
        // Recorded BEFORE the refresh, so the effect above is already armed when
        // the re-render that unmounts this button arrives. Added to the set rather
        // than assigned over it, so a second row undone while this one is still
        // waiting for its refresh cannot erase this row's hand-off.
        //
        // #237 — and only if this row's undo is the control the user is standing
        // on, the same question the Retry's arm asks. Read HERE rather than at the
        // press, for the reason `breakdown-chat.tsx` reads its own after the
        // await: this control is destroyed by the refresh, not by the press, so
        // whether it is still the one holding focus can only be answered at the
        // last moment before the state change that takes it away.
        //
        // Of the two arms this is the WIDER window — it opens when the write
        // resolves and closes only when `router.refresh()` comes back — so it does
        // not need WebKit's never-focus-a-button behaviour to fire on the wrong
        // element. A user who opened another row's inline editor while the undo was
        // in flight is enough, on any engine, and waiting on a server round-trip is
        // exactly when someone starts doing something else.
        //
        // The row's undo is the right thing to compare against for BOTH routes in:
        // its own press lands on it directly, and a Retry press that was honoured
        // has already been handed to it by the effect on `undoFailedIds`. A Retry
        // press that was NOT honoured leaves focus where the user put it, so both
        // arms decline together rather than the second undoing the first's
        // restraint.
        const pressed = undoRefs.current.get(stepId);
        if (pressed && pressed === document.activeElement)
          justUndidRef.current.add(stepId);
        router.refresh();
      } catch {
        // Deliberately not rethrown. The server action is atomic, so a rejection
        // means nothing was committed and the step really is still done — which is
        // what the notice says. Swallowing it here is what keeps the page alive to
        // offer the retry; the alternative is an error boundary that takes the
        // whole list down over one row's failed write.
        setUndoFailedIds((ids) => new Set(ids).add(stepId));
      } finally {
        // `finally`, not after the await: a throw that left the id in the set
        // would disable that row's undo for the rest of the page's life, which is
        // a worse failure than the double-submit the flag exists to prevent.
        setUndoingIds((ids) => withoutId(ids, stepId));
      }
    });
  };

  const rename = (stepId: string, title: string) =>
    start(async () => {
      await renameStep(stepId, title);
      router.refresh();
    });

  const updateEstimate = (stepId: string, minutes: number) =>
    start(async () => {
      await updateStepEstimate(stepId, minutes);
      router.refresh();
    });

  if (emptied) {
    return (
      <div className="space-y-3 rounded-lg border border-dashed p-4">
        <p className="text-sm font-medium">
          That was the last step — this task is empty now. What next?
        </p>
        <div className="flex flex-wrap gap-2 text-sm">
          <button
            onClick={() => router.push(`/tasks/${taskId}`)}
            className="bg-primary text-primary-foreground rounded-md px-3 py-1.5 font-medium"
          >
            Re-plan with AI
          </button>
          <button
            onClick={() => router.push(`/tasks/${taskId}?edit=1&manual=1`)}
            className="hover:bg-accent rounded-md border px-3 py-1.5"
          >
            Re-plan manually
          </button>
          <button
            onClick={() => router.push("/")}
            className="hover:bg-accent rounded-md border px-3 py-1.5"
          >
            Keep as single to-do
          </button>
        </div>
      </div>
    );
  }

  return (
    <ol className={cn("space-y-2", pending && "opacity-70")}>
      {steps.map((s) => {
        if (s.done) {
          // Done steps keep the completed state (strikethrough + ✓) with no
          // focus/complete actions — but they DO carry an un-complete (#198),
          // because until it existed a step completed inside an unfinished task
          // could not be reopened anywhere in the app.
          const undoing = undoingIds.has(s.id);
          const undoLabel = `${t("step.uncomplete", voice)}: ${s.text}`;
          return (
            <li key={s.id} className="rounded-lg border px-3 py-2 text-sm">
              <div className="flex items-center gap-3">
                <span className="text-muted-foreground w-8 text-xs tabular-nums">
                  {s.order}/{s.total}
                </span>
                <span
                  className={cn("text-muted-foreground flex-1", COMPLETE_TEXT)}
                >
                  {s.subtaskEmoji ? `${s.subtaskEmoji} ` : ""}
                  {s.text}
                </span>
                <span className="text-muted-foreground text-xs">
                  {s.estMinutes}m
                </span>
                <DonePill voice={voice} />
                {/* #198 — quiet, and last in the row: this is a correction, not
                    something to invite on a finished step. The accessible name
                    carries the step text because a page of done rows would
                    otherwise present several controls all called "Mark not
                    done", which is exactly the WCAG 2.4.6 problem the inbox row
                    actions already solve this way. */}
                <button
                  type="button"
                  // #215 — the hand-off target for a Retry that has just unmounted
                  // itself. Registered per row unconditionally, so no render
                  // depends on which row failed, and mirroring `ctaRefs` above.
                  ref={(el) => {
                    undoRefs.current.set(s.id, el);
                  }}
                  // Round 15 — `aria-disabled`, not `disabled`, and the same
                  // reasoning `focus-timer.tsx` carries for the timer's Retry: a
                  // disabled element cannot hold focus, so the browser blurs it to
                  // <body> the instant the attribute lands — which here is the
                  // instant a keyboard user presses it. They are then holding
                  // nothing, in a list of visually identical done rows, while a
                  // write they cannot observe runs. WCAG 2.4.3.
                  //
                  // The press is guarded in the handler instead, because an
                  // aria-disabled button is still clickable and the double-submit
                  // protection was the whole point of the flag.
                  onClick={() => {
                    if (!undoing) uncomplete(s.id);
                  }}
                  aria-disabled={undoing}
                  // #169 — a held control has to say why, because one that
                  // swallows a press with no error and no toast is indistinguishable
                  // from a broken one. Saying it is only honest now the reason is
                  // TRUE per row: list-wide, the only accurate sentence would have
                  // been "something, somewhere in this list, is busy". Appended
                  // rather than replacing, so the idle name stays a stable query
                  // target. `aria-busy` is the machine-readable half; the reason
                  // rides on the name itself because that is what a screen reader
                  // reads out — and `aria-disabled` is what lets it read anything
                  // at all here, a natively disabled element being skipped by most
                  // of them.
                  {...(undoing ? ({ "aria-busy": true } as const) : {})}
                  aria-label={
                    undoing ? `${undoLabel} — ${UNDO_BUSY_REASON}` : undoLabel
                  }
                  className="text-muted-foreground hover:text-foreground focus-visible:ring-ring inline-flex min-h-11 min-w-11 shrink-0 items-center justify-center rounded outline-none focus-visible:ring-2 aria-disabled:opacity-50"
                >
                  <RotateCcw aria-hidden="true" className="h-4 w-4" />
                </button>
              </div>
              {/* #198 round 11 — a failed undo has to say so. The string is the
                  timer's own, verbatim, because the failure is the same one and the
                  claim is literally true here: the action is atomic, so a rejection
                  means nothing committed and the step really is still done. The red
                  is `SaveIndicator`'s AA-measured pair (#109) rather than a fresh
                  `red-600`, which fails AA at this size by 0.02 and is exactly the
                  shade nobody catches by eye. */}
              {undoFailedIds.has(s.id) && (
                <p
                  role="alert"
                  className="mt-2 flex flex-wrap items-center gap-2 text-xs text-red-700 dark:text-red-400"
                >
                  <span>{t("focus.error.undo", voice)}</span>
                  {/* Round 14 — carries the same double-submit guard as the
                      control above it. The server action is idempotent (the
                      `done: true` precondition inside the write), so a double
                      press could not corrupt anything; it was an inconsistency
                      with the protection this file had just added ten lines up,
                      plus a wasted round trip. `aria-busy` and the spoken reason
                      are deliberately NOT repeated here: this button sits inside
                      a `role="alert"` that has already announced itself, and a
                      second live announcement for one press would talk over it.
                      Round 15 — held the same way as the control above, for the
                      same WCAG 2.4.3 reason and so that one file does not carry
                      two idioms for one state. It matters most here of anywhere:
                      this is the control INSIDE the notice, so it is the likeliest
                      thing holding focus when the press lands.
                      #215 — and `aria-disabled` is not enough on its own here,
                      because this button does not become held, it ceases to exist:
                      the press withdraws the notice around it. The hand-off is
                      armed below and consumed by the effect on `undoFailedIds`. */}
                  <button
                    type="button"
                    onClick={(e) => {
                      // Armed only when the press is actually honoured. Arming on
                      // a swallowed press would leave an id queued to steal focus
                      // at whatever unrelated render moved `undoFailedIds` next.
                      if (undoing) return;
                      // #237 — and only when the press came FROM this button.
                      // 2.4.3 asks where focus goes when the focused control is
                      // destroyed; it does not license taking focus off something
                      // else, which is 3.2.2's harm instead. The note above calls
                      // this "the likeliest thing holding focus" and that is true
                      // — but likeliest is not always, and the gap is not a rare
                      // one: WebKit does not focus a `<button>` on click (measured
                      // against Chromium in the spec's own table), so on Safari
                      // and everything on iOS a mouse or touch press NEVER holds
                      // it. Assistive-technology activation is the second route,
                      // on every engine.
                      //
                      // It matters in THIS file and not in `focus-timer.tsx`
                      // because this notice renders per row, inside the same map
                      // as the two `autoFocus` inline editors below — so the
                      // user's caret can be in a sibling row's field, and the
                      // unguarded arm moved it to another row's busy control.
                      //
                      // `currentTarget`, read synchronously: this is the button,
                      // and the question is only whether the user is standing on
                      // it. Same shape as `breakdown-chat.tsx`'s dismiss control
                      // and `inbox-view.tsx`'s `retryCtaRef` comparison — the
                      // pattern two of these four components already had.
                      if (e.currentTarget === document.activeElement)
                        retryHandoffRef.current.add(s.id);
                      uncomplete(s.id);
                    }}
                    aria-disabled={undoing}
                    className="focus-visible:ring-ring inline-flex min-h-11 items-center rounded underline underline-offset-4 outline-none focus-visible:ring-2 aria-disabled:opacity-50"
                  >
                    {t("focus.error.retry", voice)}
                  </button>
                </p>
              )}
              {/* #44 — a DONE step gets its note READ-ONLY and no control.
                  Annotating finished work has no purpose, so the "Note"
                  affordance would be clutter on a row that deliberately carries
                  no actions; silently hiding text the user already wrote would
                  be worse than either. */}
              {s.notes && <NoteText>{s.notes}</NoteText>}
            </li>
          );
        }

        const editingTitle = editTitleId === s.id;
        const editingEst = editEstId === s.id;
        const focusLabel = t(
          s.resumable ? "step.resumeFocus" : "step.startFocus",
          voice,
        );
        // #253 — the ▾ twin of the CTA above. Restored: this list is the step's
        // canonical action set, and the inline bar a shortcut subset of it.
        const focusMenuLabel = t(
          s.resumable ? "step.resumeFocusTimer" : "step.startFocusTimer",
          voice,
        );
        return (
          <li key={s.id} className="rounded-lg border px-3 py-2 text-sm">
            {/* Title line — mirrors the inbox ItemRow's title row. */}
            <div className="flex items-center gap-3">
              <span className="text-muted-foreground w-8 shrink-0 text-xs tabular-nums">
                {s.order}/{s.total}
              </span>
              {editingTitle ? (
                <StepTitleInput
                  initial={s.text}
                  onSave={(value) => {
                    setEditTitleId(null);
                    if (value && value !== s.text) rename(s.id, value);
                  }}
                  onCancel={() => setEditTitleId(null)}
                />
              ) : (
                <span className="min-w-0 flex-1 break-words">
                  {s.subtaskEmoji ? `${s.subtaskEmoji} ` : ""}
                  {s.text}{" "}
                  {/* #205 leg, folded in because #253 is what makes it
                      load-bearing. This was a ~20px convenience while `Edit step
                      title` sat in the ▾ at 44px; removing that entry as a mirror
                      leaves the pencil as the SOLE route to renaming a step, at a
                      fifth of the area of the entry it outlived. `anchored-popup.ts`
                      draws the line as "entries whose sole-route status THIS change
                      creates" — that is exactly this control, so this change sizes
                      it rather than deferring one it just promoted.

                      Both dimensions matter here, unlike a full-width ▾ entry: it is
                      an emoji-only glyph, so width is the dimension it failed.
                      44x44 is 2.5.5 (Enhanced), AAA — a house convention, not the
                      AA 24x24 of 2.5.8. */}
                  <button
                    type="button"
                    aria-label={`Edit ${s.text}`}
                    onClick={() => {
                      setEditEstId(null);
                      setEditTitleId(s.id);
                    }}
                    className={cn(
                      touchTarget,
                      "text-muted-foreground hover:text-foreground shrink-0 px-1 text-xs",
                    )}
                  >
                    ✏️
                  </button>
                </span>
              )}
              {editingEst ? (
                <StepEstimateInput
                  initial={s.estMinutes}
                  onSave={(minutes) => {
                    setEditEstId(null);
                    if (Number.isFinite(minutes)) updateEstimate(s.id, minutes);
                  }}
                  onCancel={() => setEditEstId(null)}
                />
              ) : (
                <span className="text-muted-foreground shrink-0 text-xs">
                  {s.estMinutes}m
                </span>
              )}
            </div>
            {/* Action line — shared v6 RowActions: Complete + Start/Resume Focus
                inline, everything (state-dependent) in the 🔽 dropdown.
                #44 — the step's note trigger is a third inline control here,
                beside Complete, matching the task rows in the Inbox and the
                Library; its editor opens below the action line but inside this
                same <li>. */}
            <StepNote
              stepId={s.id}
              order={s.order}
              total={s.total}
              text={s.text}
              notes={s.notes}
              voice={voice}
            >
              {({ trigger, body }) => (
                <>
                  <RowActions
                    inline={[
                      <Link
                        key="focus"
                        href={`/focus/${s.id}`}
                        // #206 — the hand-off target for a just-undone step.
                        // Start/Resume Focus, deliberately NOT Complete: the user
                        // has just un-completed this step, so landing focus on the
                        // one control that re-completes it turns a stray Enter
                        // into an undo of their undo. Registered per row rather
                        // than conditionally, so no render depends on which row
                        // was undone.
                        ref={(el) => {
                          ctaRefs.current.set(s.id, el);
                        }}
                        className="bg-primary text-primary-foreground rounded-md px-2.5 py-1 font-medium hover:opacity-90"
                      >
                        {focusLabel}
                      </Link>,
                      <CompleteButton
                        key="complete"
                        voice={voice}
                        onClick={() => complete(s.id)}
                      />,
                      trigger,
                    ]}
                    /* ── #253: the ▾ is this STEP's canonical action list ──────
                       A mid-issue pass in this MR stripped the two entries that
                       mirrored an inline button. Withdrawn — the owner's principle
                       is that the ▾ holds everything a row can do and the inline bar
                       is a shortcut subset, and a principle reversed on two of three
                       surfaces is not one. Both twins are back: the focus-timer link
                       (same `/focus/${s.id}` as the CTA) and `step.complete` (same
                       `complete(s.id)` as the inline Complete). The list is behind a
                       trigger, so its length costs the row no height, which is the
                       only thing #253 is about.

                       DERIVED from what a step can do, not copied from the inbox's
                       eight — this row operates on a STEP, not an item:

                       • `Send back to review` leads. It is this row's "where does
                         this belong" question, the step-grain analogue of the inbox's
                         `Move to…`: `ejectStepToInbox` moves the step out of the task
                         and back into Needs review. Re-bucketing, not deletion — so
                         it belongs in the leading slot, not the trailing one.
                       • Nothing here is destructive. A step has no delete, so the
                         tail slot goes to the lowest-stakes, least-frequent action
                         instead: `Edit time estimate`, a property edit. That entry is
                         the ONLY route to it — the estimate renders as a plain
                         `<span>{s.estMinutes}m</span>`, not a control — which is why
                         it stays while its Library counterpart does not.
                       • No `Move to…`, `Schedule` or `Add to calendar`: a step has no
                         bucket, and scheduling is a TASK-level act reached from
                         `breakdown/task-schedule.tsx`.

                       ⚠️ `Edit step title` is GONE, and it is a tenth instance of the
                       mirror class this issue has been chasing — found here, not
                       briefed. It fired `setEditEstId(null); setEditTitleId(s.id)`,
                       character-for-character what the permanently-visible ✎ pencil
                       on this row's title line fires. Same disposition as the inbox's
                       `editMenuItem`, for the same reason and by the same test: the
                       pencil's `aria-label={`Edit ${s.text}`}` names the step, which
                       is strictly clearer than "Edit step title". The pencil itself is
                       untouched.

                       A DONE step never reaches here — that branch returns earlier
                       with its own hand-rolled `step.uncomplete` row, the way the
                       inbox's Done bucket hand-rolls its line. */
                    menu={groupedRowMenu([
                      [
                        <button
                          key="review-m"
                          type="button"
                          onClick={() => sendToReview(s.id)}
                          className={rowMenuEntry()}
                        >
                          {t("step.sendToReview", voice)}
                        </button>,
                      ],
                      [
                        <Link
                          key="focus-m"
                          href={`/focus/${s.id}`}
                          className={rowMenuEntry()}
                        >
                          {focusMenuLabel}
                        </Link>,
                        <button
                          key="complete-m"
                          type="button"
                          onClick={() => complete(s.id)}
                          className={rowMenuEntry()}
                        >
                          {t("step.complete", voice)}
                        </button>,
                      ],
                      [
                        <button
                          key="edit-est-m"
                          type="button"
                          onClick={() => {
                            setEditTitleId(null);
                            setEditEstId(s.id);
                          }}
                          className={rowMenuEntry()}
                        >
                          {t("step.editEstimate", voice)}
                        </button>,
                      ],
                    ])}
                  />
                  {body}
                </>
              )}
            </StepNote>
          </li>
        );
      })}
    </ol>
  );
}

/** Inline step-title editor — mirrors inbox-view's EditTitleInput. Enter saves
 * (trimmed), Escape cancels. */
function StepTitleInput({
  initial,
  onSave,
  onCancel,
}: {
  initial: string;
  onSave: (value: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(initial);
  return (
    <input
      autoFocus
      value={value}
      aria-label="Edit step title"
      onChange={(e) => setValue(e.target.value)}
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

/** Inline time-estimate editor — a 1..480 number input. Enter saves (server
 * rounds + clamps), Escape cancels. */
function StepEstimateInput({
  initial,
  onSave,
  onCancel,
}: {
  initial: number;
  onSave: (minutes: number) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(String(initial));
  return (
    <input
      autoFocus
      type="number"
      min={1}
      max={480}
      step={1}
      value={value}
      aria-label="Edit time estimate"
      onChange={(e) => setValue(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          // Empty / non-positive input → cancel, don't save. `Number("")` is 0
          // and passes isFinite, which would otherwise be clamped to 1 (Duo review).
          const n = Number(value);
          if (value.trim() === "" || !Number.isFinite(n) || n < 1 || n > 480)
            onCancel();
          else onSave(n);
        }
        if (e.key === "Escape") onCancel();
      }}
      className="border-input bg-background focus-visible:ring-ring w-16 rounded-md border px-2 py-1 text-xs outline-none focus-visible:ring-2"
    />
  );
}
