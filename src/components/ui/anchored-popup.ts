import { cn } from "@/lib/utils";

/**
 * #92 — the one place that decides how every row-action popup avoids running
 * off the screen.
 *
 * Before this, each popup was `absolute right-0` anchored to its own trigger,
 * which is only correct when the trigger happens to sit far enough from the
 * viewport edges. At 390px it did not: the 📥 Move-to trigger sits at x≈73 as
 * the leftmost control of a wide end cluster, so its 160px menu was laid out
 * from left:-43 with `document.scrollWidth === 390` — no horizontal scroll to
 * recover with, first entry permanently unreachable. The same shape clipped the
 * 🔽 All-options popup and the 📅 duration popover past the bottom edge.
 *
 * `@base-ui/react`'s positioners (already a dependency — see
 * src/components/ui/button.tsx) measure the popup against the viewport and
 * correct it, so the policy lives here once instead of being rediscovered by
 * the next popup someone adds.
 *
 * Spread onto a `Menu.Positioner` / `Popover.Positioner`.
 */
export const ANCHORED_POSITIONER = {
  /** Preferred placement: under the trigger, right edges aligned — what the
   *  old `absolute right-0 mt-1` produced when it happened to fit. */
  side: "bottom",
  align: "end",
  sideOffset: 4,
  /** Keep a visible margin from the viewport edge rather than sitting flush. */
  collisionPadding: 8,
  collisionAvoidance: {
    /** No room below (a row near the bottom edge) → open upwards instead. */
    side: "flip",
    /** Would run past the left/right edge → nudge along the trigger's axis by
     *  the smallest amount that fits, keeping the popup next to its trigger
     *  instead of jumping to the other alignment. */
    align: "shift",
  },
  /** Immune to any ancestor `transform` and to any clipping ancestor a future
   *  layout might introduce. The original motivating case — dnd-kit putting a
   *  `transform` on a dragging row — went away with #163, which moved the inbox
   *  onto the platform's own drag and drop (it photographs a separate preview
   *  element and never transforms the row). The property stays: `motion` is a
   *  dependency, `scale-*` and `translate-*` are used elsewhere in the tree, and
   *  a popup that silently mispositions under a transformed ancestor is exactly
   *  the class of fault #92 was. */
  positionMethod: "fixed",
} as const;

/**
 * The shared popup surface. `max-w` is belt-and-braces next to the positioner's
 * shifting: collision avoidance can only move a popup that *fits*, so a popup
 * wider than the viewport (a long translated label, a 320px-wide phone) needs a
 * width cap as well. Deliberately no max-height/overflow counterpart: the tall
 * popup here is 288px against a 844px viewport, flipping handles it, and a
 * scroll container on the 🔽 popup would become a clipping ancestor for the
 * Move-to menu nested inside it.
 */
export function popupSurface(className?: string): string {
  return cn(
    "bg-background z-50 flex max-w-[calc(100vw-1rem)] flex-col rounded-md border shadow-md",
    className,
  );
}
