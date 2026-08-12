"use client";

import { useRef } from "react";
import { Menu } from "@base-ui/react/menu";
import { BUCKET_ORDER, BUCKET_LABEL, type BucketId } from "./bucket";
import { t, type Voice } from "@/lib/strings";
import { cn, touchTarget } from "@/lib/utils";
import {
  ANCHORED_POSITIONER,
  popupSurface,
  restoreFocusToTrigger,
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
 * arrow-key roving focus over the entries. The focus return is the one that
 * needed help — Base UI does it asynchronously, and #253 put this menu somewhere
 * that out-races it (see `onOpenChange` below).
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
 * list's own entries name the same destinations: `Break into multi-step to-do`,
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
  voice,
  onMove,
  describedById,
}: {
  currentBucket: BucketId;
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
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const targets = BUCKET_ORDER.filter((b) => b !== currentBucket);

  return (
    <span ref={host} className="relative">
      {/* modal={false} — Base UI's Menu default locks document scroll. Row
          menus must not: the page has to stay scrollable underneath, and a
          scroll must not dismiss the menu. */}
      <Menu.Root
        modal={false}
        // #253 — hand focus back here rather than leaving it to Base UI's own
        // async restoration, which the enclosing ▾ popover out-races: see
        // `restoreFocusToTrigger`. This is the ONLY route to a bucket now that
        // the compact 📥 has gone, so losing the user's place in that list on
        // every Escape is a WCAG 2.4.3 failure on the row's only move path.
        //
        // Runs on the item-select close too, which is what it should do — that
        // is the case move-to-menu.test.tsx already asserts, and it cannot see
        // this bug because it renders the menu with no outer popup to lose to.
        onOpenChange={(nextOpen) => {
          if (!nextOpen) restoreFocusToTrigger(triggerRef.current);
        }}
      >
        <Menu.Trigger
          ref={triggerRef}
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
