"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  FOCUS_SOUND_TRACKS,
  buildPlayOrder,
  createPlaylistPlayer,
  focusTrackIndex,
  playOrderCursor,
  clampVolume,
  type FocusTrack,
  type PlaylistPlayer,
} from "@/lib/focus-sounds";

/**
 * #43 — the in-timer lo-fi playlist controller. Owns a single background
 * HTMLAudioElement (via the focus-sounds boundary) so both the FocusTimer (which
 * calls play() inside the Start gesture to unlock autoplay) and the embedded
 * mini-player share ONE source of truth for current-track / playing / volume.
 * The audio element is created lazily on first play() — which is always driven by
 * a user gesture — so autoplay policies are respected. Sound is coupled to the
 * countdown, one-directionally: the timer pauses it when it pauses and resumes it
 * (from position) when it resumes, and it stops on session end / unmount. The
 * mini-player can still pause/resume on its own without touching the timer.
 *
 * #68 — it is a real playlist now, not one looped file. The element does not
 * loop; when a track ends we advance to the next entry of the current PASS (see
 * buildPlayOrder) and only wrap to its head once every track has been heard, so
 * nothing repeats mid-pass in either order. Shuffle deals a whole shuffled pass
 * up front (never a random pick per advance, which can play the same track twice
 * in a row) and is a persisted taste setting: seeded from Settings.focusShuffle
 * and reported back through onShuffleChange.
 */
export type FocusSoundControls = {
  track: FocusTrack | null;
  playing: boolean;
  volume: number;
  hasTracks: boolean;
  /** Whether the current pass is shuffled (drives the mini-player's toggle). */
  shuffle: boolean;
  play: () => void;
  pause: () => void;
  toggle: () => void;
  next: () => void;
  prev: () => void;
  /** Flip shuffle for the rest of the session; never interrupts the current
   * track, only what comes after it. */
  toggleShuffle: () => void;
  setVolume: (v: number) => void;
  stop: () => void;
  /** Read the current playback position + track length (seconds). Stable; the
   * mini-player polls it for its progress bar so progress lives there, not here
   * (keeps this hook's identity stable across ticks). */
  getTime: () => { currentTime: number; duration: number };
};

export type FocusSoundOptions = {
  /** Seed from Settings.focusShuffle (#68) — a taste setting, not per-session. */
  shuffle?: boolean;
  /** Called with the new value when the user toggles shuffle, so the caller can
   * persist it. Keep it referentially stable (useCallback). */
  onShuffleChange?: (shuffle: boolean) => void;
};

export const DEFAULT_FOCUS_VOLUME = 0.5;

/** The pass being played: track indices consumed head→tail, plus where in them
 * we are. Wrapping is only allowed once `cursor` reaches the tail (#68). */
type Pass = { order: number[]; cursor: number };

export function useFocusSound(
  initialSound: string,
  opts: FocusSoundOptions = {},
): FocusSoundControls {
  const tracks = FOCUS_SOUND_TRACKS;
  const startIndex = Math.max(0, focusTrackIndex(initialSound));
  const initialShuffle = Boolean(opts.shuffle);

  const [index, setIndex] = useState(startIndex);
  const [playing, setPlaying] = useState(false);
  const [volume, setVolumeState] = useState(DEFAULT_FOCUS_VOLUME);
  const [shuffle, setShuffleState] = useState(initialShuffle);

  // Refs mirror state so the memoised callbacks always act on current values
  // without being re-created (and without stale-closure bugs).
  const indexRef = useRef(startIndex);
  const playingRef = useRef(false);
  const volumeRef = useRef(DEFAULT_FOCUS_VOLUME);
  const shuffleRef = useRef(initialShuffle);
  const playerRef = useRef<PlaylistPlayer | null>(null);
  const passRef = useRef<Pass | null>(null);
  // The persistence callback may change identity between renders; keep the
  // latest in a ref so toggleShuffle itself stays stable.
  const onShuffleChangeRef = useRef(opts.onShuffleChange);
  useEffect(() => {
    onShuffleChangeRef.current = opts.onShuffleChange;
  }, [opts.onShuffleChange]);

  const setIdx = (i: number) => {
    indexRef.current = i;
    setIndex(i);
  };
  const setPlay = (p: boolean) => {
    playingRef.current = p;
    setPlaying(p);
  };

  // The pass is dealt lazily (a shuffle spends randomness we shouldn't spend on
  // every render) and starts on the track settings chose, so a session opens with
  // the sound the user picked even when shuffle is on.
  const pass = useCallback((): Pass => {
    if (!passRef.current) {
      const order = buildPlayOrder(tracks.length, {
        shuffle: shuffleRef.current,
        startAt: startIndex,
      });
      passRef.current = { order, cursor: playOrderCursor(order, startIndex) };
    }
    return passRef.current;
  }, [tracks, startIndex]);

  // Latest step(), for the element's `ended` handler — that handler is installed
  // once, at creation, so it must not close over a stale callback.
  const stepRef = useRef<(delta: 1 | -1) => void>(() => {});

  // Create the audio element on first use (inside a gesture). It NEVER reloads an
  // existing element — resuming after a pause must continue from its current
  // position, so we only ever create here; swapping src is done via load() in
  // step() (an actual track change), never on play().
  const create = useCallback(
    (i: number): PlaylistPlayer | null => {
      const track = tracks[i];
      if (!track) return null;
      if (!playerRef.current) {
        playerRef.current = createPlaylistPlayer(track.src, {
          volume: volumeRef.current,
          // #68 — the element doesn't loop, so a finished track is our cue to
          // advance the pass. Guarded on playingRef: a stray `ended` after the
          // timer paused or the session stopped must not resurrect audio (nor
          // swap the source out from under a paused element, which would lose
          // the position the #43 coupling promises to keep).
          onEnded: () => {
            if (playingRef.current) stepRef.current(1);
          },
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

  /**
   * Move one entry through the current pass and load that track. Running off the
   * tail is the ONLY place the playlist wraps — and a shuffled pass is re-dealt
   * there, keeping the track that just finished off the new head so a wrap can't
   * sound like a repeat either. Running off the head (prev) goes to the tail of
   * the SAME pass: that's a deliberate user tap, not an exhausted pass, so it
   * must not re-deal the order underneath them.
   */
  const step = useCallback(
    (delta: 1 | -1) => {
      if (tracks.length === 0) return;
      const p = pass();
      let cursor = p.cursor + delta;
      if (cursor >= p.order.length) {
        if (shuffleRef.current) {
          p.order = buildPlayOrder(tracks.length, {
            shuffle: true,
            avoidFirst: p.order[p.order.length - 1],
          });
        }
        cursor = 0;
      } else if (cursor < 0) {
        cursor = p.order.length - 1;
      }
      p.cursor = cursor;
      const i = p.order[cursor];
      setIdx(i);
      // Changing tracks: create the element if needed, then load() the new src
      // (which resets position and resumes iff we were already playing).
      create(i)?.load(tracks[i].src);
    },
    [create, pass, tracks],
  );
  useEffect(() => {
    stepRef.current = step;
  }, [step]);

  const next = useCallback(() => step(1), [step]);
  const prev = useCallback(() => step(-1), [step]);

  const toggleShuffle = useCallback(() => {
    const nextShuffle = !shuffleRef.current;
    shuffleRef.current = nextShuffle;
    setShuffleState(nextShuffle);
    // Re-deal the pass AROUND the current track (it becomes the head), so the
    // toggle never touches playback — no load(), no position reset; only what
    // comes next changes. Tracks already heard in the abandoned pass can come
    // round again: the user just asked for a different order.
    const order = buildPlayOrder(tracks.length, {
      shuffle: nextShuffle,
      startAt: indexRef.current,
    });
    passRef.current = {
      order,
      cursor: playOrderCursor(order, indexRef.current),
    };
    onShuffleChangeRef.current?.(nextShuffle);
  }, [tracks]);

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
  // identity when the reactive state (track / playing / volume / shuffle) actually
  // changes — not on unrelated parent re-renders (e.g. the timer's per-second
  // tick). That keeps the mini-player from re-rendering needlessly and lets
  // consumers depend on individual callbacks without recreating their own
  // memoised values.
  return useMemo(
    () => ({
      track: tracks[index] ?? null,
      playing,
      volume,
      hasTracks: tracks.length > 0,
      shuffle,
      play,
      pause,
      toggle,
      next,
      prev,
      toggleShuffle,
      setVolume,
      stop,
      getTime,
    }),
    [
      tracks,
      index,
      playing,
      volume,
      shuffle,
      play,
      pause,
      toggle,
      next,
      prev,
      toggleShuffle,
      setVolume,
      stop,
      getTime,
    ],
  );
}
