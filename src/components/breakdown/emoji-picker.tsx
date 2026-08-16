"use client";

import { useEffect, useRef, useState } from "react";

// Curated, dependency-free palette — task/food/energy themed to match the app,
// plus common general-purpose glyphs. Enough to pick something fitting without
// pulling in a heavyweight emoji-picker library.
const EMOJIS = [
  "🎯",
  "✅",
  "📝",
  "📌",
  "🔍",
  "🧹",
  "🧰",
  "📞",
  "✉️",
  "📅",
  "💡",
  "🚀",
  "🌱",
  "🔥",
  "⭐",
  "🎉",
  "🧠",
  "💪",
  "⏱️",
  "🔔",
  "🍽️",
  "🍿",
  "🥫",
  "🍞",
  "🥖",
  "☕",
  "🧽",
  "🛒",
  "💰",
  "📦",
  "🏠",
  "🚗",
  "✈️",
  "🎨",
  "🎵",
  "📚",
  "💻",
  "🩺",
  "🐾",
  "•",
] as const;

/**
 * Tiny popover emoji picker used by the breakdown editor's step rows. Clicking
 * the swatch opens a grid; picking one calls `onSelect` and closes. Closes on
 * outside click or Escape.
 */
export function EmojiPicker({
  value,
  onSelect,
  disabled = false,
}: {
  value: string;
  onSelect: (emoji: string) => void;
  /**
   * #238 — hold the picker while the caller's list is being replaced.
   *
   * `disabled` on the trigger rather than `aria-disabled`, matching the sibling
   * row controls the breakdown editor holds on the same event: this one has
   * nothing of its own to say, and the shared reason is reachable from the ✕
   * beside it, which stays focusable precisely so it can carry it.
   *
   * The grid is CLOSED as well as the trigger held, and the distinction is the
   * whole of Duo's finding on `!365` — the first cut merely stopped drawing it.
   * The popover really can be open when the hold arrives: this component closes
   * on an outside `mousedown` or on Escape, and the keyboard route into the
   * caller's stream fires neither, so a picker opened with the keyboard is
   * still open when the row freezes. Every mouse route closes it by accident,
   * which is why the reachable case is the keyboard one.
   */
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  /**
   * #238 (Duo review of `!365`) — becoming disabled CLOSES the picker.
   *
   * The first cut withheld the grid with `{open && !disabled && …}`, which is a
   * rendering condition: it draws nothing and leaves `open` exactly as it was.
   * Two things followed, and the second is worse than the defect #238 exists to
   * fix — the grid sprang back the instant the hold lifted, with no user action
   * and at the precise moment the rest of the row was handed back (WCAG 3.2.2);
   * and `aria-expanded` reported `true` throughout, which is a screen reader
   * being told a listbox exists that is not in the DOM.
   *
   * Adjusted DURING RENDER rather than in an effect, which is React's own
   * pattern for reacting to a changed prop and what `react-hooks/set-state-in-
   * effect` requires. It is also the stronger of the two: React re-runs the
   * component immediately and discards this pass's output, so nothing
   * inconsistent is ever committed. An effect runs after the commit, so it
   * would leave that `aria-expanded` lie standing for a render — briefly, but
   * a screen reader reads the commit, not the intention.
   *
   * Keyed on the prop's transition, not on its value: resetting whenever
   * `disabled` is merely true would slam the picker shut on any re-render
   * during a hold, which is the same class of bug pointing the other way.
   */
  const [wasDisabled, setWasDisabled] = useState(disabled);
  if (disabled !== wasDisabled) {
    setWasDisabled(disabled);
    if (disabled) setOpen(false);
  }

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node))
        setOpen(false);
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
        disabled={disabled}
        onClick={() => setOpen((o) => !o)}
        className="hover:bg-accent flex h-9 w-9 items-center justify-center rounded-md border text-center disabled:opacity-50"
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
