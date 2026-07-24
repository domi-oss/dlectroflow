"use client";

import { useEffect, useState } from "react";

export function ThemeToggle({ onPersist }: { onPersist?: () => void }) {
  const [dark, setDark] = useState(false);

  useEffect(() => {
    setDark(document.documentElement.classList.contains("dark"));
  }, []);

  const toggle = () => {
    const next = !dark;
    setDark(next);
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
