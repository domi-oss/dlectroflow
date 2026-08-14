"use client";

import { useRef } from "react";
import { Menu } from "@base-ui/react/menu";
import { BUCKET_ORDER, BUCKET_LABEL, type BucketId } from "./bucket";
import { t, type Voice } from "@/lib/strings";
import { cn, touchTarget } from "@/lib/utils";
import {
  ANCHORED_POSITIONER,
  popupSurface,
} from "@/components/ui/anchored-popup";

/**
 * Keyboard/screen-reader accessible "Move to…" menu — the non-pointer fallback
 * for drag. Shares the same move dispatch as drag (the parent's onMove →
 * moveItemToBucket), so the two paths can't diverge.
 *
 * #92: the popup is a `Menu.Positioner`, not `absolute right-0`, so it can no
 * longer be laid out past the viewport edge (see ui/anchored-popup.ts). Base UI
 * also brings what the hand-rolled version had to state explicitly, and a
 * little more: `aria-haspopup`/`aria-expanded`/`aria-controls`, Escape and
 * outside-press dismissal, focus returned to the trigger on close, and
 * arrow-key roving focus over the entries. The focus return is asynchronous, which
 * matters only where an enclosing popover can out-race it — not here, since #253
 * removed the ▾ entry that put this menu inside one. Measured, see `Menu.Root`.
 *
 * The popup is portaled into this component's own wrapper (`container={host}`)
 * rather than to `<body>`: it keeps the menu inside the row it belongs to — so
 * a press inside it is still a press inside its parent 🔽 popover, and row-
 * scoped queries keep meaning "this row's menu" — and every part renders as a
 * `<span>` because MoveToMenu is used in phrasing contexts where a `<div>`
 * would be invalid.
 *
 * ── #253: 📥 only, and the `compact` prop is gone ───────────────────────────
 *
 * This was two variants — a compact 📥 icon and a full-width "Move to…" text entry
 * for a row's ▾ list. The text entry is REMOVED from every ▾, because the canonical
 * list's own entries name the same destinations: `Add as multi-step to-do`,
 * `Add as single-task to-do`, `Save for later` and `Mark as completed` are four of
 * the five buckets in `ACTION_FOR_BUCKET`, and the fifth (`needsReview`) now has its
 * own `action.sendToReview` entry on each row that needed one. A nested picker
 * offering the same places was a second route, one tap deeper — and the only nested
 * popup left in those lists.
 *
 * The prop went with the branch rather than being left as a default nothing selects,
 * on this MR's own precedent: `RowActions`'s `move`/`schedule`/`del` were removed
 * instead of left inert, because #213 had already been written against a prop with
 * no render path.
 *
 * The two remaining callers are the inline 📥 on the idle Saved row and on the Done
 * row. Neither has a ▾ carrying destinations, so on those two this is still the only
 * non-drag route to a bucket — which is why it survives at all.
 *
 * The styling question the text entry raised (a bordered, centred trigger reading as
 * an outlier mid-list) is dissolved rather than answered: there is no in-list
 * trigger left to style.
 */
export function MoveToMenu({
  currentBucket,
  stepsTotal,
  voice,
  onMove,
  describedById,
}: {
  currentBucket: BucketId;
  /** #253 — the item's step count, used only to suppress `singleTask`, which an
   * item with 2+ steps cannot reach. Optional and defaulting to "offer it": absent,
   * it must not silently remove a legitimate destination.
   *
   * A number rather than a `hasSteps` boolean because the threshold is a fact about
   * the bucket split and belongs beside it — `bucket.ts` puts a ONE-step task in
   * Single-task ("its step exists so ▶ Focus has a target; only 2+ steps make it
   * multi-step"), so the test is `> 1` and a boolean would have hidden which. */
  stepsTotal?: number;
  voice: Voice;
  onMove: (target: BucketId) => void;
  /** #163 — id of the board's shared move-instructions node. Since
   * pragmatic-drag-and-drop has no keyboard adapter this trigger is not a
   * fallback for dragging, it is the whole non-pointer path, so it is worth
   * saying what it does. Optional: a caller with no such node just omits it,
   * and no `aria-describedby` is written at all — a dangling one is #94. */
  describedById?: string;
}) {
  const host = useRef<HTMLSpanElement>(null);
  // #253 — a destination the item provably cannot reach is not offered.
  //
  // `moveItemToBucket(id, "singleTask")` dispatches `triage`, which clears
  // `breakdownRequestedAt` but leaves the steps — and `bucketOfItem` returns
  // `multiStep` for ANY triaged item with `stepsTotal > 1`. So the row would not
  // move while `movedAnnouncement` announced that it had, which is the same defect
  // the Multi-step row's ▾ hides by gating its own Single-task entry on
  // `awaitingBreakdown`. One sweep across both surfaces, not two.
  //
  // Reachable, and traced link by link in `move-to-menu.test.tsx` rather than
  // assumed: this menu renders only on the idle Saved row and the Done row, and
  // `moveToReview` retains the Task and its steps, so a multi-step item can be sent
  // back to review, saved for later, and arrive here still carrying them.
  const targets = BUCKET_ORDER.filter(
    (b) =>
      b !== currentBucket && !(b === "singleTask" && (stepsTotal ?? 0) > 1),
  );

  return (
    <span ref={host} className="relative">
      {/* modal={false} — Base UI's Menu default locks document scroll. Row
          menus must not: the page has to stay scrollable underneath, and a
          scroll must not dismiss the menu. */}
      <Menu.Root
        modal={false}
        // ── No explicit focus hand-off here, and that is measured, not assumed ───
        //
        // #253 briefly added `onOpenChange={() => restoreFocusToTrigger(...)}` to
        // this menu, justified as beating "the enclosing ▾ popover" whose async
        // `restoreFocus: "popup"` manager grabs its own container a frame late.
        // That race is real — see `restoreFocusToTrigger` — but it needs an
        // enclosing popover, and this issue removed the "Move to…" ▾ entry that
        // provided one. The two remaining render sites (`inbox-view.tsx`'s idle
        // Saved row and Done row) are plain inline flex lines with nothing around
        // them to lose the race to, so there was no composition left for the line
        // to change.
        //
        // Removed rather than kept as defence-in-depth, on this MR's own precedent:
        // `RowActions`'s `move`/`schedule`/`del` props and this file's `compact`
        // prop were deleted rather than left inert, because #213 had already been
        // written against a prop with no render path.
        //
        // Base UI's own restoration is what returns focus here, and the docblock
        // above lists that as something it already provides. Verified by the same
        // 10-run method that found the original race: with the line removed,
        // "dismissing the Move-to menu hands focus back to the 📥 that opened it"
        // passed 10/10, where the genuine bug failed 7/10. That e2e assertion stays
        // — it is now an explicit check that the platform default suffices in THIS
        // composition, which is the thing that would stop being true if the picker
        // were ever put back inside a popup.
        //
        // `ScheduleControl`/`ScheduleMenu` keep the explicit hand-off. Those are
        // genuinely nested inside the ▾ popup and their spec fails without it.
      >
        <Menu.Trigger
          aria-label="Move to"
          aria-describedby={describedById}
          title="Move to"
          // Inline icon (owner: mobile screenshot) — the same ghost hover and
          // slightly bigger glyph as the row's other icon controls, rather than a
          // bare hover-less glyph.
          className={cn(
            "text-muted-foreground hover:bg-accent hover:text-foreground rounded-md px-2 py-1 text-sm font-medium",
            touchTarget,
          )}
        >
          📥
        </Menu.Trigger>
        <Menu.Portal container={host} render={<span />}>
          <Menu.Positioner {...ANCHORED_POSITIONER} render={<span />}>
            <Menu.Popup
              render={<span />}
              className={popupSurface("min-w-40 p-1 text-xs")}
            >
              {targets.map((b) => (
                <Menu.Item
                  key={b}
                  // Rendered as a real <button> (as before), so `nativeButton`
                  // tells Base UI not to synthesise button semantics on top.
                  nativeButton
                  render={<button type="button" />}
                  onClick={() => onMove(b)}
                  // data-[highlighted] is the arrow-key cursor. Without it,
                  // keyboard navigation would move an invisible selection.
                  className="hover:bg-accent data-[highlighted]:bg-accent rounded px-2 py-1 text-left"
                >
                  {t(BUCKET_LABEL[b], voice)}
                </Menu.Item>
              ))}
            </Menu.Popup>
          </Menu.Positioner>
        </Menu.Portal>
      </Menu.Root>
    </span>
  );
}
