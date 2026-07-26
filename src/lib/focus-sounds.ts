/**
 * Browser-API boundary for the focus timer's device effects (MR ②, extended by
 * #43). Everything here touches the DOM / navigator and degrades silently where
 * unsupported, so the timer component stays thin and its tests mock this module.
 * Audio must be constructed inside a user gesture (the Start tap, or a tap on a
 * player/preview control) so the browser unlocks later programmatic playback.
 */

import { FocusSound } from "@/lib/constants";

/**
 * #43 — the curated, bundled lo-fi library. One CC0 track per open-lofi category
 * (see public/audio/lofi/ + public/audio/LICENSE.md for provenance). This array
 * is BOTH the settings-picker data source and the in-timer mini-player playlist;
 * its order is the next/prev cycle order. `id` is the FocusSound value persisted
 * in Settings.focusSound. Titles/categories mirror open-lofi's catalog.json.
 */
export type FocusTrack = {
  id: string;
  title: string;
  category: string;
  categoryLabel: string;
  src: string;
};

export const FOCUS_SOUND_TRACKS: readonly FocusTrack[] = [
  {
    id: FocusSound.LofiCalm,
    title: "Aurora on Mute",
    category: "ambient-lofi",
    categoryLabel: "Ambient lo-fi",
    src: "/audio/lofi/aurora-on-mute.mp3",
  },
  {
    id: FocusSound.LofiChillhop,
    title: "Porchlight Golden Hour",
    category: "chillhop",
    categoryLabel: "Chillhop",
    src: "/audio/lofi/porchlight-golden-hour.mp3",
  },
  {
    id: FocusSound.LofiJazzhop,
    title: "Breezy Afternoon Terrace",
    category: "jazzhop",
    categoryLabel: "Jazz hop",
    src: "/audio/lofi/breezy-afternoon-terrace.mp3",
  },
  {
    id: FocusSound.LofiSoulRnb,
    title: "Barefoot in the Kitchen",
    category: "soul-rnb",
    categoryLabel: "Soul / R&B",
    src: "/audio/lofi/barefoot-in-the-kitchen.mp3",
  },
  {
    id: FocusSound.LofiLateNight,
    title: "3 AM Echoes",
    category: "late-night",
    categoryLabel: "Late night",
    src: "/audio/lofi/3-am-echoes.mp3",
  },
  {
    id: FocusSound.LofiFunkSoul,
    title: "Burnt Sunset Groove",
    category: "funk-soul",
    categoryLabel: "Funk / soul",
    src: "/audio/lofi/burnt-sunset-groove.mp3",
  },
  {
    id: FocusSound.LofiAsian,
    title: "Lanterns in Slow Motion",
    category: "asian-lofi",
    categoryLabel: "Asian lo-fi",
    src: "/audio/lofi/lanterns-in-slow-motion.mp3",
  },
  {
    id: FocusSound.LofiSeasonal,
    title: "After School Rain",
    category: "seasonal-weather",
    categoryLabel: "Seasonal / weather",
    src: "/audio/lofi/after-school-rain.mp3",
  },
  {
    id: FocusSound.LofiActivities,
    title: "Chapter By Lamplight",
    category: "activities",
    categoryLabel: "Activities",
    src: "/audio/lofi/chapter-by-lamplight.mp3",
  },
  {
    id: FocusSound.LofiHybrid,
    title: "Cafe Da Tarde",
    category: "hybrid",
    categoryLabel: "Hybrid / world",
    src: "/audio/lofi/cafe-da-tarde.mp3",
  },
];

/** Each Focus-sound value → its bundled CC0 asset (null = silent). Files live
 * under public/audio/ with a LICENSE note. Derived from FOCUS_SOUND_TRACKS so
 * the picker, the player and this map can never drift. Streaming the full
 * catalog is a future release (#61) — not here. */
export const FOCUS_SOUND_SRC: Record<string, string | null> = {
  [FocusSound.Off]: null,
  ...Object.fromEntries(FOCUS_SOUND_TRACKS.map((t) => [t.id, t.src])),
};

// ── Pure playlist helpers (unit-tested; no DOM) ────────────────────────────────

/** The track for a FocusSound value, or undefined for "off"/unknown. */
export function focusTrackById(id: string): FocusTrack | undefined {
  return FOCUS_SOUND_TRACKS.find((t) => t.id === id);
}

/** Index of a track id in the playlist, or -1 if it isn't a real track. */
export function focusTrackIndex(id: string): number {
  return FOCUS_SOUND_TRACKS.findIndex((t) => t.id === id);
}

/** Next track id in the playlist, wrapping around; falls back to the first
 * track when the current id isn't a real track (e.g. "off"). Returns "" when
 * the playlist is empty. */
export function nextFocusTrackId(id: string): string {
  if (FOCUS_SOUND_TRACKS.length === 0) return "";
  const i = focusTrackIndex(id);
  if (i < 0) return FOCUS_SOUND_TRACKS[0].id;
  return FOCUS_SOUND_TRACKS[(i + 1) % FOCUS_SOUND_TRACKS.length].id;
}

/** Previous track id in the playlist, wrapping around; falls back to the last
 * track when the current id isn't a real track. Returns "" when empty. */
export function prevFocusTrackId(id: string): string {
  const n = FOCUS_SOUND_TRACKS.length;
  if (n === 0) return "";
  const i = focusTrackIndex(id);
  if (i < 0) return FOCUS_SOUND_TRACKS[n - 1].id;
  return FOCUS_SOUND_TRACKS[(i - 1 + n) % n].id;
}

/** Clamp a volume to the [0, 1] range the <audio> element accepts. */
export function clampVolume(v: number): number {
  if (!Number.isFinite(v)) return 1;
  return Math.min(1, Math.max(0, v));
}

const ALARM_SRC = "/audio/alarm.wav";

export type Alarm = { play(): void };
export type LoopPlayer = {
  play(): void;
  pause(): void;
  stop(): void;
  /** Set output volume (0..1, clamped). */
  setVolume(v: number): void;
  /** Swap the looping source; resumes automatically if currently playing. */
  load(src: string): void;
  /** Current playback position + track length (seconds); 0s where unknown. */
  getTime(): { currentTime: number; duration: number };
};
export type PreviewPlayer = {
  /** Play a one-shot (non-looping) preview; stops any previous preview first. */
  play(src: string, onEnded?: () => void): void;
  stop(): void;
};
export type WakeGuard = { release(): void };

function makeAudio(src: string, loop = false): HTMLAudioElement | null {
  try {
    if (typeof Audio === "undefined") return null;
    const a = new Audio(src);
    a.loop = loop;
    return a;
  } catch {
    return null;
  }
}

/** One-shot alarm — call play() at time's-up; also vibrates on mobile. */
export function createAlarm(): Alarm {
  const audio = makeAudio(ALARM_SRC);
  return {
    play() {
      try {
        if (audio) {
          audio.currentTime = 0;
          void audio.play().catch(() => {});
        }
      } catch {
        /* ignore playback errors */
      }
      try {
        navigator.vibrate?.([200, 100, 200]);
      } catch {
        /* vibrate unsupported */
      }
    },
  };
}

/** Looping background player for the given asset. Supports live volume changes
 * and swapping the source (for the mini-player's next/prev) without losing the
 * play/pause state. */
export function createLoopPlayer(
  src: string,
  opts: { volume?: number } = {},
): LoopPlayer {
  const audio = makeAudio(src, true);
  if (audio && opts.volume != null) audio.volume = clampVolume(opts.volume);
  let playing = false;
  return {
    play() {
      playing = true;
      try {
        void audio?.play().catch(() => {});
      } catch {
        /* ignore */
      }
    },
    pause() {
      playing = false;
      try {
        audio?.pause();
      } catch {
        /* ignore */
      }
    },
    stop() {
      playing = false;
      try {
        if (audio) {
          audio.pause();
          audio.currentTime = 0;
        }
      } catch {
        /* ignore */
      }
    },
    setVolume(v: number) {
      try {
        if (audio) audio.volume = clampVolume(v);
      } catch {
        /* ignore */
      }
    },
    load(nextSrc: string) {
      try {
        if (!audio) return;
        audio.src = nextSrc;
        audio.currentTime = 0;
        if (playing) void audio.play().catch(() => {});
      } catch {
        /* ignore */
      }
    },
    getTime() {
      try {
        if (!audio) return { currentTime: 0, duration: 0 };
        const duration = Number.isFinite(audio.duration) ? audio.duration : 0;
        const currentTime = Number.isFinite(audio.currentTime)
          ? audio.currentTime
          : 0;
        return { currentTime, duration };
      } catch {
        return { currentTime: 0, duration: 0 };
      }
    },
  };
}

/** One shared, non-looping preview player for the settings picker: starting a
 * new preview stops the previous one, so only one auditions at a time. */
export function createPreviewPlayer(): PreviewPlayer {
  let audio: HTMLAudioElement | null = null;
  return {
    play(src: string, onEnded?: () => void) {
      try {
        if (!audio) audio = makeAudio(src, false);
        if (!audio) return;
        audio.pause();
        audio.src = src;
        audio.currentTime = 0;
        audio.onended = onEnded ?? null;
        void audio.play().catch(() => {});
      } catch {
        /* ignore */
      }
    },
    stop() {
      try {
        if (audio) {
          audio.pause();
          audio.currentTime = 0;
          audio.onended = null;
        }
      } catch {
        /* ignore */
      }
    },
  };
}

type WakeLockLike = {
  request(type: "screen"): Promise<{ release(): Promise<void> }>;
};

/** Acquire a screen wake lock; returns a release handle (a no-op guard where
 * the Wake Lock API is unsupported). */
export async function acquireWakeLock(): Promise<WakeGuard> {
  try {
    const wl = (navigator as Navigator & { wakeLock?: WakeLockLike }).wakeLock;
    if (!wl) return { release() {} };
    const sentinel = await wl.request("screen");
    return {
      release() {
        void sentinel.release().catch(() => {});
      },
    };
  } catch {
    return { release() {} };
  }
}
