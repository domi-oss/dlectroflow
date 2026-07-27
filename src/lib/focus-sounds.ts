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
 * its order is the playlist's in-order pass (#68). `id` is the FocusSound value
 * persisted in Settings.focusSound. Titles/categories mirror open-lofi's
 * catalog.json.
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

// ── Play order (#68) ──────────────────────────────────────────────────────────
// The player consumes a "pass": an array of track indices, head→tail, and only
// wraps once the pass is exhausted. That is what guarantees no track repeats
// mid-pass — including in shuffle, which shuffles a COPY of the order up front
// rather than picking at random on each advance (random-per-advance can play the
// same track twice in a row, which is the complaint #68 exists to fix).

/**
 * Fisher–Yates shuffle of a COPY of `indices` (the input is never mutated).
 * `rng` is injectable so tests get a deterministic order; it must return a
 * number in [0, 1) like Math.random.
 */
export function shuffleIndices(
  indices: readonly number[],
  rng: () => number = Math.random,
): number[] {
  const out = [...indices];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/**
 * Build a pass over `length` tracks: `[0..length-1]` in order, or a full
 * permutation of it when `shuffle` is set. Both forms contain every track
 * exactly once.
 *
 * - `startAt` — deal this track to the head of a shuffled pass, so toggling
 *   shuffle (or starting a session) never interrupts what is already playing.
 *   Ignored when out of range, and irrelevant in order (the cursor, not the
 *   order, says where an in-order pass is being read from).
 * - `avoidFirst` — keep this track OFF the head. Used when a shuffled pass is
 *   re-dealt on exhaustion: the track that just finished must not immediately
 *   play again. Ignored for a single-track playlist (nothing else to play).
 */
export function buildPlayOrder(
  length: number,
  opts: {
    shuffle?: boolean;
    startAt?: number;
    avoidFirst?: number;
    rng?: () => number;
  } = {},
): number[] {
  if (length <= 0) return [];
  const inOrder = Array.from({ length }, (_, i) => i);
  if (!opts.shuffle) return inOrder;

  const rng = opts.rng ?? Math.random;
  const order = shuffleIndices(inOrder, rng);
  const { startAt, avoidFirst } = opts;
  const inRange = (i: number | undefined): i is number =>
    i != null && Number.isInteger(i) && i >= 0 && i < length;

  if (inRange(startAt)) {
    // Swap the requested track into the head — still a permutation.
    const at = order.indexOf(startAt);
    [order[0], order[at]] = [order[at], order[0]];
  } else if (inRange(avoidFirst) && length > 1 && order[0] === avoidFirst) {
    const j = 1 + Math.floor(rng() * (length - 1));
    [order[0], order[j]] = [order[j], order[0]];
  }
  return order;
}

/** Where a track index sits in a pass; the head (0) when it isn't in there. */
export function playOrderCursor(
  order: readonly number[],
  index: number,
): number {
  const at = order.indexOf(index);
  return at < 0 ? 0 : at;
}

const ALARM_SRC = "/audio/alarm.wav";

export type Alarm = { play(): void };
export type PlaylistPlayer = {
  play(): void;
  pause(): void;
  stop(): void;
  /** Set output volume (0..1, clamped). */
  setVolume(v: number): void;
  /** Swap the source; resumes automatically if currently playing. */
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

// Nothing here loops an element any more (#68): the background player advances
// its playlist on `ended` instead, and the alarm/preview are one-shots.
function makeAudio(src: string): HTMLAudioElement | null {
  try {
    if (typeof Audio === "undefined") return null;
    const a = new Audio(src);
    a.loop = false;
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

/**
 * Background player for one shared element. Supports live volume changes and
 * swapping the source (the mini-player's next/prev, and the playlist's own
 * auto-advance) without losing the play/pause state.
 *
 * #68 — the element deliberately does NOT loop: a looping single source is what
 * made the focus music repeat the same track forever. When a track finishes we
 * report it via `onEnded` and the caller (useFocusSound) loads the next one, so
 * "what plays next" belongs to the playlist rather than to the element.
 */
export function createPlaylistPlayer(
  src: string,
  opts: { volume?: number; onEnded?: () => void } = {},
): PlaylistPlayer {
  const audio = makeAudio(src);
  if (audio && opts.volume != null) audio.volume = clampVolume(opts.volume);
  // Assigned once, on the element we keep for the whole session — load() swaps
  // only `src`, so the handler survives every track change.
  if (audio) audio.onended = opts.onEnded ?? null;
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
        if (!audio) audio = makeAudio(src);
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
