"use client";

import { t, type Voice } from "@/lib/strings";
import type { FocusSoundControls } from "@/lib/use-focus-sound";

/**
 * #43 — the embedded lo-fi mini-player shown inside the /focus timer during an
 * active session. Presentation + control-forwarding only: all audio state lives
 * in the shared useFocusSound controls (owned by FocusTimer), so this component
 * stays trivially testable. Fully keyboard-usable: every control is a real
 * button/range with a text aria-label, and the glyphs are decorative
 * (aria-hidden). The current track is shown as text (status-not-colour-only).
 */
export function FocusSoundPlayer({
  controls,
  voice,
}: {
  controls: FocusSoundControls;
  voice: Voice;
}) {
  const { track, playing, volume, toggle, next, prev, setVolume } = controls;

  // No curated library / no track resolved → render nothing.
  if (!controls.hasTracks || !track) return null;

  const btn =
    "hover:bg-accent inline-flex min-h-[44px] min-w-[44px] items-center justify-center rounded-md border";

  return (
    <section
      aria-label={t("focus.sound.region", voice)}
      className="bg-card/50 space-y-2 rounded-lg border p-3"
    >
      <div className="flex items-center gap-2">
        <button type="button" onClick={prev} className={btn} aria-label={t("focus.sound.prev", voice)}>
          <span aria-hidden="true">⏮</span>
        </button>
        <button
          type="button"
          onClick={toggle}
          className={btn}
          aria-pressed={playing}
          aria-label={
            playing ? t("focus.sound.pause", voice) : t("focus.sound.play", voice)
          }
        >
          <span aria-hidden="true">{playing ? "⏸" : "▶"}</span>
        </button>
        <button type="button" onClick={next} className={btn} aria-label={t("focus.sound.next", voice)}>
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
      </div>
      <label className="flex items-center gap-2 text-xs">
        <span className="text-muted-foreground shrink-0">
          {t("focus.sound.volume", voice)}
        </span>
        <input
          type="range"
          min={0}
          max={1}
          step={0.05}
          value={volume}
          onChange={(e) => setVolume(Number(e.target.value))}
          aria-label={t("focus.sound.volume", voice)}
          className="w-full"
        />
      </label>
    </section>
  );
}
