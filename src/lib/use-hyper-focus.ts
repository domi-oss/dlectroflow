"use client";

import { useCallback, useSyncExternalStore } from "react";
import {
  HYPER_FOCUS_EVENT,
  readHyperFocus,
  writeHyperFocus,
} from "@/lib/hyper-focus";

/**
 * #142 — read/write "hyper focus mode" from a client component.
 *
 * `useSyncExternalStore` rather than `useState` + an effect, for the same reason
 * `usePrefersReducedMotion` uses it: the value lives outside React, more than
 * one component reads it in the same session (the /focus launcher's toggle and
 * the focus timer's completion screen), and they must never disagree.
 *
 * `getServerSnapshot` returns **off**, which is also the documented default, so
 * the server HTML and the first client render always match. That is deliberate
 * rather than incidental — #75 and #94 are both hydration mismatches in this
 * tree, and #75's silently reverted dark mode for real users. Nothing here is
 * read during render from `localStorage`; the subscription is what updates it.
 */

function currentStore(): Storage | null {
  return typeof window === "undefined" ? null : window.localStorage;
}

function subscribe(onChange: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  // `storage` covers other tabs (it never fires in the tab that wrote), and the
  // custom event covers this one.
  window.addEventListener("storage", onChange);
  window.addEventListener(HYPER_FOCUS_EVENT, onChange);
  return () => {
    window.removeEventListener("storage", onChange);
    window.removeEventListener(HYPER_FOCUS_EVENT, onChange);
  };
}

function getSnapshot(): boolean {
  return readHyperFocus(currentStore());
}

function getServerSnapshot(): boolean {
  return false;
}

export function useHyperFocus(): [boolean, (on: boolean) => void] {
  const on = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  const set = useCallback((next: boolean) => {
    writeHyperFocus(currentStore(), next);
    // Notify this tab. Without it `useSyncExternalStore` has no reason to
    // re-read, and the toggle would look inert until something else re-rendered.
    if (typeof window !== "undefined")
      window.dispatchEvent(new Event(HYPER_FOCUS_EVENT));
  }, []);
  return [on, set];
}
