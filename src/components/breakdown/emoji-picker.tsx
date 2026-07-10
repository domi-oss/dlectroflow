"use client";

import { useEffect, useRef, useState } from "react";

// Curated, dependency-free palette — task/food/energy themed to match the app,
// plus common general-purpose glyphs. Enough to pick something fitting without
// pulling in a heavyweight emoji-picker library.
const EMOJIS = [
  "🎯", "✅", "📝", "📌", "🔍", "🧹", "🧰", "📞", "✉️", "📅",
  "💡", "🚀", "🌱", "🔥", "⭐", "🎉", "🧠", "💪", "⏱️", "🔔",
  "🍽️", "🍿", "🥫", "🍞", "🥖", "☕", "🧽", "🛒", "💰", "📦",
  "🏠", "🚗", "✈️", "🎨", "🎵", "📚", "💻", "🩺", "🐾", "•",
] as const;

/**
 * Tiny popover emoji picker used by the breakdown editor's step rows. Clicking
 * the swatch opens a grid; picking one calls `onSelect` and closes. Closes on
 * outside click or Escape.
 */
export function EmojiPicker({
  value,
  onSelect,
}: {
  value: string;
  onSelect: (emoji: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        aria-label="Choose emoji"
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="hover:bg-accent flex h-9 w-9 items-center justify-center rounded-md border text-center"
      >
        {value || "🙂"}
      </button>
      {open && (
        <div
          role="listbox"
          aria-label="Emoji"
          className="bg-background absolute z-20 mt-1 grid w-56 grid-cols-8 gap-1 rounded-md border p-2 shadow-md"
        >
          {EMOJIS.map((e) => (
            <button
              key={e}
              type="button"
              role="option"
              aria-selected={e === value}
              aria-label={`emoji ${e}`}
              onClick={() => {
                onSelect(e);
                setOpen(false);
              }}
              className="hover:bg-accent flex h-6 w-6 items-center justify-center rounded"
            >
              {e}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
