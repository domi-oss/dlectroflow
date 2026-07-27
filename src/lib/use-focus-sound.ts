"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  FOCUS_SOUND_TRACKS,
  createLoopPlayer,
  focusTrackIndex,
  clampVolume,
  type FocusTrack,
  type LoopPlayer,
} from "@/lib/focus-sounds";

/**
 * #43 — the in-timer lo-fi playlist controller. Owns a single looping
 * HTMLAudioElement (via the focus-sounds boundary) so both the FocusTimer (which
 * calls play() inside the Start gesture to unlock autoplay) and the embedded
 * mini-player share ONE source of truth for current-track / playing / volume.
 * The audio element is created lazily on first play() — which is always driven by
 * a user gesture — so autoplay policies are respected. Sound is coupled to the
 * countdown, one-directionally: the timer pauses it when it pauses and resumes it
 * (from position) when it resumes, and it stops on session end / unmount. The
 * mini-player can still pause/resume on its own without touching the timer.
 */
export type FocusSoundControls = {
  track: FocusTrack | null;
  playing: boolean;
  volume: number;
  hasTracks: boolean;
  play: () => void;
  pause: () => void;
  toggle: () => void;
  next: () => void;
  prev: () => void;
  setVolume: (v: number) => void;
  stop: () => void;
  /** Read the current playback position + track length (seconds). Stable; the
   * mini-player polls it for its progress bar so progress lives there, not here
   * (keeps this hook's identity stable across ticks). */
  getTime: () => { currentTime: number; duration: number };
};

export const DEFAULT_FOCUS_VOLUME = 0.5;

export function useFocusSound(initialSound: string): FocusSoundControls {
  const tracks = FOCUS_SOUND_TRACKS;
  const startIndex = Math.max(0, focusTrackIndex(initialSound));

  const [index, setIndex] = useState(startIndex);
  const [playing, setPlaying] = useState(false);
  const [volume, setVolumeState] = useState(DEFAULT_FOCUS_VOLUME);

  // Refs mirror state so the memoised callbacks always act on current values
  // without being re-created (and without stale-closure bugs).
  const indexRef = useRef(startIndex);
  const playingRef = useRef(false);
  const volumeRef = useRef(DEFAULT_FOCUS_VOLUME);
  const playerRef = useRef<LoopPlayer | null>(null);

  const setIdx = (i: number) => {
    indexRef.current = i;
    setIndex(i);
  };
  const setPlay = (p: boolean) => {
    playingRef.current = p;
    setPlaying(p);
  };

  // Create the audio element on first use (inside a gesture). It NEVER reloads an
  // existing element — resuming after a pause must continue from its current
  // position, so we only ever create here; swapping src is done via load() in
  // goto() (an explicit track change), never on play().
  const create = useCallback(
    (i: number): LoopPlayer | null => {
      const track = tracks[i];
      if (!track) return null;
      if (!playerRef.current) {
        playerRef.current = createLoopPlayer(track.src, {
          volume: volumeRef.current,
        });
      }
      return playerRef.current;
    },
    [tracks],
  );

  const play = useCallback(() => {
    // Resume/start the SAME element — no load(), no currentTime reset.
    const p = create(indexRef.current);
    if (!p) return;
    p.play();
    setPlay(true);
  }, [create]);

  const pause = useCallback(() => {
    playerRef.current?.pause();
    setPlay(false);
  }, []);

  const toggle = useCallback(() => {
    if (playingRef.current) pause();
    else play();
  }, [play, pause]);

  const goto = useCallback(
    (i: number) => {
      if (tracks.length === 0) return;
      const wrapped = ((i % tracks.length) + tracks.length) % tracks.length;
      setIdx(wrapped);
      // Changing tracks: create the element if needed, then load() the new src
      // (which resets position and resumes iff we were already playing).
      const p = create(wrapped);
      p?.load(tracks[wrapped].src);
    },
    [create, tracks],
  );

  const next = useCallback(() => goto(indexRef.current + 1), [goto]);
  const prev = useCallback(() => goto(indexRef.current - 1), [goto]);

  const setVolume = useCallback((v: number) => {
    const cv = clampVolume(v);
    volumeRef.current = cv;
    setVolumeState(cv);
    playerRef.current?.setVolume(cv);
  }, []);

  const stop = useCallback(() => {
    playerRef.current?.stop();
    setPlay(false);
  }, []);

  const getTime = useCallback(
    () => playerRef.current?.getTime() ?? { currentTime: 0, duration: 0 },
    [],
  );

  // Tear the element down on unmount so audio never outlives the timer.
  useEffect(
    () => () => {
      playerRef.current?.stop();
      playerRef.current = null;
    },
    [],
  );

  // Every callback above is useCallback-stable, so this API object only changes
  // identity when the reactive state (track / playing / volume) actually changes
  // — not on unrelated parent re-renders (e.g. the timer's per-second tick). That
  // keeps the mini-player from re-rendering needlessly and lets consumers depend
  // on individual callbacks without recreating their own memoised values.
  return useMemo(
    () => ({
      track: tracks[index] ?? null,
      playing,
      volume,
      hasTracks: tracks.length > 0,
      play,
      pause,
      toggle,
      next,
      prev,
      setVolume,
      stop,
      getTime,
    }),
    [
      tracks,
      index,
      playing,
      volume,
      play,
      pause,
      toggle,
      next,
      prev,
      setVolume,
      stop,
      getTime,
    ],
  );
}
