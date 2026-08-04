"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  buildPlayOrder,
  createPlaylistPlayer,
  playOrderCursor,
  resolveFocusPlaylist,
  trackIndexIn,
  clampVolume,
  type FocusTrack,
  type PlaylistPlayer,
} from "@/lib/focus-sounds";
import { useFocusCatalog } from "@/lib/use-focus-catalog";

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
 * #65 — that second direction is now available as an opt-in
 * (Settings.focusPauseTogether), but it is NOT implemented here: this hook has
 * no idea a session exists. The timer intercepts the mini-player's transport
 * press instead, so only a deliberate press couples — never an `ended`, a
 * rejected play() or any other thing the element does on its own.
 *
 * #68 — it is a real playlist now, not one looped file. The element does not
 * loop; when a track ends we advance to the next entry of the current PASS (see
 * buildPlayOrder) and only wrap to its head once every track has been heard, so
 * nothing repeats mid-pass in either order. Shuffle deals a whole shuffled pass
 * up front (never a random pick per advance, which can play the same track twice
 * in a row) and is a persisted taste setting: seeded from Settings.focusShuffle
 * and reported back through onShuffleChange.
 *
 * #70 — the playlist can also be NARROWED to one category (Settings
 * .focusSoundCategory). Phase 1's pass model needed no changes for that: it walks
 * whatever list it is given. What did need deciding is the difference between a
 * list that GREW and a list that was REPLACED — see the effect below. Growing is
 * #61's case and must never interrupt; replacing is a category switch and must,
 * because continuing to play a track that is no longer in the playlist means the
 * picker says one thing and the speakers say another.
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
  /**
   * #70 — Settings.focusSoundCategory. One of the ten open-lofi slugs, or
   * null/undefined for "the whole list", which is the normal case. A slug that
   * matches nothing widens back to the whole list rather than going silent
   * (`resolveFocusPlaylist`).
   */
  category?: string | null;
  /** Seed from Settings.focusShuffle (#68) — a taste setting, not per-session. */
  shuffle?: boolean;
  /** Called with the new value when the user toggles shuffle, so the caller can
   * persist it. Keep it referentially stable (useCallback). */
  onShuffleChange?: (shuffle: boolean) => void;
};

export const DEFAULT_FOCUS_VOLUME = 0.5;

/**
 * The pass being played: track indices, where in them we are, and which
 * POSITIONS have actually been heard this pass (#68).
 *
 * `heard` is what makes "wrap only after exhaustion" true even when the user
 * navigates by hand — reaching the tail is not the same as having played
 * everything (prev from the head jumps there, and an in-order pass starts on
 * whichever track settings chose). Duo review (!151).
 */
type Pass = { order: number[]; cursor: number; heard: Set<number> };

export function useFocusSound(
  initialSound: string,
  opts: FocusSoundOptions = {},
): FocusSoundControls {
  // #61 — the bundled ten, then whatever the streamed catalog adds once it
  // loads. Identical to FOCUS_SOUND_TRACKS (same array) until then, and on every
  // instance with no catalog configured, so a session always has music.
  const available = useFocusCatalog();
  // #70 — then narrowed to one category, if one is selected. useMemo is
  // load-bearing rather than an optimisation: the effect below treats a new array
  // identity as "the playlist changed", so a fresh filter on every render would
  // re-deal the pass on every render.
  const tracks = useMemo(
    () => resolveFocusPlaylist(available, opts.category),
    [available, opts.category],
  );
  // Where the session opens. Resolved against the list the player will actually
  // walk, NOT against FOCUS_SOUND_TRACKS: a bundled track keeps its index in the
  // merged list, but not in a category-narrowed one (the chillhop track is index
  // 1 of ten and index 0 of a chillhop playlist). `Settings.focusSound` can still
  // only hold a bundled track's id — that column is enum-constrained, and a
  // streamed track has no persistable identity — so a category whose stored
  // start track sits outside it simply opens at its own head.
  const startIndex = Math.max(0, trackIndexIn(tracks, initialSound));
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

  /** Deal a fresh pass over `list`, with `startAt` at the cursor. */
  const dealPass = (list: readonly FocusTrack[], startAt: number): Pass => {
    const order = buildPlayOrder(list.length, {
      shuffle: shuffleRef.current,
      startAt,
    });
    const cursor = playOrderCursor(order, startAt);
    return { order, cursor, heard: new Set([cursor]) };
  };

  // The pass is dealt lazily (a shuffle spends randomness we shouldn't spend on
  // every render) and starts on the track settings chose, so a session opens with
  // the sound the user picked even when shuffle is on.
  const pass = useCallback((): Pass => {
    passRef.current ??= dealPass(tracks, startIndex);
    return passRef.current;
  }, [tracks, startIndex]);

  /**
   * The playlist changed underneath a live hook. Two cases, and telling them
   * apart is the whole job — the test for that is "is the track that was current
   * still in the new list?", not the list's length.
   *
   * **It GREW** (#61: the streamed catalog resolved; #70: the selected category
   * gained tracks). The current track is still there, so nothing may interrupt:
   * the pass is re-dealt AROUND it — same contract as toggleShuffle, and for the
   * same reason. No load(), no position reset, only what comes next changes. Its
   * index can still have moved, so `index` is reconciled first; without that,
   * `tracks[index]` reports a neighbour of what is actually playing.
   *
   * **It was REPLACED** (#70: a category switch). The current track is not in the
   * new playlist, and continuing to play it would mean the picker says chillhop
   * while the speakers play jazz hop — the desync a user would report as the
   * feature being broken. So the pass restarts at the new list's head and the
   * element follows it. That is a deliberate interruption, and the only one here:
   * play/pause state is preserved, because `load()` resumes iff it was playing.
   *
   * A LENGTH check cannot make this distinction, which is not hypothetical: two
   * categories with the same number of tracks are common, and the old guard
   * returned early on that swap and left the element on the old source.
   *
   * The heard-set is reset in both branches, and deliberately so: it records
   * positions in a pass, so carrying it into a re-dealt order would mark
   * unrelated entries as already played and wrap the playlist early.
   */
  const tracksRef = useRef(tracks);
  useEffect(() => {
    if (tracks === tracksRef.current) return;
    const previous = tracksRef.current;
    tracksRef.current = tracks;
    if (tracks.length === 0) return;

    const currentId = previous[indexRef.current]?.id;
    const moved = currentId ? trackIndexIn(tracks, currentId) : -1;

    if (moved >= 0) {
      if (moved !== indexRef.current) setIdx(moved);
      // A pass that has not been dealt yet is left alone; it will be dealt over
      // the new list, at the new start index, on first use.
      if (passRef.current) passRef.current = dealPass(tracks, moved);
      return;
    }

    const start = Math.max(0, trackIndexIn(tracks, initialSound));
    passRef.current = dealPass(tracks, start);
    setIdx(start);
    // Only if an element exists. Creating one here would be outside a user
    // gesture (the browser would refuse to play it later), and with nothing
    // playing there is nothing to keep in sync.
    playerRef.current?.load(tracks[start].src);
    // `initialSound` is in the dependency list only to satisfy the linter — the
    // identity guard on the first line means a caller changing it, on its own,
    // does nothing. It is the ANCHOR for a reset, not a trigger for one.
  }, [tracks, initialSound]);

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
   * Move one entry through the current pass and load that track.
   *
   * Running off the tail is the only place the playlist can start over — and it
   * only does so once every position has actually been heard. If some haven't
   * (the user tapped prev, or the in-order pass started mid-list), we hand them
   * the first unheard one instead, so nothing repeats while something new is
   * still owed. On a genuinely exhausted pass a shuffled order is re-dealt with
   * the track that just finished kept off the new head, so even the wrap can't
   * sound like a repeat.
   *
   * Running off the head (prev) goes to the tail of the SAME pass: a deliberate
   * user tap, never a reason to re-deal the order underneath them.
   */
  const step = useCallback(
    (delta: 1 | -1) => {
      if (tracks.length === 0) return;
      const p = pass();
      let cursor = p.cursor + delta;
      if (cursor >= p.order.length) {
        const unheard = p.order.findIndex((_, at) => !p.heard.has(at));
        if (unheard >= 0) {
          cursor = unheard;
        } else {
          if (shuffleRef.current) {
            p.order = buildPlayOrder(tracks.length, {
              shuffle: true,
              avoidFirst: p.order[p.cursor],
            });
          }
          p.heard.clear();
          cursor = 0;
        }
      } else if (cursor < 0) {
        cursor = p.order.length - 1;
      }
      p.cursor = cursor;
      p.heard.add(cursor);
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
    passRef.current = dealPass(tracks, indexRef.current);
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
