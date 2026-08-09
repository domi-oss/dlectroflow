/**
 * #227 — undoing an optimistic settings write, and **only the one this attempt
 * made.**
 *
 * Three sections (`NotificationsSection`, `AppearanceSection`,
 * `FocusTimerSection`) hold their controls in a single `Prefs` object, write it
 * optimistically, and share one server action per section. When that write is
 * refused, the naive repair is `setPrefs(previous)` — and it is wrong in two
 * distinct ways, both of which this function exists to avoid:
 *
 *  1. **It undoes fields the attempt never touched.** These sections persist the
 *     whole object on every change, so `previous` is a snapshot of everything,
 *     including changes a *different*, successful attempt has since landed.
 *  2. **It ignores which attempt owns the value on screen.** Nothing disables
 *     these controls during a save — deliberately; they are cheap preferences —
 *     so a slow failure can land after a newer success. Restoring blindly leaves
 *     the page showing the opposite of what the database holds, which is the
 *     same lie #227 is about, pointing the other way.
 *
 * So: restore a field only where **this attempt changed it** and **the value it
 * wrote is still the one showing**. Anything else belongs to somebody else.
 *
 * A shared pure module rather than three copies for the reason the issue gives
 * for `useSaveStatus` itself — three copies of a concurrency guard is how four
 * sections drift apart, and the losing-write interleaving is precisely the case
 * a copy gets wrong. Scalar toggles (`DemoSection`, `ShoppingSection`) keep the
 * inline one-liner `!294` established; there is nothing to iterate over there.
 *
 * No React import, so it is unit-testable in the node environment.
 *
 * @param current   the state as it stands *now* — pass the functional updater's
 *                  argument, never the closure's `prefs`.
 * @param attempted what this attempt optimistically wrote.
 * @param previous  what was showing before this attempt.
 * @returns `current` **by reference** when there is nothing this attempt owns to
 *          undo, so React bails out of the re-render rather than repainting a
 *          section over a failure that no longer concerns it.
 */
export function revertOptimistic<T extends object>(
  current: T,
  attempted: T,
  previous: T,
): T {
  let reverted: T | null = null;

  for (const key of Object.keys(attempted) as (keyof T)[]) {
    // Untouched by this attempt — not ours to restore.
    if (Object.is(attempted[key], previous[key])) continue;
    // A newer value already replaced ours — not ours to restore either.
    if (!Object.is(current[key], attempted[key])) continue;
    reverted ??= { ...current };
    reverted[key] = previous[key];
  }

  return reverted ?? current;
}
