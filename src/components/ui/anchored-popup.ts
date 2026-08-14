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
 * width cap as well. Deliberately no max-height/overflow counterpart: the tallest
 * popup here is 416px — the Needs-review ▾, 8 entries at 44px plus separators,
 * measured at 360x780 in `e2e/smoke/row-menu-viewport-fit.spec.ts` — against a
 * 780-844px viewport, so flipping handles it. It read "288px" until #253, which is
 * what #92 measured before this issue promoted the list's entries to 44px; the
 * number is restated rather than dropped because it is what the absent
 * max-height rests on. A scroll container on the 🔽 popup would also become a
 * clipping ancestor for the Schedule dialog nested inside it.
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
 * Hand focus back to the control that opened a popup — synchronously, in the
 * same task as the close, and BEFORE the state update that unmounts it.
 *
 * #253 is why this exists, and the "synchronously" is the entire content of the
 * fix rather than a stylistic preference.
 *
 * Deleting the row's trailing icon cluster left the ▾ list as the only route to
 * Schedule, which opens a second floating layer of its own inside it. That is the
 * composition this fixes, and — as it turns out — the ONLY one.
 *
 * ⚠️ `MoveToMenu` was a second caller and no longer is. It had the same nested
 * shape while a "Move to…" ▾ entry opened it; this issue removed that entry, so its
 * two remaining render sites are plain inline flex lines with no enclosing popover
 * to lose the race to. Measured by the same 10-run method used below: with the
 * explicit hand-off removed there, the Move-to focus spec passed 10/10. The call
 * was deleted rather than kept as defence-in-depth, on this MR's precedent for
 * inert code (#213). So this helper has one caller, `ScheduleControl` — kept as a
 * shared helper because the race it defuses is a property of Base UI's
 * `restoreFocus: "popup"` manager rather than of one component.
 *
 * Base UI restores focus on close by itself — but
 * ASYNCHRONOUSLY, and it loses a race to the enclosing list. `Popover.Popup`
 * (which `RowActions` renders the ▾ list as) mounts its focus manager with
 * `restoreFocus: "popup"`, whose `focusout` handler fires in a microtask and
 * checks for `document.activeElement === document.body`. An inner popup's own
 * unmount-then-restore passes through exactly that state, so the handler
 * concludes focus is being lost, focuses the popup CONTAINER, and — because the
 * mode is `"popup"` — focuses it AGAIN on the next animation frame, which lands
 * after the inner layer's restoration and overwrites it.
 *
 * The end state was a `tabindex="-1"` span: focus on no control at all, and the
 * user's place in the list gone (WCAG 2.4.3 Focus Order). Measured on this branch
 * before the fix, 10 consecutive runs of the Move-to focus spec — titled
 * "dismissing the Move-to menu hands focus back to the 📥 that opened it"
 * (e2e/smoke/row-menu-viewport-fit.spec.ts) — **7 failed**, and the Schedule
 * dialog's equivalent failed 2 for 2 including its CI retry: that one has no test
 * title of its own, it is the settled-focus assertion inside "the menu remembers
 * the choice, and the .ics path keeps its one click"
 * (e2e/smoke/schedule-menu.spec.ts).
 *
 * ⚠️ Both citations are quoted from the specs as they stand. The first named a
 * title that does not exist — it said "the nested Move-to menu … back to the
 * entry", written when the picker opened from a ▾ entry; #253 removed that entry,
 * the spec was renamed to the 📥 it now opens from, and this comment kept the old
 * words. A quoted title that cannot be grepped is worse than a bare file
 * reference, because it reads as though it had been checked.
 *
 * Moving focus first is what defuses it: by the time the inner popup unmounts,
 * `activeElement` is the trigger rather than `<body>`, so the branch above is
 * never entered and nothing is queued to overwrite. A `finalFocus`/`returnFocus`
 * ref would not do — that is the same async restoration, just aimed differently.
 *
 * Call it from the close path itself, not from an effect watching `open`: an
 * effect runs after the commit that already unmounted the popup, which is the
 * race this avoids. Safe on an unmounted trigger (a move that re-buckets its own
 * row) — `null?.focus()` is a no-op, and Base UI's own restoration remains as the
 * fallback for any close route that does not come through here.
 */
export function restoreFocusToTrigger(trigger: HTMLElement | null): void {
  trigger?.focus();
}

/**
 * One row-action menu entry.
 *
 * #253 — this exists because that issue **promoted** these entries. The ▾ list
 * used to be a full mirror: every entry it held was also a 44px control on the
 * row itself (📥 move, 📅 schedule, 🗑 delete) or a permanently-visible inline
 * button. Deleting the trailing icon cluster leaves the list as the ONLY route to
 * Schedule, Add to calendar, Edit and Delete — so an entry that was a convenience
 * at ~24px is now the whole affordance, and one of them deletes a task.
 *
 * ⚠️ `Move to` and `Snooze` were in that sentence and have been struck from it,
 * because both were removed from the list later in this same issue and the list is
 * not a route to either: the nested Move-to picker is now reached only from the
 * inline 📥 on the idle Saved row and the Done row, and `Snooze 1h` went by the
 * owner's decision, its 60-minute write still reachable through `Save for later`.
 * The destinations the picker used to offer are named directly by the list's own
 * entries instead, which are already at this size.
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
 * `MoveToMenu`'s nested bucket items keep their existing size, and their
 * reachability is not narrowed by this issue — it is WIDENED. Those items were
 * always the sole route to a given *bucket* from the row they sit on; what this
 * issue removed was one of two ENTRANCES to the same nested list (the full-width
 * "Move to…" entry), while adding explicit destination entries to every ▾ that
 * needed them, each already at 44px via `rowMenuEntry`. So the buckets those
 * items reach now have a 44px route they did not have before.
 *
 * ⚠️ Do NOT read this as "#205 will size them". That issue's method is to grep
 * `py-1` under `inbox/` and `library/` and then DISCARD every file containing
 * `touchTarget` — and `move-to-menu.tsx` contains it, for its trigger. Its sweep
 * structurally cannot see these items, so a deferral pointing there would go
 * nowhere. They are unsized on the merits above, not parked.
 *
 * The line drawn here is "entries whose sole-route status THIS change creates",
 * which is checkable against the diff rather than a matter of taste.
 */
export function rowMenuEntry(className?: string): string {
  return cn(
    "hover:bg-accent flex min-h-11 w-full min-w-11 items-center rounded-md px-2.5 py-1 text-left",
    className,
  );
}
