/**
 * App-wide UI typeface (#40, Appearance a11y). Mirrors the completion-style
 * pattern: the user's typeface preference is applied ONCE at the app shell as a
 * root `data-font` attribute (see (app)/layout.tsx); globals.css keys
 * --font-sans / --font-heading off that attribute, so the whole app re-renders
 * in the chosen face from a single place. The four faces are wired via next/font
 * in the root layout (Figtree/Atkinson via google, OpenDyslexic self-hosted);
 * "system" resolves to the native font stack (no download).
 */

import { Typeface } from "@/lib/constants";

const KNOWN = new Set<string>(Object.values(Typeface));

/**
 * Root data attribute for the app-shell wrapper. Any unknown/legacy value
 * degrades to Figtree (the app default), matching the Settings_typeface_check
 * CHECK constraint + the server-action fallback so the shell is always valid.
 */
export function typefaceRootAttrs(settings: { typeface: string }): {
  "data-font": Typeface;
} {
  const t = KNOWN.has(settings.typeface)
    ? (settings.typeface as Typeface)
    : Typeface.Figtree;
  return { "data-font": t };
}
