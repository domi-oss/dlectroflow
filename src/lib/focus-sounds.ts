/**
 * Browser-API boundary for the focus timer's device effects (MR ②). Everything
 * here touches the DOM / navigator and degrades silently where unsupported, so
 * the timer component stays thin and its tests mock this module. Audio must be
 * constructed inside a user gesture (the Start tap) so the browser unlocks
 * later programmatic playback.
 */

import { FocusSound } from "@/lib/constants";

/** Each Focus-sound value → its bundled CC0 asset (null = silent). Files live
 * under public/audio/ with a LICENSE note. Streaming sources are a future
 * release — not here. */
export const FOCUS_SOUND_SRC: Record<string, string | null> = {
  [FocusSound.Off]: null,
  [FocusSound.LofiCalm]: "/audio/lofi-calm.mp3",
};

const ALARM_SRC = "/audio/alarm.mp3";

export type Alarm = { play(): void };
export type LoopPlayer = { play(): void; pause(): void; stop(): void };
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

/** Looping background player for the given asset. */
export function createLoopPlayer(src: string): LoopPlayer {
  const audio = makeAudio(src, true);
  return {
    play() {
      try {
        void audio?.play().catch(() => {});
      } catch {
        /* ignore */
      }
    },
    pause() {
      try {
        audio?.pause();
      } catch {
        /* ignore */
      }
    },
    stop() {
      try {
        if (audio) {
          audio.pause();
          audio.currentTime = 0;
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
