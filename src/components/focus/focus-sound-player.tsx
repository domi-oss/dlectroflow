"use client";

import { useEffect, useId, useRef, useState } from "react";
import { t, type Voice } from "@/lib/strings";
import type { FocusSoundControls } from "@/lib/use-focus-sound";

/**
 * #43 — the embedded lo-fi mini-player shown inside the /focus timer during an
 * active session. Presentation + control-forwarding only: transport + volume
 * live in the shared useFocusSound controls (owned by FocusTimer); only the
 * live progress position is kept local (polled from controls.getTime()) so the
 * whole timer doesn't re-render on every tick. Fully keyboard-usable: every
 * control is a real button/range with a text aria-label, glyphs are decorative
 * (aria-hidden), and the current track + times are shown as text (not
 * colour-only). Width is capped to roughly the timer button row above it.
 *
 * Layout note: exact pixel width/popover placement still wants the owner's
 * eyeball — this is the cleanest sensible version (see MR discussion).
 */
function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return "0:00";
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

export function FocusSoundPlayer({
  controls,
  voice,
}: {
  controls: FocusSoundControls;
  voice: Voice;
}) {
  const { track, playing, volume, toggle, next, prev, setVolume, getTime } =
    controls;

  // Live playback position (polled while playing — display only, no seek).
  const [pos, setPos] = useState({ currentTime: 0, duration: 0 });
  useEffect(() => {
    setPos(getTime());
    if (!playing) return;
    const id = setInterval(() => setPos(getTime()), 250);
    return () => clearInterval(id);
  }, [playing, getTime, track?.id]);

  // Volume popover — collapsed by default; Esc / click-away close it.
  const [volumeOpen, setVolumeOpen] = useState(false);
  const popoverId = useId();
  const volWrapRef = useRef<HTMLDivElement>(null);
  const volBtnRef = useRef<HTMLButtonElement>(null);
  const sliderRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!volumeOpen) return;
    sliderRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setVolumeOpen(false);
        volBtnRef.current?.focus();
      }
    };
    const onDown = (e: MouseEvent) => {
      if (
        volWrapRef.current &&
        !volWrapRef.current.contains(e.target as Node)
      ) {
        setVolumeOpen(false);
      }
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onDown);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onDown);
    };
  }, [volumeOpen]);

  // No curated library / no track resolved → render nothing.
  if (!controls.hasTracks || !track) return null;

  const btn =
    "hover:bg-accent inline-flex min-h-[44px] min-w-[44px] items-center justify-center rounded-md border";
  const pct =
    pos.duration > 0
      ? Math.min(100, Math.max(0, (pos.currentTime / pos.duration) * 100))
      : 0;

  return (
    <section
      aria-label={t("focus.sound.region", voice)}
      className="bg-card/50 mx-auto w-full max-w-md space-y-2 rounded-lg border p-3"
    >
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={prev}
          className={btn}
          aria-label={t("focus.sound.prev", voice)}
        >
          <span aria-hidden="true">⏮</span>
        </button>
        <button
          type="button"
          onClick={toggle}
          className={btn}
          aria-pressed={playing}
          aria-label={
            playing
              ? t("focus.sound.pause", voice)
              : t("focus.sound.play", voice)
          }
        >
          <span aria-hidden="true">{playing ? "⏸" : "▶"}</span>
        </button>
        <button
          type="button"
          onClick={next}
          className={btn}
          aria-label={t("focus.sound.next", voice)}
        >
          <span aria-hidden="true">⏭</span>
        </button>
        <div className="min-w-0 flex-1 leading-tight">
          <p className="text-muted-foreground text-[11px] uppercase tracking-wide">
            {t("focus.sound.nowPlaying", voice)}
          </p>
          <p className="truncate text-sm font-medium">{track.title}</p>
          <p className="text-muted-foreground truncate text-xs">
            {track.categoryLabel}
          </p>
        </div>
        {/* Volume behind a speaker button that pops out a slider. */}
        <div className="relative shrink-0" ref={volWrapRef}>
          <button
            type="button"
            ref={volBtnRef}
            onClick={() => setVolumeOpen((o) => !o)}
            className={btn}
            aria-label={t("focus.sound.volume", voice)}
            aria-haspopup="true"
            aria-expanded={volumeOpen}
            aria-controls={popoverId}
          >
            <span aria-hidden="true">🔊</span>
          </button>
          {volumeOpen && (
            <div
              id={popoverId}
              role="group"
              aria-label={t("focus.sound.volume", voice)}
              className="bg-popover absolute right-0 bottom-full z-10 mb-2 w-44 rounded-md border p-3 shadow-md"
            >
              <input
                ref={sliderRef}
                type="range"
                min={0}
                max={1}
                step={0.05}
                value={volume}
                onChange={(e) => setVolume(Number(e.target.value))}
                aria-label={t("focus.sound.volumeLevel", voice)}
                className="w-full"
              />
            </div>
          )}
        </div>
      </div>
      {/* Playback progress (display only). */}
      <div className="text-muted-foreground flex items-center gap-2 text-[11px] tabular-nums">
        <span aria-hidden="true">{formatTime(pos.currentTime)}</span>
        <div
          role="progressbar"
          aria-label={t("focus.sound.progress", voice)}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(pct)}
          className="bg-muted h-1.5 flex-1 overflow-hidden rounded-full"
        >
          <div className="bg-primary h-full" style={{ width: `${pct}%` }} />
        </div>
        <span aria-hidden="true">{formatTime(pos.duration)}</span>
      </div>
    </section>
  );
}
