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
 * arrow-key roving focus over the entries.
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
  const targets = BUCKET_ORDER.filter((b) => b !== currentBucket);

  return (
    <span ref={host} className="relative">
      {/* modal={false} — Base UI's Menu default locks document scroll. Row
          menus must not: the page has to stay scrollable underneath, and a
          scroll must not dismiss the menu. */}
      <Menu.Root modal={false}>
        <Menu.Trigger
          aria-label={compact ? "Move to" : undefined}
          aria-describedby={describedById}
          title={compact ? "Move to" : undefined}
          className={cn(
            compact
              ? // End-cluster icon (owner: mobile screenshot) — same ghost hover
                // + slightly bigger glyph as the row's other icon controls (📅/▾
                // in row-actions.tsx) instead of a bare, hover-less glyph.
                "text-muted-foreground hover:bg-accent hover:text-foreground rounded-md px-2 py-1 text-sm font-medium"
              : // #253 — the ▾ list is the only route to this menu now that the
                // compact 📥 has gone with the end cluster, so the text trigger takes
                // the same 44px minimum every other entry in that list has. Not
                // `rowMenuEntry`: this one keeps its border, which is what
                // distinguishes a nested submenu trigger from a plain entry.
                "text-muted-foreground hover:text-foreground flex min-h-11 min-w-11 items-center justify-center rounded-md border px-2 py-1 text-xs",
            compact && touchTarget,
          )}
        >
          {compact ? "📥" : t("action.moveTo", voice)}
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
