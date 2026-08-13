import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/**
 * Minimum interactive hit area — 44×44 CSS px (Tailwind `11` = 2.75rem), the
 * WCAG 2.5.5 target size. Applied to icon-only and small pill controls so they
 * meet the touch-target minimum while keeping their visual padding; the flex
 * centering keeps the glyph/label centred inside the expanded box.
 */
export const touchTarget =
  "inline-flex items-center justify-center min-h-11 min-w-11";

/**
 * The bordered-control surface — hover, radius, border, transition and the
 * focus-visible ring.
 *
 * Hoisted out of `theme-toggle.tsx` by #252, where it was a local `shared`
 * const. The header's right cluster now holds up to three of these side by side
 * (focus timer, shopping list, dark mode) and they have to read as ONE set of
 * controls; two of them drifting apart is the same failure `account-menu.tsx`
 * and `app-menu.tsx` hoist their `ENTRY` strings to avoid, and #117 exists
 * because those two menus had drifted.
 *
 * `outline-none` and the ring travel together in this one string on purpose.
 * Removing the UA outline is what makes an indicator the author's problem
 * (WCAG 2.4.7 Focus Visible, AA — axe implements no rule for it), and
 * `a11y-class-hygiene`'s Rule D can only see that the replacement exists if it is
 * in the same class scope — splitting them would silently satisfy the guard while
 * painting nothing.
 *
 * Compose with {@link touchTarget} for icon-only controls: a bare 20px glyph is
 * short of the app's own 44x44 floor. That floor is **2.5.5 Target Size
 * (Enhanced), AAA** — a house convention, not the conformance bar. The AA one is
 * **2.5.8 Target Size (Minimum)** at 24x24, which a 20px glyph also misses, so
 * this composition is doing both jobs at once. Both citations here were wrong
 * before #258, in the same direction: they made a voluntary bar read as an
 * obligation.
 */
export const controlSurface =
  "hover:bg-accent hover:border-primary/40 rounded-md border outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background";
