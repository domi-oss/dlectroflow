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
    } catch {}
    // Let a parent (e.g. the Appearance section) reflect the persisted change in
    // its shared save indicator, so the theme control gives the same feedback as
    // the other Appearance settings.
    onPersist?.();
  };

  return (
    <button
      type="button"
      onClick={toggle}
      className="hover:bg-accent rounded-md border px-3 py-1.5 text-sm"
      aria-pressed={dark}
    >
      {dark ? "☀️ Light mode" : "🌙 Dark mode"}
    </button>
  );
}
