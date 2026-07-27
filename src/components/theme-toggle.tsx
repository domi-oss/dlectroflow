"use client";

import { useSyncExternalStore } from "react";

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

export function ThemeToggle({ onPersist }: { onPersist?: () => void }) {
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

  return (
    <button
      type="button"
      onClick={toggle}
      className="hover:bg-accent hover:border-primary/40 rounded-md border px-3 py-1.5 text-sm outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
      aria-pressed={dark}
    >
      {dark ? "☀️ Light mode" : "🌙 Dark mode"}
    </button>
  );
}
