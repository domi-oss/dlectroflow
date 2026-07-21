/**
 * App-wide completion styling (MR ③, Design D). The two Appearance settings are
 * applied ONCE at the app shell as root data attributes (see (app)/layout.tsx);
 * globals.css keys the --tick-color / --complete-decoration custom properties
 * off those attributes, and every completion render site simply uses the two
 * shared class names below. Implement once — never re-hardcode `line-through`
 * or a tick colour in a component.
 */

/** Root data attributes for the app-shell wrapper. `black` maps (via CSS) to
 * --foreground so it is WCAG-AA in both themes; `green` resolves to a 700-weight
 * in light and a 400-weight in dark. Any unknown colour degrades to green. */
export function completionRootAttrs(settings: {
  completeStrikethrough: boolean;
  completeTickColor: string;
}): { "data-complete-strike": "on" | "off"; "data-tick": "green" | "black" } {
  return {
    "data-complete-strike": settings.completeStrikethrough ? "on" : "off",
    "data-tick": settings.completeTickColor === "black" ? "black" : "green",
  };
}

/** The ✓ done-glyph colour — resolves from --tick-color. Always pair the glyph
 * with a text accessible name so status is never colour-only. */
export const COMPLETE_TICK = "text-[color:var(--tick-color)]";

/** Finished-text decoration — resolves from --complete-decoration
 * (line-through | none). Replaces hard-coded `line-through` at every site. */
export const COMPLETE_TEXT = "[text-decoration-line:var(--complete-decoration)]";
