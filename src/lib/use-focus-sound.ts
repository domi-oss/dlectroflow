"use client";

import { useCallback, useEffect, useRef, useState } from "react";
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
 * a user gesture — so autoplay policies are respected. Sound is decoupled from
 * the countdown: it keeps looping while the timer is paused (an ambient bed), and
 * only stops on session end / unmount / an explicit pause in the mini-player.
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

  // Create the player on first use (inside a gesture), else swap its source.
  const ensure = useCallback(
    (i: number): LoopPlayer | null => {
      const track = tracks[i];
      if (!track) return null;
      if (!playerRef.current) {
        playerRef.current = createLoopPlayer(track.src, {
          volume: volumeRef.current,
        });
      } else {
        playerRef.current.load(track.src);
      }
      return playerRef.current;
    },
    [tracks],
  );

  const play = useCallback(() => {
    const p = ensure(indexRef.current);
    if (!p) return;
    p.play();
    setPlay(true);
  }, [ensure]);

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
      // load() preserves the play/pause state: it resumes iff we were playing.
      ensure(wrapped);
    },
    [ensure, tracks.length],
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

  // Tear the element down on unmount so audio never outlives the timer.
  useEffect(
    () => () => {
      playerRef.current?.stop();
      playerRef.current = null;
    },
    [],
  );

  return {
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
  };
}
