"use client";

import { useRef } from "react";
import { Menu } from "@base-ui/react/menu";
import { ChevronRight } from "lucide-react";
import { BUCKET_ORDER, BUCKET_LABEL, type BucketId } from "./bucket";
import { t, type Voice } from "@/lib/strings";
import { cn, touchTarget } from "@/lib/utils";
import {
  ANCHORED_POSITIONER,
  popupSurface,
  restoreFocusToTrigger,
  rowMenuEntry,
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
 */
export function MoveToMenu({
  currentBucket,
  voice,
  onMove,
  compact = false,
  describedById,
}: {
  currentBucket: BucketId;
  voice: Voice;
  onMove: (target: BucketId) => void;
  /** v6: row end-cluster variant — a 📥 icon trigger (aria-label "Move to")
   * instead of the full "Move to…" text button used in the ▾ dropdown. */
  compact?: boolean;
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
          aria-label={compact ? "Move to" : undefined}
          aria-describedby={describedById}
          title={compact ? "Move to" : undefined}
          className={
            compact
              ? // End-cluster icon (owner: mobile screenshot) — same ghost hover
                // + slightly bigger glyph as the row's other icon controls (📅/▾
                // in row-actions.tsx) instead of a bare, hover-less glyph.
                cn(
                  "text-muted-foreground hover:bg-accent hover:text-foreground rounded-md px-2 py-1 text-sm font-medium",
                  touchTarget,
                )
              : // #253 — `rowMenuEntry`, the same string every other entry in the ▾
                // list uses, and the change here is what it STOPPED using. A first
                // pass gave this trigger `border` + `justify-center`, reasoning that a
                // box distinguishes a nested submenu trigger from a plain entry. On
                // screen at 360px it read as an outlier dropped into the middle of the
                // column — a boxed, centred label between left-aligned unboxed ones —
                // and the owner's complaint about the list having no rhythm was partly
                // this. A submenu says so with a disclosure glyph, which is the
                // convention, costs no border and keeps the row on the same left
                // margin as its neighbours.
                rowMenuEntry("justify-between")
          }
        >
          {compact ? (
            "📥"
          ) : (
            <>
              {t("action.moveTo", voice)}
              {/* Decorative: `aria-hidden` keeps it out of the accessible name, so
                  the trigger is still named exactly "Move to…" for voice control and
                  for every row-scoped query. Base UI already writes the
                  `aria-haspopup`/`aria-expanded` that carry the meaning to a screen
                  reader — this glyph is the sighted half of the same fact. An `<svg>`
                  rather than a "›" text node for the same reason it is hidden: it
                  contributes nothing to `textContent` either. */}
              <ChevronRight
                aria-hidden="true"
                className="h-3.5 w-3.5 shrink-0"
              />
            </>
          )}
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
