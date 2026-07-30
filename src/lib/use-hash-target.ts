"use client";

import { useSyncExternalStore } from "react";

/**
 * The section id the URL fragment currently names — `""` when there is none.
 *
 * Module level and callable outside render, because both consumers need it:
 * {@link useHashTarget} reads it as a store snapshot, and event handlers read
 * it directly.
 */
export function currentHashTarget(): string {
  if (typeof window === "undefined") return "";
  const raw = window.location.hash.slice(1);
  if (!raw) return "";
  try {
    return decodeURIComponent(raw);
  } catch {
    // A malformed escape (`#%zz`) makes decodeURIComponent THROW rather than
    // return its input, and this runs during render — the raw fragment is a
    // better answer than a crashed page.
    return raw;
  }
}

/**
 * Call `onChange` whenever the fragment target actually changes.
 *
 * Two events, because one is not enough:
 *  - `hashchange` covers a fragment link, a typed URL and Back/Forward between
 *    two fragments;
 *  - `popstate` covers history entries pushed with the History API, which is
 *    how Next's router navigates — those fire no `hashchange` at all.
 *
 * The "actually changes" part is load-bearing rather than an optimisation:
 * `popstate` fires for every history entry, most of which leave the fragment
 * alone, and a consumer that treats each one as "the reader asked for this
 * section again" would re-open a section they had just closed (#115).
 */
export function subscribeToHashTarget(onChange: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  let last = currentHashTarget();
  const notify = () => {
    const next = currentHashTarget();
    if (next === last) return;
    last = next;
    onChange();
  };
  window.addEventListener("hashchange", notify);
  window.addEventListener("popstate", notify);
  return () => {
    window.removeEventListener("hashchange", notify);
    window.removeEventListener("popstate", notify);
  };
}

/**
 * Server / pre-hydration snapshot.
 *
 * Always `""`, and not by choice: a fragment is never sent to the server, so
 * the first pass genuinely cannot know it. React re-renders with the real value
 * immediately after hydration — which is precisely what lets a collapsed
 * section open itself on a deep link (#115) without a set-state-in-effect.
 */
function getServerSnapshot(): string {
  return "";
}

/**
 * The current URL fragment, without its `#`.
 *
 * Same `useSyncExternalStore` shape as `useMediaQuery` and
 * `usePrefersReducedMotion`: SSR-safe, live for the rest of the visit, and a
 * PRIMITIVE snapshot so React's `Object.is` comparison settles.
 */
export function useHashTarget(): string {
  return useSyncExternalStore(
    subscribeToHashTarget,
    currentHashTarget,
    getServerSnapshot,
  );
}
