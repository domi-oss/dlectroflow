"use client";

import { useState } from "react";

/**
 * #227 — undoing an optimistic settings write, and **only the one this attempt
 * made.**
 *
 * Three sections (`NotificationsSection`, `AppearanceSection`,
 * `FocusTimerSection`) hold their controls in a single `Prefs` object, write it
 * optimistically, and share one server action per section. When that write is
 * refused, the naive repair is `setPrefs(previous)` — and it is wrong in two
 * distinct ways, both of which this module exists to avoid:
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
 * ## Ownership is a token, not a value comparison (#227 review)
 *
 * The first cut of this decided (2) by asking "is the field still showing the
 * value I wrote?". A newer attempt can answer that `true` **by coincidence**:
 * attempt 1 writes `true` and hangs, attempt 2 writes `false` and lands,
 * attempt 3 writes `true` and lands. Attempt 1 then rejects, sees its own
 * `true` on screen, concludes it still owns the field and restores `false` —
 * over a value the server has accepted. It takes only a double-tap of one
 * switch to reach, and because these sections seed their `useState` from props
 * exactly once, nothing re-syncs after `router.refresh()`; the control
 * disagrees with the database until a full page load.
 *
 * So ownership is tracked explicitly. Each `claim` takes a monotonically
 * increasing token and records it against every field it actually changed. The
 * newest claim for a field wins, and an attempt acts only where its own token
 * is still the one recorded — a question about *identity*, which coincidence
 * cannot answer.
 *
 * ## …and it undoes to what the server confirmed, not to what was on screen
 *
 * The other half of that hole: an attempt's `previous` is simply whatever the
 * control showed when it started, which may itself be an earlier attempt's
 * unconfirmed guess. Restoring it puts a value on screen the server never
 * accepted. So the ledger also keeps, per field, the last value a save actually
 * **confirmed** (seeded from the first claim's `previous`, which is the state
 * the page was rendered with), and rollbacks restore that.
 *
 * `confirm()` is ownership-gated for the same reason `revert()` is: promises
 * settling in one order on the client is not evidence the writes reached the
 * server in that order, so a stale attempt's late success must not be allowed
 * to redefine the baseline a newer attempt already set.
 *
 * A shared module rather than three copies for the reason the issue gives for
 * `useSaveStatus` itself — three copies of a concurrency guard is how four
 * sections drift apart, and the losing-write interleaving is precisely the case
 * a copy gets wrong. Scalar toggles (`DemoSection`, `ShoppingSection`) keep the
 * inline one-liner `!294` established; there is nothing to iterate over there.
 *
 * `createOptimisticOwnership` is a plain closure with no React in it, so the
 * whole concurrency argument above is unit-testable in the node environment;
 * `useOptimisticOwnership` is a two-line wrapper that gives each mounted
 * section its own.
 */

/** One optimistic write, and the two ways it can end. */
export type OptimisticAttempt<T extends object> = {
  /**
   * The save landed. Records what the server now holds for the fields this
   * attempt still owns, so a later rollback restores this rather than an
   * earlier guess.
   */
  confirm(): void;
  /**
   * The save was refused. Restores the last confirmed value of every field this
   * attempt still owns.
   *
   * @param current the state as it stands *now* — pass the functional updater's
   *                argument, never the closure's `prefs`.
   * @returns `current` **by reference** when there is nothing this attempt owns
   *          to undo, so React bails out of the re-render rather than repainting
   *          a section over a failure that no longer concerns it.
   */
  revert(current: T): T;
};

export type OptimisticOwnership<T extends object> = {
  /**
   * Register an optimistic write. Call it in the same synchronous turn as the
   * `setPrefs(next)` it describes, so claims are ordered the way the user made
   * the changes.
   *
   * @param attempted what this attempt optimistically wrote.
   * @param previous  what was showing before this attempt.
   */
  claim(attempted: T, previous: T): OptimisticAttempt<T>;
};

export function createOptimisticOwnership<
  T extends object,
>(): OptimisticOwnership<T> {
  /** Field → the token of the newest attempt that wrote it. */
  const owner = new Map<keyof T, number>();
  /** Field → the last value a save confirmed (or the value the page rendered). */
  const settled = new Map<keyof T, T[keyof T]>();
  let issued = 0;

  return {
    claim(attempted: T, previous: T): OptimisticAttempt<T> {
      const token = ++issued;
      const claimed: (keyof T)[] = [];

      for (const key of Object.keys(attempted) as (keyof T)[]) {
        // Untouched by this attempt — not ours to own, confirm or restore.
        if (Object.is(attempted[key], previous[key])) continue;
        // The first attempt to touch a field learns the server's value from it:
        // `previous` is then still the state the page was rendered with.
        if (!settled.has(key)) settled.set(key, previous[key]);
        claimed.push(key);
        owner.set(key, token);
      }

      return {
        confirm() {
          for (const key of claimed) {
            if (owner.get(key) !== token) continue;
            settled.set(key, attempted[key]);
          }
        },
        revert(current: T): T {
          let reverted: T | null = null;

          for (const key of claimed) {
            // A newer attempt owns the field — not ours to restore, whatever it
            // happens to be showing.
            if (owner.get(key) !== token) continue;
            reverted ??= { ...current };
            // Present for every claimed key: seeded above at claim time. The
            // cast narrows `T[keyof T]` to this key's own type.
            reverted[key] = settled.get(key) as T[typeof key];
          }

          return reverted ?? current;
        },
      };
    },
  };
}

/**
 * One ledger per mounted section, created once. Two sections sharing tokens
 * would let one section's newer attempt disown the other's pending one.
 *
 * A lazy `useState` initialiser rather than the usual `useRef` lazy-init: the
 * ledger has to exist during the render that first calls `claim`, and reading
 * `ref.current` during render is what `react-hooks/refs` forbids. The setter is
 * deliberately dropped — the value is created once and mutated in place, so
 * nothing here ever schedules a re-render.
 */
export function useOptimisticOwnership<
  T extends object,
>(): OptimisticOwnership<T> {
  const [ownership] = useState(createOptimisticOwnership<T>);
  return ownership;
}
