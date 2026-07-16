"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";

const DURATION_PRESETS = [15, 30, 60] as const;

const MAX_CUSTOM_MINUTES = 480;

export type ScheduleControlProps = {
  state: "ready_steps" | "needs_duration" | "connect" | "reconnect";
  onScheduleSteps?: () => void;
  onScheduleSingle?: (minutes: number) => void;
  /** True while a schedule call for this row is in flight — disables the 📅
   * button/popover Go so a slow request can't be double-submitted. */
  pending?: boolean;
};

/**
 * The 📅 control. `ready_steps` schedules immediately on click; `needs_duration`
 * opens an inline popover (15/30/60 presets + a custom number input) and fires
 * `onScheduleSingle` once a duration is chosen; `connect`/`reconnect` render an
 * OAuth link instead of a button (nothing to click-handle client-side).
 */
function ScheduleControl({ state, onScheduleSteps, onScheduleSingle, pending }: ScheduleControlProps) {
  const [open, setOpen] = useState(false);
  const [custom, setCustom] = useState("");
  const rootRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    const onPointerDown = (e: Event) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("pointerdown", onPointerDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("pointerdown", onPointerDown);
    };
  }, [open]);

  if (state === "connect" || state === "reconnect") {
    return (
      <a href="/api/google/oauth/start" className="rounded-md px-2.5 py-1 font-medium">
        {state === "reconnect" ? "Reconnect Google →" : "Connect Google →"}
      </a>
    );
  }

  const fireCustom = () => {
    const minutes = Number(custom);
    if (!Number.isFinite(minutes) || minutes <= 0 || minutes > MAX_CUSTOM_MINUTES) return;
    setOpen(false);
    setCustom("");
    onScheduleSingle?.(minutes);
  };

  return (
    <span ref={rootRef} className="relative">
      <button
        type="button"
        aria-label="Schedule"
        title="Schedule"
        aria-haspopup={state === "needs_duration" ? "menu" : undefined}
        aria-expanded={state === "needs_duration" ? open : undefined}
        disabled={pending}
        onClick={() => {
          if (state === "ready_steps") {
            onScheduleSteps?.();
          } else {
            setOpen((o) => !o);
          }
        }}
        className="rounded-md px-2.5 py-1 font-medium disabled:opacity-50"
      >
        📅
      </button>
      {state === "needs_duration" && open && (
        <span className="bg-background absolute right-0 z-10 mt-1 flex min-w-48 flex-col gap-2 rounded-md border p-2 text-xs shadow-md">
          <span className="flex gap-1">
            {DURATION_PRESETS.map((minutes) => (
              <button
                key={minutes}
                type="button"
                disabled={pending}
                className="rounded-md px-2.5 py-1 font-medium disabled:opacity-50"
                onClick={() => {
                  setOpen(false);
                  onScheduleSingle?.(minutes);
                }}
              >
                {minutes} min
              </button>
            ))}
          </span>
          <span className="flex items-center gap-1">
            <input
              type="number"
              min={1}
              step={1}
              value={custom}
              onChange={(e) => setCustom(e.target.value)}
              className="w-16 rounded-md border px-2 py-1"
              placeholder="min"
            />
            <button
              type="button"
              disabled={pending}
              className="rounded-md px-2.5 py-1 font-medium disabled:opacity-50"
              onClick={fireCustom}
            >
              Go
            </button>
          </span>
        </span>
      )}
    </span>
  );
}

/**
 * The action line shared by every task row: an optional primary action slot,
 * the 📅 schedule control (omitted entirely when `schedule` is null — guest
 * rows have nothing to schedule into), a ⋯ overflow menu, and optional quiet
 * meta text pinned to the right.
 */
export function RowActions({
  primary,
  schedule,
  overflow,
  meta,
}: {
  primary?: ReactNode;
  schedule?: ScheduleControlProps | null;
  overflow: ReactNode[];
  meta?: string;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (!menuOpen) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMenuOpen(false);
    };
    const onPointerDown = (e: Event) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuOpen(false);
    };
    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("pointerdown", onPointerDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("pointerdown", onPointerDown);
    };
  }, [menuOpen]);

  return (
    <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
      {primary}
      {schedule && <ScheduleControl {...schedule} />}
      <span ref={menuRef} className="relative">
        <button
          type="button"
          aria-label="More actions"
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          onClick={() => setMenuOpen((o) => !o)}
          className="rounded-md px-2.5 py-1 font-medium"
        >
          ⋯
        </button>
        {menuOpen && (
          <span
            role="menu"
            className="bg-background absolute right-0 z-10 mt-1 flex min-w-40 flex-col gap-1 rounded-md border p-1 shadow-md"
          >
            {overflow}
          </span>
        )}
      </span>
      {meta && <span className="text-muted-foreground ml-auto">{meta}</span>}
    </div>
  );
}
