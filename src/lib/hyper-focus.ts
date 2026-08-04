// #142 — "hyper focus mode": the setting that decides what happens after a
// SINGLE-TASK to-do is completed. Off, it returns you to /focus. On, it chains
// straight into the next single-task to-do behind the same 5-second countdown
// and the same escape.
//
// It governs single-task chaining ONLY. Auto-advance from one step of a
// multi-step task to the next is not gated behind it — inside a task the
// sequence is the thing you already agreed to.
//
// ── Where it is stored, and why that is not the Settings table ──────────────
//
// Every other focus preference (`focusSound`, `focusMinimalMode`, …) is a column
// on `Settings`, and that remains the right home for a *taste* setting shared
// across a workspace's devices. This one is stored per-browser instead, for two
// reasons that are specific to it:
//
//  * It is a *mode*, not a taste — "keep feeding me to-dos" is true of a
//    session, not of an account, and the phone in your pocket is rarely in the
//    same mode as the desktop you left work on.
//  * It only ever changes what the client does *after* a completion, which is
//    long after hydration. That means it can be read in an effect and defaulted
//    to off on the server with no hydration mismatch — the failure mode that
//    #75 (a `Math.random()` in `useState` on /settings) and #94 both are, and
//    that #75 in particular used to revert dark mode for real users.
//
// Pure module, no DOM: the store is passed in, so the semantics are testable on
// a plain object and the hook (`use-hyper-focus.ts`) is the only thing that has
// to know `window.localStorage` exists.

/** The `localStorage` subset this needs. Lets tests hand over a plain object. */
export type KeyValueStore = Pick<Storage, "getItem" | "setItem">;

/** Namespaced like `df-theme`, so the app owns an obvious slice of the origin. */
export const HYPER_FOCUS_STORAGE_KEY = "df-hyper-focus";

/**
 * Broadcast on change so every mounted reader updates at once — the launcher
 * toggle and the focus timer can both be on screen in the same session, and
 * `storage` events only fire in OTHER tabs, never the one that wrote.
 */
export const HYPER_FOCUS_EVENT = "df-hyper-focus-change";

/** The only value that means "on". See `readHyperFocus`. */
const ON = "1";

/**
 * Read the mode. **Off unless the stored value is exactly `"1"`.**
 *
 * Strict rather than truthy on purpose: this flag starts a timed navigation, so
 * a half-written value, a foreign key collision in a shared origin, or a
 * hand-edited `"true"` must not be enough to switch it on. Off is both the
 * default and the safe answer, so they are the same answer.
 *
 * Never throws. `getItem` can throw behind a blocked-cookies policy, and losing
 * the focus timer to a storage permission would be a far worse bug than
 * forgetting a preference.
 */
export function readHyperFocus(
  store: KeyValueStore | null | undefined,
): boolean {
  if (!store) return false;
  try {
    return store.getItem(HYPER_FOCUS_STORAGE_KEY) === ON;
  } catch {
    return false;
  }
}

/**
 * Persist the mode. Also never throws — Safari's private mode throws from
 * `setItem`, and a preference that fails to save is not worth an error screen.
 * The caller's own state has already moved, so the toggle still responds; it
 * simply will not be remembered next time.
 */
export function writeHyperFocus(
  store: KeyValueStore | null | undefined,
  on: boolean,
): void {
  if (!store) return;
  try {
    store.setItem(HYPER_FOCUS_STORAGE_KEY, on ? ON : "0");
  } catch {
    /* storage unavailable — see the doc comment */
  }
}
