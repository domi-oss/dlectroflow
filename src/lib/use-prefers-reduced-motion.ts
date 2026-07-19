"use client";

import { useSyncExternalStore } from "react";

const QUERY = "(prefers-reduced-motion: reduce)";

function subscribe(onChange: () => void): () => void {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return () => {};
  const mq = window.matchMedia(QUERY);
  mq.addEventListener("change", onChange);
  return () => mq.removeEventListener("change", onChange);
}

function getSnapshot(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
  return window.matchMedia(QUERY).matches;
}

/** Server / pre-hydration snapshot — always "motion allowed" until the client
 *  can read the real media query. */
function getServerSnapshot(): boolean {
  return false;
}

/**
 * True when the OS "reduce motion" accessibility setting is on.
 *
 * Subscribes to the `prefers-reduced-motion: reduce` media query via
 * `useSyncExternalStore`, so it is SSR-safe (returns `false` on the server and
 * before hydration) and stays in sync if the user toggles the setting
 * mid-session. Used to skip non-essential animation (chiefly the focus-completion
 * confetti) so motion-sensitive users get an instant, static reward instead.
 */
export function usePrefersReducedMotion(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
