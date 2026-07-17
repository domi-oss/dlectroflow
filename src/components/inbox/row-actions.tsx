"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";

const DURATION_PRESETS = [15, 30, 60] as const;

const MAX_CUSTOM_MINUTES = 480;

export type ScheduleControlProps = {
  state: "ready_steps" | "needs_duration" | "connect" | "reconnect" | "guest";
  onScheduleSteps?: () => void;
  onScheduleSingle?: (minutes: number) => void;
  /** True while a schedule call for this row is in flight — disables the 📅
   * button/popover Go so a slow request can't be double-submitted. */
  pending?: boolean;
  /** v6: "icon" (default) = the 📅 end-cluster button with an absolute popover.
   * "menu" = a full-width text entry for the ▾ dropdown's full mirror — the
   * duration presets expand inline (in normal flow) instead of in an absolute
   * popover, so it nests cleanly inside the dropdown column. */
  variant?: "icon" | "menu";
  /** Menu-variant trigger text (voice-resolved by the caller). Defaults to "Schedule". */
  label?: string;
};

/**
 * The 📅 control. `ready_steps` schedules immediately on click; `needs_duration`
 * opens an inline popover (15/30/60 presets + a custom number input) and fires
 * `onScheduleSingle` once a valid duration is chosen; out-of-range custom values
 * (0, negative, non-numeric, or >480) visibly disable Go and show a hint instead
 * of silently doing nothing. `connect`/`reconnect` render an OAuth link instead
 * of a button (nothing to click-handle client-side).
 */
export function ScheduleControl({
  state,
  onScheduleSteps,
  onScheduleSingle,
  pending,
  variant = "icon",
  label = "Schedule",
}: ScheduleControlProps) {
  const [open, setOpen] = useState(false);
  const [custom, setCustom] = useState("");
  const rootRef = useRef<HTMLSpanElement>(null);
  const isMenu = variant === "menu";

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

  // Clear the custom-duration input whenever the popover closes (Escape /
  // outside-click / preset pick) so a stale value can't reappear on reopen
  // (Duo review).
  useEffect(() => {
    if (!open) setCustom("");
  }, [open]);

  if (state === "connect" || state === "reconnect") {
    return (
      <a
        href="/api/google/oauth/start"
        className={
          isMenu
            ? "hover:bg-accent w-full rounded-md px-2.5 py-1 text-left font-medium"
            : "rounded-md px-2.5 py-1 font-medium"
        }
      >
        {state === "reconnect" ? "Reconnect Google →" : "Connect Google →"}
      </a>
    );
  }

  if (state === "guest") {
    // Guests see the SAME affordance, visibly disabled — scheduling is owner-only
    // (Google Tasks). Keeps the row layout identical to the owner view, with a
    // clear "not available in guest mode" cue (grayed-out, cf. #11).
    return (
      <button
        type="button"
        disabled
        aria-label="Schedule (not available in guest mode)"
        title="Scheduling isn't available in guest mode — sign in to schedule"
        className={
          isMenu
            ? "w-full cursor-not-allowed rounded-md px-2.5 py-1 text-left font-medium opacity-50"
            : "cursor-not-allowed rounded-md px-2.5 py-1 font-medium opacity-50"
        }
      >
        {isMenu ? label : "📅"}
      </button>
    );
  }

  const customMinutes = Number(custom);
  const customOutOfRange =
    custom !== "" &&
    (!Number.isFinite(customMinutes) || customMinutes <= 0 || customMinutes > MAX_CUSTOM_MINUTES);

  const fireCustom = () => {
    if (custom === "" || customOutOfRange) return;
    setOpen(false);
    setCustom("");
    onScheduleSingle?.(customMinutes);
  };

  return (
    <span ref={rootRef} className={isMenu ? "flex flex-col" : "relative"}>
      <button
        type="button"
        aria-label={isMenu ? undefined : "Schedule"}
        title={isMenu ? undefined : "Schedule"}
        aria-haspopup={state === "needs_duration" ? "true" : undefined}
        aria-expanded={state === "needs_duration" ? open : undefined}
        disabled={pending}
        onClick={() => {
          if (state === "ready_steps") {
            onScheduleSteps?.();
          } else {
            setOpen((o) => !o);
          }
        }}
        className={
          isMenu
            ? "hover:bg-accent w-full rounded-md px-2.5 py-1 text-left font-medium disabled:opacity-50"
            : "rounded-md px-2.5 py-1 font-medium disabled:opacity-50"
        }
      >
        {isMenu ? label : "📅"}
      </button>
      {state === "needs_duration" && open && (
        <span
          className={
            isMenu
              ? "mt-1 flex flex-col gap-2 px-2.5 pb-1 text-xs"
              : "bg-background absolute right-0 z-10 mt-1 flex min-w-48 flex-col gap-2 rounded-md border p-2 text-xs shadow-md"
          }
        >
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
              max={MAX_CUSTOM_MINUTES}
              step={1}
              value={custom}
              onChange={(e) => setCustom(e.target.value)}
              className="w-16 rounded-md border px-2 py-1"
              placeholder="min"
            />
            <button
              type="button"
              disabled={pending || custom === "" || customOutOfRange}
              className="rounded-md px-2.5 py-1 font-medium disabled:opacity-50"
              onClick={fireCustom}
            >
              Go
            </button>
          </span>
          {customOutOfRange && (
            <span className="text-destructive">Enter 1–{MAX_CUSTOM_MINUTES} minutes</span>
          )}
        </span>
      )}
    </span>
  );
}

/**
 * The action line shared by every task row (v5): visible `inline` actions in
 * order, a flex spacer, then the end cluster — 📅 (omitted when `schedule` is
 * null, e.g. guest rows), `del` (omitted when not provided), and the ▾ trigger
 * which opens a dismissable (Escape / outside-click) list of ALL of the row's
 * options — `menu`, rendered verbatim, caller-ordered (Move to… pinned first
 * by the caller). This is a plain dismissable popover, not an ARIA menu — no
 * `role="menu"` anywhere here, since `menu` entries are ordinary buttons/links,
 * not menuitems with roving-focus semantics.
 */
export function RowActions({
  inline,
  move,
  schedule,
  del,
  menu,
}: {
  inline: ReactNode[];
  /** v6: 📥 Move-to icon, first in the end cluster (omitted when not provided). */
  move?: ReactNode;
  schedule?: ScheduleControlProps | null;
  del?: ReactNode;
  menu: ReactNode[];
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
      {inline}
      <span className="flex-1" />
      {move}
      {schedule && <ScheduleControl {...schedule} />}
      {/* Visible gap so 📅 Schedule and 🗑 Delete don't sit flush — avoids misclicks. */}
      {del && <span aria-hidden="true" className="w-3" />}
      {del}
      <span ref={menuRef} className="relative">
        <button
          type="button"
          aria-label="All options"
          aria-haspopup="true"
          aria-expanded={menuOpen}
          onClick={() => setMenuOpen((o) => !o)}
          className="rounded-md px-2.5 py-1 font-medium"
        >
          🔽
        </button>
        {menuOpen && (
          <span className="bg-background absolute right-0 z-10 mt-1 flex min-w-40 flex-col gap-1 rounded-md border p-1 shadow-md">
            {menu}
          </span>
        )}
      </span>
    </div>
  );
}
