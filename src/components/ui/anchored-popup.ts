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
  /**
   * #172 — the stacking, and it has to live HERE rather than on the popup.
   *
   * `Popover.Popup` / `Menu.Popup` compute to `position: static`, and z-index
   * does nothing on a static element. `popupSurface`'s `z-50` was therefore
   * inert: it read like the stacking was handled and it was not. What actually
   * stacks is this positioner — `position: fixed` plus the transform Base UI
   * writes for placement, so it is a stacking context — and it was left at
   * `z-index: auto`. Auto loses to any positive z-index, so every popup built
   * from this constant painted UNDERNEATH the `sticky top-0 z-[2]` section-nav
   * bar wherever the two overlapped.
   *
   * It stayed invisible because the bar only ever covered a popover's lower
   * rows. Removing a redundant back link from /help moved the bar up ~40px,
   * which put it over the account popover's "Sign out" — a control that was
   * fully visible and could not be clicked.
   *
   * 50 rather than a smaller number so this sits above the app menu's `z-10`
   * too: an anchored popup is the most recently opened surface on the page, so
   * it belongs on top of the page chrome, not interleaved with it.
   */
  className: "z-50",
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
    // No z-index here on purpose. A Base UI `Popup` computes to
    // `position: static`, so a z-index on it is silently ignored — this string
    // used to carry `z-50` and it never once took effect.
    // Stacking belongs to ANCHORED_POSITIONER above, which is the element that
    // is actually positioned; see #172 for how the dead class hid a real bug.
    "bg-background flex max-w-[calc(100vw-1rem)] flex-col rounded-md border shadow-md",
    className,
  );
}

/**
 * One row-action menu entry.
 *
 * #253 — this exists because that issue **promoted** these entries. The ▾ list
 * used to be a full mirror: every entry it held was also a 44px control on the
 * row itself (📥 move, 📅 schedule, 🗑 delete) or a permanently-visible inline
 * button. Deleting the trailing icon cluster leaves the list as the ONLY route to
 * Move to, Snooze, Schedule, Add to calendar, Edit and Delete — so an entry that
 * was a convenience at ~24px is now the whole affordance, and one of them deletes
 * a task.
 *
 * `min-h-11` + `min-w-11` rather than `touchTarget`, which also sets
 * `justify-center` and would centre the label in a left-aligned list. The width
 * floor is redundant against `w-full` and kept anyway, because the target-size
 * guards in `inbox-view.test.tsx` and `library-rows.test.tsx` measure BOTH
 * dimensions of every control inside `[data-row-actions]` — and the popup is
 * portaled in there, so an open list is in scope. A guard that has to be told to
 * skip these entries is a guard that stops seeing them. Shaped to match
 * `nav/account-menu.tsx`'s and `nav/app-menu.tsx`'s `ENTRY` strings, which
 * already solved this for the header popups — the two of them are hoisted for
 * exactly this reason and #117 exists because they had drifted.
 *
 * ── Deliberately NOT everything in a row popup ─────────────────────────────
 *
 * `MoveToMenu`'s nested bucket items keep their existing size. They were already
 * the sole route to a given bucket before #253 — both the compact 📥 and the text
 * "Move to…" open the same nested list — so nothing this issue does changes their
 * reachability. Sizing them is #205's sweep, not this one. The line drawn here is
 * "entries whose sole-route status THIS change creates", which is checkable
 * against the diff rather than a matter of taste.
 */
export function rowMenuEntry(className?: string): string {
  return cn(
    "hover:bg-accent flex min-h-11 w-full min-w-11 items-center rounded-md px-2.5 py-1 text-left",
    className,
  );
}
