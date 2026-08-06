"use client";

import { useEffect, useId, useRef, useState } from "react";
import {
  Pause,
  Play,
  Shuffle,
  SkipBack,
  SkipForward,
  Volume2,
} from "lucide-react";
import { FocusPlaylistPanel } from "@/components/focus/focus-playlist-panel";
import { t, type Voice } from "@/lib/strings";
import { cn } from "@/lib/utils";
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
 * #65 — the transport button is the ONE control that can be coupled to the
 * focus session (see onPauseTogether). Everything else here stays audio-only.
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
  categories,
  onCategoriesChange,
  onPauseTogether,
  pauseTogetherPending = false,
}: {
  controls: FocusSoundControls;
  voice: Voice;
  /**
   * #181 — the live playlist selection (`Settings.focusSoundCategories`) and its
   * setter, forwarded to the panel below the progress bar.
   *
   * Required rather than optional, unlike `onPauseTogether`: an absent
   * persistence callback would be a tick-list that silently does not stick, and
   * a default no-op would hide that from the one place it could be noticed —
   * the type.
   */
  categories: readonly string[];
  onCategoriesChange: (next: string[]) => void;
  /**
   * #65 — supplied only when the workspace opted into the music↔timer pause
   * coupling. The transport button then pauses/resumes the whole SESSION (the
   * timer pauses the audio itself, through the #43 one-directional coupling)
   * instead of the audio alone, and says so in its accessible name. Absent =
   * the default: the transport touches audio only, and the timer runs on.
   *
   * Only this one button is ever coupled. Skipping a track, shuffling and
   * changing the volume stay audio-only in both modes — none of them is the
   * user saying "stop my focus session".
   */
  onPauseTogether?: () => void;
  /** True while that session round-trip is in flight, so the coupled button
   * can't be double-fired (mirrors the timer's own Pause/Resume being
   * disabled). Meaningless — and ignored — without onPauseTogether. */
  pauseTogetherPending?: boolean;
}) {
  const {
    track,
    playing,
    volume,
    shuffle,
    toggle,
    next,
    prev,
    toggleShuffle,
    setVolume,
    getTime,
  } = controls;

  // Live playback position (polled while playing — display only, no seek).
  //
  // #23 — kept as a poll-into-state on purpose. The rule's prescribed fix,
  // useSyncExternalStore, is unsafe for a *continuously advancing* value: React
  // re-reads getSnapshot after commit to detect tearing, an audio element's
  // currentTime differs on every read, so it would force a re-render on every
  // commit — a render storm for as long as the track plays. The read below is
  // the initial snapshot for a mount / track change / play-pause flip (the
  // interval only covers the steady state), and dropping it would leave the
  // previous track's elapsed time on screen for up to 250ms after a skip.
  const [pos, setPos] = useState({ currentTime: 0, duration: 0 });
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- initial read of an external, continuously-changing system (see above); useSyncExternalStore would loop here.
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
  // #65 — one press, one meaning: either the audio (default) or the whole
  // session (coupled). Resolved once so the handler, the label and the disabled
  // state can never describe different buttons.
  const coupled = Boolean(onPauseTogether);
  const onTransport = onPauseTogether ?? toggle;
  const transportLabel = playing
    ? t(coupled ? "focus.sound.pauseTogether" : "focus.sound.pause", voice)
    : t(coupled ? "focus.sound.resumeTogether" : "focus.sound.play", voice);
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
          <SkipBack aria-hidden="true" className="h-5 w-5" />
        </button>
        <button
          type="button"
          onClick={onTransport}
          disabled={coupled && pauseTogetherPending}
          className={cn(btn, "disabled:opacity-50")}
          aria-pressed={playing}
          aria-label={transportLabel}
        >
          {playing ? (
            <Pause aria-hidden="true" className="h-5 w-5" />
          ) : (
            <Play aria-hidden="true" className="h-5 w-5" />
          )}
        </button>
        <button
          type="button"
          onClick={next}
          className={btn}
          aria-label={t("focus.sound.next", voice)}
        >
          <SkipForward aria-hidden="true" className="h-5 w-5" />
        </button>
        <div className="min-w-0 flex-1 leading-tight">
          <p className="text-muted-foreground text-[11px] uppercase tracking-wide">
            {/* #68 — shuffle state as text, so it isn't carried by the toggle's
                tint alone (WCAG 1.4.1). */}
            {t("focus.sound.nowPlaying", voice)}
            {shuffle ? ` · ${t("focus.sound.shuffled", voice)}` : ""}
          </p>
          <p className="truncate text-sm font-medium">{track.title}</p>
          <p className="text-muted-foreground truncate text-xs">
            {track.categoryLabel}
          </p>
        </div>
        {/* #68 — shuffle: a state toggle, not a transport action, so it sits with
            volume on the right rather than in the prev/play/next group. Same
            label in both states; aria-pressed + the "Shuffled" text above carry
            the state. */}
        <button
          type="button"
          onClick={toggleShuffle}
          className={cn(
            btn,
            "shrink-0",
            // Same token-paired active tint as the timer's duration chips
            // (designed to clear AA in both themes).
            shuffle && "border-primary bg-accent text-accent-foreground",
          )}
          aria-pressed={shuffle}
          aria-label={t("focus.sound.shuffle", voice)}
        >
          <Shuffle aria-hidden="true" className="h-5 w-5" />
        </button>
        {/* Volume behind a speaker button that pops out a slider. */}
        <div className="relative shrink-0" ref={volWrapRef}>
          <button
            type="button"
            ref={volBtnRef}
            onClick={() => setVolumeOpen((o) => !o)}
            className={btn}
            aria-label={t("focus.sound.volume", voice)}
            // "dialog", not the "true"/"menu" default: the popover is a
            // focus-capturing slider group (Esc restores focus), not a menu, so
            // AT shouldn't promise arrow-key menu navigation (#43, matches the
            // row-actions schedule popover).
            aria-haspopup="dialog"
            aria-expanded={volumeOpen}
            aria-controls={popoverId}
          >
            <Volume2 aria-hidden="true" className="h-5 w-5" />
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
      {/* #181 — "what am I listening to", inline and below the progress bar so
          it never covers the timer's number. Collapsed by default; see
          FocusPlaylistPanel for why it is not a popover or a drawer. */}
      <FocusPlaylistPanel
        controls={controls}
        voice={voice}
        categories={categories}
        onCategoriesChange={onCategoriesChange}
      />
    </section>
  );
}
