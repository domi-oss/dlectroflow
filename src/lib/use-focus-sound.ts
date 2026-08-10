"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  buildPlayOrder,
  createPlaylistPlayer,
  playOrderCursor,
  resolveFocusPool,
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
 * #70 — the playlist can also be NARROWED to a category selection (Settings
 * .focusSoundCategories, an array since #180). Phase 1's pass model needed no
 * changes for that: it walks whatever list it is given. What did need deciding is
 * the difference between a list that GREW and a list that was REPLACED — see the
 * effect below. Growing is #61's case and must never interrupt; replacing is a
 * selection change and must, because continuing to play a track that is no longer
 * in the playlist means the picker says one thing and the speakers say another.
 *
 * #180 — the hook no longer takes an opening track. `Settings.focusSound` became
 * a two-value switch, so nothing persists "which track does the session open on"
 * and every session opens on the head of the pass built over the resolved pool.
 * That is the accepted regression #180 records, not an oversight: once the player
 * can jump to any track (#181), pre-selecting one in advance earns nothing.
 *
 * #181 — that jump is `jumpTo`, and it is `buildPlayOrder`'s `startAt` and
 * nothing else. What #181 did add is `orphan`: the selection is now re-ticked
 * from the player DURING a session, so a replacement can no longer interrupt, and
 * a track whose playlist has just been unticked has no index in the new pool for
 * `startAt` to name. See the state declaration and the pool-change effect.
 */
export type FocusSoundControls = {
  track: FocusTrack | null;
  playing: boolean;
  volume: number;
  hasTracks: boolean;
  /**
   * #181 — the WHOLE merged catalogue, before the selection narrows it. The
   * player's tick-list counts each playlist off this; taking it from the hook
   * rather than calling `useFocusCatalog` again is what stops the counts and the
   * pool being resolved from two sources that could disagree mid-fetch.
   */
  catalog: readonly FocusTrack[];
  /** #181 — the pool the ticks resolve to, i.e. what the jump-list offers and
   * what the pass walks. */
  pool: readonly FocusTrack[];
  /** Whether the current pass is shuffled (drives the mini-player's toggle). */
  shuffle: boolean;
  play: () => void;
  pause: () => void;
  toggle: () => void;
  next: () => void;
  prev: () => void;
  /**
   * #181 — play a named track of the pool and carry on through the rest of it.
   *
   * A jump, not a filter: the pool is unchanged and the pass is re-dealt AROUND
   * the chosen track via `buildPlayOrder`'s `startAt` — the same mechanism
   * `toggleShuffle` uses, not a second one. Ignores an id the pool does not
   * hold. It does NOT start playback: the transport is left exactly where it
   * was, matching next()/prev(), because the #43 coupling is the only thing
   * allowed to decide whether a focus session is making noise.
   */
  jumpTo: (trackId: string) => void;
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
   * #180 — Settings.focusSoundCategories. Zero or more of the ten open-lofi
   * slugs; empty (or omitted) means the whole catalogue, which is the normal
   * case. A selection nothing matches widens back to the whole catalogue rather
   * than going silent (`resolveFocusPool`).
   *
   * Order is irrelevant — the pool is a filter over the catalogue, so ticking
   * chillhop then jazzhop gives the same list as the reverse.
   */
  categories?: readonly string[] | null;
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

/**
 * Where every session opens: the head of the pool.
 *
 * #180 removed the only input that could have said otherwise. Named rather than
 * inlined because three separate places have to agree on it — the initial state,
 * the initial refs, and the pass re-dealt when the playlist is replaced.
 */
const POOL_HEAD = 0;

export function useFocusSound(
  opts: FocusSoundOptions = {},
): FocusSoundControls {
  // #61 — the bundled ten, then whatever the streamed catalog adds once it
  // loads. Identical to FOCUS_SOUND_TRACKS (same array) until then, and on every
  // instance with no catalog configured, so a session always has music.
  const available = useFocusCatalog();
  /**
   * #180 — the selection, flattened to a string, and that is load-bearing.
   *
   * The effect below treats a new track-list IDENTITY as "the playlist changed",
   * so the memo underneath must not re-run on renders where nothing changed. An
   * array prop cannot be a dependency for that: every caller that writes
   * `categories={settings.focusSoundCategories ?? []}` hands over a fresh array
   * on every render, which would re-resolve the pool, hand the effect a new
   * identity, and re-deal the pass — forever.
   *
   * Sorted, because the pool is a filter over the catalogue and therefore does
   * not depend on the order the categories were given in; without the sort, a
   * caller reordering the same selection would count as a change. JSON rather
   * than a joined string so the key round-trips exactly — a separator would be a
   * correctness hazard rather than a style choice, because a slug containing it
   * would split into two slugs and resolve a different pool.
   */
  const categoryKey = JSON.stringify([...(opts.categories ?? [])].sort());
  // #70 — the catalog, narrowed to the selected categories. useMemo is
  // load-bearing rather than an optimisation, for the reason above.
  const tracks = useMemo(
    () => resolveFocusPool(available, JSON.parse(categoryKey) as string[]),
    [available, categoryKey],
  );
  const initialShuffle = Boolean(opts.shuffle);

  const [index, setIndex] = useState(POOL_HEAD);
  const [playing, setPlaying] = useState(false);
  const [volume, setVolumeState] = useState(DEFAULT_FOCUS_VOLUME);
  const [shuffle, setShuffleState] = useState(initialShuffle);
  /**
   * #181 — the track the element is on when the pool no longer contains it.
   *
   * "Unticking a playlist while one of its tracks is playing does not cut the
   * audio", and `startAt` cannot express that: it is an INDEX INTO THE POOL, and
   * an unticked track has no index there. So what is audible is held here
   * instead — outside the pass entirely — and `track` reports it, which is what
   * keeps the label on what the speakers are actually doing. It survives exactly
   * until the next advance or jump, at which point the new pool takes over.
   *
   * The alternative was #180's rule, which reloaded the element onto the new
   * pool's head the moment the selection changed. It kept the label honest by
   * moving the audio, and #181 rejects that: a stray tap must not silence you
   * mid-bar.
   */
  const [orphan, setOrphan] = useState<FocusTrack | null>(null);

  // Refs mirror state so the memoised callbacks always act on current values
  // without being re-created (and without stale-closure bugs).
  const indexRef = useRef(POOL_HEAD);
  const playingRef = useRef(false);
  const volumeRef = useRef(DEFAULT_FOCUS_VOLUME);
  const shuffleRef = useRef(initialShuffle);
  const playerRef = useRef<PlaylistPlayer | null>(null);
  const passRef = useRef<Pass | null>(null);
  const orphanRef = useRef<FocusTrack | null>(null);
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
  const setOrphanTrack = (t: FocusTrack | null) => {
    orphanRef.current = t;
    setOrphan(t);
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

  /**
   * #181 — a pass nothing has entered yet: the FIRST advance lands on its head.
   *
   * Used when what is audible is not in the pool at all (see `orphan`). There is
   * no `startAt` to give — that is the whole difficulty — so the order is dealt
   * free, and `cursor: -1` is what makes `step(1)` read position 0 instead of
   * skipping it. `heard` is empty for the same reason: nothing in this pass has
   * been played, so nothing may be treated as owed.
   */
  const dealPendingPass = (list: readonly FocusTrack[]): Pass => ({
    order: buildPlayOrder(list.length, { shuffle: shuffleRef.current }),
    cursor: -1,
    heard: new Set<number>(),
  });

  // The pass is dealt lazily — a shuffle spends randomness we shouldn't spend on
  // every render — and always at the head of the pool (#180: nothing persists an
  // opening track). Under shuffle the head is whatever the deal put there, so a
  // session opens on something different each time rather than always the same
  // first track, which is the point of shuffling by default for new accounts.
  const pass = useCallback((): Pass => {
    passRef.current ??= dealPass(tracks, POOL_HEAD);
    return passRef.current;
  }, [tracks]);

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
   * **It was REPLACED** (#70/#180: the category selection changed). The current
   * track is not in the new playlist. #180 reloaded the element onto the new
   * list's head here, on the grounds that continuing would mean the picker says
   * chillhop while the speakers play jazz hop. **#181 reverses that**, because
   * the selection is now made from the player DURING a session rather than from
   * a settings page between them, and interrupting on every tick means a stray
   * tap silences you mid-bar. The desync is still not tolerated — it is resolved
   * the other way round, by moving the LABEL rather than the audio: the track is
   * held in `orphan`, `track` goes on naming what is really playing, and the pass
   * over the new pool is dealt so the NEXT advance is its head.
   *
   * With nothing playing there is no element and therefore nothing to protect, so
   * that case still opens the new pool at its head — pretending a silent session
   * were mid-track would leave `track` naming something the next Start would not
   * play.
   *
   * A LENGTH check cannot make this distinction, which is not hypothetical: two
   * categories with the same number of tracks are common, and the old guard
   * returned early on that swap and left the element on the old source.
   *
   * The heard-set is reset in both branches, and deliberately so: it records
   * positions in a pass, so carrying it into a re-dealt order would mark
   * unrelated entries as already played and wrap the playlist early.
   *
   * ── On the setState in here ─────────────────────────────────────────────────
   * `react-hooks/set-state-in-effect` is an error in this repo, and it is right
   * to be. This is the case the rule exempts in prose: React state being
   * synchronised with two external systems it does not own — an async catalog
   * fetch and a live `<audio>` element. It also costs almost nothing in practice.
   * `mergeFocusTracks` keeps bundled tracks at their indices, so #61's growth
   * path reaches `moved === indexRef.current` and sets nothing; the only branch
   * that re-renders is a playlist REPLACEMENT, which is a deliberate user action.
   * (The rule does not flag it because `setIdx` wraps the setter — an indirection
   * that predates this change. If it is ever inlined, this comment is the answer.)
   */
  const tracksRef = useRef(tracks);
  useEffect(() => {
    if (tracks === tracksRef.current) return;
    const previous = tracksRef.current;
    tracksRef.current = tracks;
    if (tracks.length === 0) return;

    // #181 — an already-orphaned track is the one to reconcile, not whatever
    // `index` happens to point at: while orphaned `index` is a placeholder into
    // the pool, and reading it here would swap the audible track for a neighbour
    // on the second untick in a row.
    const audible = orphanRef.current ?? previous[indexRef.current] ?? null;
    const moved = audible ? trackIndexIn(tracks, audible.id) : -1;

    if (moved >= 0) {
      // Re-ticking a playlist while its track is still audible lands here, which
      // is what makes the tick-list non-destructive: the orphan is re-adopted at
      // its real index and the pass is re-dealt around it.
      setOrphanTrack(null);
      if (moved !== indexRef.current) setIdx(moved);
      // A pass that has not been dealt yet is left alone; it will be dealt over
      // the new list, at the new start index, on first use.
      if (passRef.current) passRef.current = dealPass(tracks, moved);
      return;
    }

    if (playerRef.current && audible) {
      // #181 — the element is live (playing, or paused mid-track with a position
      // the #43 coupling promises to keep). Touch neither, and queue the new pool
      // behind it.
      setOrphanTrack(audible);
      passRef.current = dealPendingPass(tracks);
      // `index` is meaningless while orphaned — `track` reads the orphan — but it
      // must stay in range of the new pool so a later read of `tracks[index]`
      // cannot be undefined.
      setIdx(POOL_HEAD);
      return;
    }

    // Nothing has ever played. #180 — the anchor used to be the stored opening
    // track, resolved inside the new list; nothing persists one now, so this
    // opens at the pool's head.
    setOrphanTrack(null);
    passRef.current = dealPass(tracks, POOL_HEAD);
    setIdx(POOL_HEAD);
  }, [tracks]);

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
      // #181 — an advance is where an unticked track's grace ends: the new pool
      // is now what plays, so the label goes back to reading from it.
      setOrphanTrack(null);
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

  /**
   * #181 — jump to a named track of the pool.
   *
   * The whole implementation is `dealPass(tracks, i)`, i.e. `buildPlayOrder`'s
   * `startAt` — the same call `toggleShuffle` makes, for the same reason: the
   * chosen track goes to the head of a pass that still contains every other track
   * exactly once, so "continue from there" and "no repeats until exhausted" both
   * come for free. There is deliberately no second mechanism.
   *
   * `create()` may build the element here, and that is safe: this only runs from
   * a click in the panel, which is a user gesture, so the browser will let the
   * element play later. `load()` resumes iff something was already playing, which
   * is what leaves the transport alone.
   */
  const jumpTo = useCallback(
    (trackId: string) => {
      const i = trackIndexIn(tracks, trackId);
      if (i < 0) return; // not in the pool — a stale row, or a race with a re-tick
      passRef.current = dealPass(tracks, i);
      setOrphanTrack(null);
      setIdx(i);
      create(i)?.load(tracks[i].src);
    },
    [create, tracks],
  );

  const toggleShuffle = useCallback(() => {
    const nextShuffle = !shuffleRef.current;
    shuffleRef.current = nextShuffle;
    setShuffleState(nextShuffle);
    // Re-deal the pass AROUND the current track (it becomes the head), so the
    // toggle never touches playback — no load(), no position reset; only what
    // comes next changes. Tracks already heard in the abandoned pass can come
    // round again: the user just asked for a different order.
    //
    // #181 — unless what is playing is not in the pool at all, in which case
    // there is no index to deal it to and the new order simply waits its turn,
    // exactly as it was already waiting.
    passRef.current = orphanRef.current
      ? dealPendingPass(tracks)
      : dealPass(tracks, indexRef.current);
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
      // #181 — the orphan wins, because it is what the element is playing. The
      // pool's entry is only the truth while the two agree.
      track: orphan ?? tracks[index] ?? null,
      playing,
      volume,
      hasTracks: tracks.length > 0,
      catalog: available,
      pool: tracks,
      shuffle,
      play,
      pause,
      toggle,
      next,
      prev,
      jumpTo,
      toggleShuffle,
      setVolume,
      stop,
      getTime,
    }),
    [
      available,
      tracks,
      index,
      orphan,
      playing,
      volume,
      shuffle,
      play,
      pause,
      toggle,
      next,
      prev,
      jumpTo,
      toggleShuffle,
      setVolume,
      stop,
      getTime,
    ],
  );
}
