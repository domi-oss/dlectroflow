"use client";

import { useSyncExternalStore } from "react";
import { Moon, Sun } from "lucide-react";

import { cn, controlSurface, touchTarget } from "@/lib/utils";

// #23 — the `dark` class on <html> is the theme's single source of truth (the
// pre-hydration inline script sets it, and every toggle writes it), so read it
// as an external store instead of copying it into state from an effect
// (react-hooks/set-state-in-effect). Same pattern as usePrefersReducedMotion.
// Bonus: two mounted toggles (header + Settings > Appearance) can no longer
// drift apart, because both render straight from the class.
function subscribe(onChange: () => void): () => void {
  if (typeof MutationObserver === "undefined") return () => {};
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["class"],
  });
  return () => observer.disconnect();
}

function getSnapshot(): boolean {
  return document.documentElement.classList.contains("dark");
}

/** Server / pre-hydration snapshot — light, matching the SSR'd markup. */
function getServerSnapshot(): boolean {
  return false;
}

/**
 * How the control presents itself (#103).
 *
 * - `text` — icon + words ("Dark mode" / "Light mode"). The default, so a call
 *   site can never silently lose its label. Used in Settings > Appearance,
 *   where a bare icon in a settings row would be worse than the label it
 *   replaced.
 * - `icon` — glyph only, for the header menu bar, where the words are dead
 *   weight and crowd the bar at 390px.
 */
type ThemeToggleVariant = "text" | "icon";

export function ThemeToggle({
  onPersist,
  variant = "text",
}: {
  onPersist?: () => void;
  variant?: ThemeToggleVariant;
}) {
  const dark = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

  const toggle = () => {
    const next = !dark;
    // Writing the class is what flips this control: the observer above sees the
    // mutation and re-renders every mounted toggle.
    document.documentElement.classList.toggle("dark", next);
    try {
      localStorage.setItem("df-theme", next ? "dark" : "light");
      // Only flag "saved" on a successful persist — if storage throws (e.g.
      // private mode) the preference didn't persist, so don't show "Saved ✓".
      // The parent (Appearance section) uses this to drive its shared save
      // indicator, so the theme control matches the other Appearance settings.
      onPersist?.();
    } catch {}
  };

  // #103 — lucide, not 🌙/☀️: the rest of the app moved to lucide in !141, and
  // emoji render differently on every platform (the VS16 variation selector
  // also makes their advance width unpredictable, which is part of why the
  // header button was so wide). Decorative in both variants — the accessible
  // name comes from the visible words or the aria-label, never the glyph.
  const Icon = dark ? Sun : Moon;

  // #252 — moved verbatim to `controlSurface` in @/lib/utils, because the header
  // now renders the shopping and focus quick-access links beside this button and
  // all three have to read as one set. A local copy per control is how the two
  // popup menus drifted apart in #117.
  const shared = controlSurface;

  if (variant === "icon") {
    // Dropping the visible words drops the button's accessible name with them,
    // so it is spelled out here. It names the ACTION the click performs ("switch
    // to …"), not the current state — and `title` gives a pointer user the same
    // string on hover. aria-pressed still carries the state for AT.
    const label = dark ? "Switch to light mode" : "Switch to dark mode";
    return (
      <button
        type="button"
        onClick={toggle}
        // A bare 20px glyph is far short of a hit target, so square it up to
        // the shared 44px minimum (WCAG 2.5.5) — the same size as the header's
        // menu trigger next to it, so the two line up.
        className={cn(shared, touchTarget)}
        aria-pressed={dark}
        aria-label={label}
        title={label}
      >
        <Icon aria-hidden="true" className="h-5 w-5" />
      </button>
    );
  }

  return (
    <button
      type="button"
      onClick={toggle}
      className={cn(
        shared,
        "inline-flex items-center gap-1.5 px-3 py-1.5 text-sm",
      )}
      aria-pressed={dark}
    >
      {/* No aria-label on this variant: it would override the visible text and
          break WCAG 2.5.3 (Label in Name) for voice-control users. */}
      <Icon aria-hidden="true" className="h-4 w-4" />
      {dark ? "Light mode" : "Dark mode"}
    </button>
  );
}
