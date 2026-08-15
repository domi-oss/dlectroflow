"use client";

import { useEffect } from "react";

import {
  PREFERS_DARK_QUERY,
  THEME_ATTRIBUTE,
  normaliseThemePreference,
} from "@/lib/theme";

/**
 * Keeps a `system` theme preference live — #85.
 *
 * The `<head>` bootstrap resolves the theme once, before the first paint. This
 * covers the rest of the session: macOS, iOS, Windows and Android all switch
 * appearance on their own schedule, and that schedule is how "dark mode
 * automatic with time of day" — the request this issue came from — is actually
 * delivered. Without this, following the OS would mean following it only as far
 * as the last page load.
 *
 * Renders nothing. Mounted from the ROOT layout rather than from the header,
 * because `/login`, `/privacy` and `/terms` live outside the `(app)` group and
 * have no header — a listener in the header would leave those three pages stuck
 * on whatever the OS said when they loaded.
 *
 * ## Why this reads matchMedia directly instead of `useMediaQuery`
 *
 * ⚠️ Deliberate, and the reason is the bug this whole issue is about.
 * `useMediaQuery` is SSR-safe by returning a `serverSnapshot` (default `false`)
 * for the server and hydration passes, so an effect keyed on its value runs once
 * with "the OS prefers light" before the real value arrives. On a dark-OS device
 * that effect would strip the `dark` class the `<head>` script had already
 * written and put it back on the next commit — a one-frame light flash on every
 * single load. That hook is right for choosing a collapsed/expanded default
 * (#72), where a first-paint guess is free; it is wrong for anything that
 * overwrites what the pre-hydration script decided. Reading `mq.matches` inside
 * the effect has no such pass, so there is nothing to correct.
 */
export function ThemeSync(): null {
  useEffect(() => {
    if (typeof matchMedia !== "function") return;
    const mq = matchMedia(PREFERS_DARK_QUERY);

    const apply = () => {
      const root = document.documentElement;
      // An explicit light/dark choice is an override and outranks the OS. Read
      // it from the element every time rather than closing over it, so a change
      // made in Settings takes effect without re-subscribing.
      if (
        normaliseThemePreference(root.getAttribute(THEME_ATTRIBUTE)) !==
        "system"
      )
        return;
      root.classList.toggle("dark", mq.matches);
    };

    // Idempotent: on mount this re-asserts exactly what the bootstrap resolved,
    // so it is a no-op rather than a correction. It matters when the OS changed
    // between a soft navigation and this effect, and it means the component has
    // one code path instead of a mount case and a change case.
    apply();
    mq.addEventListener("change", apply);
    return () => mq.removeEventListener("change", apply);
  }, []);

  return null;
}
