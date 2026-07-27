"use client";

import { useCallback, useSyncExternalStore } from "react";

/**
 * Subscribe to a CSS media query from React.
 *
 * Mirrors `usePrefersReducedMotion` (same `useSyncExternalStore` shape) so it is
 * SSR-safe and stays live if the viewport changes mid-session — used by the
 * section nav (#72) to pick its collapsed/expanded default per breakpoint.
 *
 * `serverSnapshot` is what the server (and the hydration pass) sees before the
 * real query can be read; React re-renders with the true value immediately after
 * hydration, so this is a deliberate first-paint guess, not a mismatch.
 */
export function useMediaQuery(query: string, serverSnapshot = false): boolean {
  const subscribe = useCallback(
    (onChange: () => void) => {
      if (
        typeof window === "undefined" ||
        typeof window.matchMedia !== "function"
      ) {
        return () => {};
      }
      const mq = window.matchMedia(query);
      mq.addEventListener("change", onChange);
      return () => mq.removeEventListener("change", onChange);
    },
    [query],
  );

  const getSnapshot = useCallback(() => {
    if (
      typeof window === "undefined" ||
      typeof window.matchMedia !== "function"
    ) {
      return serverSnapshot;
    }
    return window.matchMedia(query).matches;
  }, [query, serverSnapshot]);

  const getServerSnapshot = useCallback(() => serverSnapshot, [serverSnapshot]);

  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
