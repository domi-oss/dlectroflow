// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";

// Fake player instance shared by the mocked createPlaylistPlayer. Declared via
// vi.hoisted so it exists when the (hoisted) vi.mock factory runs. `element`
// also captures the onEnded handler the hook installs, so tests can fire a
// track-end the way the real <audio> element would (#68).
const { createPlaylistPlayer, player, element, useFocusCatalogMock } =
  vi.hoisted(() => {
    const player = {
      play: vi.fn(),
      pause: vi.fn(),
      stop: vi.fn(),
      setVolume: vi.fn(),
      load: vi.fn(),
      getTime: vi.fn(() => ({ currentTime: 0, duration: 0 })),
    };
    const element: { onEnded?: () => void } = {};
    const createPlaylistPlayer = vi.fn(
      (_src: string, opts?: { volume?: number; onEnded?: () => void }) => {
        element.onEnded = opts?.onEnded;
        return player;
      },
    );
    return {
      createPlaylistPlayer,
      player,
      element,
      useFocusCatalogMock: vi.fn(),
    };
  });

vi.mock("@/lib/focus-sounds", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/focus-sounds")>();
  return { ...actual, createPlaylistPlayer };
});

// #61 — the playlist is `useFocusCatalog()`'s output now, so it is the seam the
// hook's tests drive. Default: the bundled ten, i.e. every pre-#61 assertion in
// this file measures exactly what it always did.
vi.mock("@/lib/use-focus-catalog", () => ({
  useFocusCatalog: useFocusCatalogMock,
}));

import { useFocusSound, DEFAULT_FOCUS_VOLUME } from "@/lib/use-focus-sound";
import { FOCUS_SOUND_TRACKS } from "@/lib/focus-sounds";

beforeEach(() => {
  vi.clearAllMocks();
  element.onEnded = undefined;
  useFocusCatalogMock.mockReturnValue(FOCUS_SOUND_TRACKS);
});

/** Fire the shared element's `ended` handler — what the browser does when a
 * track finishes playing. */
function endTrack() {
  act(() => element.onEnded?.());
}

describe("useFocusSound", () => {
  it("opens on the head of the pool, paused, at the default volume (#180)", () => {
    // #180 removed the opening-track input: `Settings.focusSound` is a switch,
    // so there is nothing left that could name a different track and the hook
    // takes no positional argument at all.
    const { result } = renderHook(() => useFocusSound());
    expect(result.current.track?.id).toBe(FOCUS_SOUND_TRACKS[0].id);
    expect(result.current.playing).toBe(false);
    expect(result.current.volume).toBe(DEFAULT_FOCUS_VOLUME);
    expect(result.current.hasTracks).toBe(true);
  });

  it("play() lazily creates the playlist player (with volume) and starts it", () => {
    const { result } = renderHook(() => useFocusSound());
    act(() => result.current.play());
    expect(createPlaylistPlayer).toHaveBeenCalledTimes(1);
    expect(createPlaylistPlayer).toHaveBeenCalledWith(
      FOCUS_SOUND_TRACKS[0].src,
      expect.objectContaining({ volume: DEFAULT_FOCUS_VOLUME }),
    );
    expect(player.play).toHaveBeenCalled();
    expect(result.current.playing).toBe(true);
  });

  it("toggle() pauses when playing and resumes when paused", () => {
    const { result } = renderHook(() => useFocusSound());
    act(() => result.current.play());
    act(() => result.current.toggle());
    expect(player.pause).toHaveBeenCalled();
    expect(result.current.playing).toBe(false);
    act(() => result.current.toggle());
    expect(result.current.playing).toBe(true);
  });

  it("pause() then play() resume the SAME element — never load() (position preserved)", () => {
    const { result } = renderHook(() => useFocusSound());
    act(() => result.current.play());
    act(() => result.current.pause());
    expect(player.pause).toHaveBeenCalled();
    expect(result.current.playing).toBe(false);
    act(() => result.current.play());
    expect(result.current.playing).toBe(true);
    // Resumed the same element — no second createPlaylistPlayer, no stop(), and
    // crucially NO load() (which would reset currentTime to 0). play() is called
    // twice (initial + resume).
    expect(createPlaylistPlayer).toHaveBeenCalledTimes(1);
    expect(player.stop).not.toHaveBeenCalled();
    expect(player.load).not.toHaveBeenCalled();
    expect(player.play).toHaveBeenCalledTimes(2);
  });

  it("next()/prev() cycle the playlist via load() (wrapping), reusing one element", () => {
    const { result } = renderHook(() => useFocusSound());
    act(() => result.current.play()); // creates the element
    act(() => result.current.next());
    expect(result.current.track?.id).toBe(FOCUS_SOUND_TRACKS[1].id);
    expect(player.load).toHaveBeenLastCalledWith(FOCUS_SOUND_TRACKS[1].src);
    // prev from index 0 wraps to the last track.
    act(() => result.current.prev()); // back to 0
    act(() => result.current.prev()); // wrap to last
    const last = FOCUS_SOUND_TRACKS[FOCUS_SOUND_TRACKS.length - 1];
    expect(result.current.track?.id).toBe(last.id);
    // Only one audio element was ever created.
    expect(createPlaylistPlayer).toHaveBeenCalledTimes(1);
  });

  it("setVolume clamps and forwards to the player", () => {
    const { result } = renderHook(() => useFocusSound());
    act(() => result.current.play());
    act(() => result.current.setVolume(0.8));
    expect(player.setVolume).toHaveBeenLastCalledWith(0.8);
    expect(result.current.volume).toBe(0.8);
    act(() => result.current.setVolume(5));
    expect(player.setVolume).toHaveBeenLastCalledWith(1);
    expect(result.current.volume).toBe(1);
  });

  it("stop() halts playback and clears the playing flag", () => {
    const { result } = renderHook(() => useFocusSound());
    act(() => result.current.play());
    act(() => result.current.stop());
    expect(player.stop).toHaveBeenCalled();
    expect(result.current.playing).toBe(false);
  });

  it("stops the element on unmount", () => {
    const { result, unmount } = renderHook(() => useFocusSound());
    act(() => result.current.play());
    expect(player.stop).not.toHaveBeenCalled();
    unmount();
    expect(player.stop).toHaveBeenCalled();
  });
});

// #68 — the owner's complaint was "it repeats the same track". These cover the
// two halves of the fix: the playlist advances itself when a track ends, and it
// only wraps once every track in the pass has been heard — in either order.
describe("useFocusSound — auto-advance + no repeats until exhausted (#68)", () => {
  const N = FOCUS_SOUND_TRACKS.length;

  /** Play a whole pass (the seeded track plus N-1 auto-advances) and return the
   * ids in the order they were heard. */
  function playPass(result: { current: { track: { id: string } | null } }) {
    const heard = [result.current.track!.id];
    for (let i = 1; i < N; i++) {
      endTrack();
      heard.push(result.current.track!.id);
    }
    return heard;
  }

  it("a finished track auto-advances the playlist (no user tap needed)", () => {
    const { result } = renderHook(() => useFocusSound());
    act(() => result.current.play());
    expect(result.current.track?.id).toBe(FOCUS_SOUND_TRACKS[0].id);
    endTrack();
    // Advanced to the next track in the pass, on the SAME element.
    expect(result.current.track?.id).toBe(FOCUS_SOUND_TRACKS[1].id);
    expect(player.load).toHaveBeenLastCalledWith(FOCUS_SOUND_TRACKS[1].src);
    expect(createPlaylistPlayer).toHaveBeenCalledTimes(1);
  });

  it("in-order playback hears every track exactly once, then wraps to the start", () => {
    const { result } = renderHook(() => useFocusSound());
    act(() => result.current.play());
    const heard = playPass(result);
    expect(heard).toEqual(FOCUS_SOUND_TRACKS.map((t) => t.id));
    expect(new Set(heard).size).toBe(N);
    // Only NOW does it wrap — the pass is exhausted.
    endTrack();
    expect(result.current.track?.id).toBe(FOCUS_SOUND_TRACKS[0].id);
  });

  it("shuffled playback hears every track exactly once per pass (never twice)", () => {
    const { result } = renderHook(() => useFocusSound({ shuffle: true }));
    act(() => result.current.play());
    const heard = playPass(result);
    expect(new Set(heard).size).toBe(N);
    // Shuffled, not merely reordered by chance: the pass is dealt with the pool
    // head swapped into position 0, so a session still opens somewhere
    // predictable while everything after it is shuffled.
    expect(heard[0]).toBe(FOCUS_SOUND_TRACKS[0].id);
  });

  it("a shuffled pass reshuffles on exhaustion without repeating the track that just played", () => {
    // Repeat: a random-pick-per-advance implementation passes this only by luck.
    for (let attempt = 0; attempt < 25; attempt++) {
      const { result, unmount } = renderHook(() =>
        useFocusSound({ shuffle: true }),
      );
      act(() => result.current.play());
      const first = playPass(result);
      const last = first[first.length - 1];
      endTrack(); // pass exhausted → wrap into a fresh shuffle
      expect(result.current.track?.id).not.toBe(last);
      const second = [result.current.track!.id];
      for (let i = 1; i < N; i++) {
        endTrack();
        second.push(result.current.track!.id);
      }
      expect(new Set(second).size).toBe(N);
      unmount();
    }
  });

  // Duo review (!151): stepping BACK to the tail must not look like exhaustion.
  // The user went back one track — they haven't heard the rest of the pass yet,
  // so the next forward move owes them an unheard track, not a re-deal (which
  // could serve up what they just heard).
  it("in order: prev to the tail then forward plays an unheard track, not the head again", () => {
    const { result } = renderHook(() => useFocusSound());
    act(() => result.current.play());
    act(() => result.current.prev()); // head → tail of the same pass
    expect(result.current.track?.id).toBe(FOCUS_SOUND_TRACKS[N - 1].id);
    endTrack();
    expect(result.current.track?.id).toBe(FOCUS_SOUND_TRACKS[1].id);
  });

  it("shuffled: prev to the tail then forward keeps the pass (still no repeat until exhausted)", () => {
    for (let attempt = 0; attempt < 25; attempt++) {
      const { result, unmount } = renderHook(() =>
        useFocusSound({ shuffle: true }),
      );
      act(() => result.current.play());
      const heard = [result.current.track!.id];
      act(() => result.current.prev()); // head → tail
      heard.push(result.current.track!.id);
      // The remaining N-2 entries of the pass must still be the ones nobody has
      // heard: a re-deal here would repeat something.
      for (let i = 2; i < N; i++) {
        endTrack();
        heard.push(result.current.track!.id);
      }
      expect(new Set(heard).size).toBe(N);
      unmount();
    }
  });

  it("every session opens at the head, and one rotation brings it back (#180)", () => {
    // Until #180 a session could open mid-list, from the track stored in
    // settings, and the heard-set existed partly to make that pass behave. There
    // is no stored track any more, so the head is the only opening position —
    // and the pass invariant it guarded is exercised instead by the prev()-to-
    // the-tail tests below, which are now the only way to read a pass off-head.
    const { result } = renderHook(() => useFocusSound());
    act(() => result.current.play());
    const head = result.current.track!.id;
    expect(head).toBe(FOCUS_SOUND_TRACKS[0].id);
    const heard = [head];
    for (let i = 1; i < N; i++) {
      endTrack();
      heard.push(result.current.track!.id);
    }
    expect(new Set(heard).size).toBe(N);
    endTrack();
    expect(result.current.track?.id).toBe(head);
  });

  it("a track ending while the timer has it paused does not advance (#43 coupling)", () => {
    const { result } = renderHook(() => useFocusSound());
    act(() => result.current.play());
    act(() => result.current.pause());
    player.load.mockClear();
    endTrack();
    // Still on the same track, still paused, position untouched.
    expect(result.current.track?.id).toBe(FOCUS_SOUND_TRACKS[0].id);
    expect(result.current.playing).toBe(false);
    expect(player.load).not.toHaveBeenCalled();
  });

  it("a track ending after the session stopped the playlist does not restart it", () => {
    const { result } = renderHook(() => useFocusSound());
    act(() => result.current.play());
    act(() => result.current.stop());
    player.load.mockClear();
    endTrack();
    expect(result.current.track?.id).toBe(FOCUS_SOUND_TRACKS[0].id);
    expect(player.load).not.toHaveBeenCalled();
  });
});

describe("useFocusSound — shuffle toggle (#68)", () => {
  const N = FOCUS_SOUND_TRACKS.length;

  it("exposes the persisted preference as the initial shuffle state", () => {
    const off = renderHook(() => useFocusSound());
    expect(off.result.current.shuffle).toBe(false);
    const on = renderHook(() => useFocusSound({ shuffle: true }));
    expect(on.result.current.shuffle).toBe(true);
  });

  it("toggleShuffle flips the state and reports it for persistence", () => {
    const onShuffleChange = vi.fn();
    const { result } = renderHook(() => useFocusSound({ onShuffleChange }));
    act(() => result.current.toggleShuffle());
    expect(result.current.shuffle).toBe(true);
    expect(onShuffleChange).toHaveBeenLastCalledWith(true);
    act(() => result.current.toggleShuffle());
    expect(result.current.shuffle).toBe(false);
    expect(onShuffleChange).toHaveBeenLastCalledWith(false);
  });

  it("toggling shuffle never interrupts the track that's playing", () => {
    const { result } = renderHook(() => useFocusSound());
    act(() => result.current.play());
    player.load.mockClear();
    act(() => result.current.toggleShuffle());
    expect(result.current.track?.id).toBe(FOCUS_SOUND_TRACKS[0].id);
    expect(result.current.playing).toBe(true);
    // No load()/stop() — the current track keeps playing from its position; only
    // what comes NEXT changes.
    expect(player.load).not.toHaveBeenCalled();
    expect(player.stop).not.toHaveBeenCalled();
  });

  it("turning shuffle off returns the playlist to the in-order pass from here", () => {
    const { result } = renderHook(() => useFocusSound({ shuffle: true }));
    act(() => result.current.play());
    act(() => result.current.next()); // somewhere in the shuffled pass
    act(() => result.current.toggleShuffle()); // → in order
    const from = FOCUS_SOUND_TRACKS.findIndex(
      (t) => t.id === result.current.track!.id,
    );
    endTrack();
    expect(result.current.track?.id).toBe(
      FOCUS_SOUND_TRACKS[(from + 1) % N].id,
    );
  });
});

/**
 * #61 — the streamed catalog arrives after the session has already started, so
 * the playlist grows underneath a hook that is mid-track. The contract is the
 * one `toggleShuffle` already keeps: what is playing is never touched, only what
 * comes next.
 */
describe("useFocusSound — the catalog arriving mid-session (#61)", () => {
  const STREAMED = [
    {
      id: "catalog:paper-cranes.mp3",
      title: "Paper Cranes",
      category: "chillhop",
      categoryLabel: "Chillhop",
      src: "/api/focus-catalog/audio?track=paper-cranes.mp3",
    },
    {
      id: "catalog:bell-field.mp3",
      title: "Bell Field",
      category: "hybrid",
      categoryLabel: "Hybrid / world",
      src: "/api/focus-catalog/audio?track=bell-field.mp3",
    },
  ];
  const GROWN = [...FOCUS_SOUND_TRACKS, ...STREAMED];

  it("does not interrupt the track that is playing", () => {
    const { result, rerender } = renderHook(() => useFocusSound());
    act(() => result.current.play());
    const before = result.current.track;
    player.load.mockClear();

    useFocusCatalogMock.mockReturnValue(GROWN);
    rerender();

    expect(result.current.track).toBe(before);
    expect(result.current.playing).toBe(true);
    // No load() means no src swap and no position reset — the whole promise.
    expect(player.load).not.toHaveBeenCalled();
  });

  it("plays the streamed tracks once the pass reaches them", () => {
    const { result, rerender } = renderHook(() => useFocusSound());
    act(() => result.current.play());
    useFocusCatalogMock.mockReturnValue(GROWN);
    rerender();

    const heard = new Set<string>();
    for (let i = 0; i < GROWN.length; i++) {
      act(() => result.current.next());
      heard.add(result.current.track!.id);
    }
    expect(heard.has("catalog:paper-cranes.mp3")).toBe(true);
    expect(heard.has("catalog:bell-field.mp3")).toBe(true);
    // Still one pass: every track exactly once, nothing repeated.
    expect(heard.size).toBe(GROWN.length);
  });

  it("reports the grown length through hasTracks and the pass", () => {
    const { result, rerender } = renderHook(() => useFocusSound());
    expect(result.current.hasTracks).toBe(true);
    useFocusCatalogMock.mockReturnValue(GROWN);
    rerender();
    expect(result.current.hasTracks).toBe(true);
    expect(result.current.track?.id).toBe(FOCUS_SOUND_TRACKS[0].id);
  });

  it("keeps working when the catalog never arrives", () => {
    // The bundled-only path, which is what most instances run.
    const { result, rerender } = renderHook(() => useFocusSound());
    act(() => result.current.play());
    rerender();
    expect(result.current.track?.id).toBe("lofi_calm");
    expect(result.current.playing).toBe(true);
  });
});

/**
 * #70 — one category of the catalog = one playlist.
 *
 * Phase 1's progression model (pass, cursor, heard-set) already generalises to
 * any track list, so what is tested here is the boundary: which list the hook is
 * handed, and what happens when that list is REPLACED rather than extended.
 *
 * The distinction is the whole point. #61 grows the list underneath a playing
 * session and must never interrupt it; a category switch replaces it, and
 * continuing to play a track that is no longer in the playlist would be exactly
 * the "the picker says chillhop, the speakers say jazz hop" desync a user would
 * report as the feature not working.
 */
describe("useFocusSound — category pools (#70, multi-select #180)", () => {
  const streamed = (name: string, category: string, label: string) => ({
    id: `catalog:${name}.mp3`,
    title: name,
    category,
    categoryLabel: label,
    src: `/api/focus-catalog/audio?track=${name}.mp3`,
  });

  // Two categories with the SAME number of tracks, which is what makes the
  // desync below reachable: a length-keyed guard cannot see this swap.
  const GROWN = [
    ...FOCUS_SOUND_TRACKS,
    streamed("paper-cranes", "chillhop", "Chillhop"),
    streamed("terrace-dust", "jazzhop", "Jazz hop"),
  ];
  const chillhopTrack = FOCUS_SOUND_TRACKS.find(
    (t) => t.category === "chillhop",
  )!;
  const jazzhopTrack = FOCUS_SOUND_TRACKS.find(
    (t) => t.category === "jazzhop",
  )!;

  beforeEach(() => useFocusCatalogMock.mockReturnValue(GROWN));

  it("narrows the playlist to the selected category", () => {
    const { result } = renderHook(() =>
      useFocusSound({ categories: ["chillhop"] }),
    );
    expect(result.current.track?.id).toBe(chillhopTrack.id);
    expect(result.current.hasTracks).toBe(true);

    // A two-track pass: the streamed chillhop track, then back to the bundled
    // one. Nothing from another category can appear.
    act(() => result.current.next());
    expect(result.current.track?.id).toBe("catalog:paper-cranes.mp3");
    act(() => result.current.next());
    expect(result.current.track?.id).toBe(chillhopTrack.id);
  });

  it("draws the UNION of several selected categories, in catalogue order (#180)", () => {
    const { result } = renderHook(() =>
      useFocusSound({ categories: ["jazzhop", "chillhop"] }),
    );
    // Four tracks: the two bundled ones and the two streamed ones, read in the
    // catalogue's own order rather than grouped by category.
    const heard = [result.current.track!.id];
    for (let i = 0; i < 3; i++) {
      act(() => result.current.next());
      heard.push(result.current.track!.id);
    }
    expect(heard).toEqual([
      chillhopTrack.id,
      jazzhopTrack.id,
      "catalog:paper-cranes.mp3",
      "catalog:terrace-dust.mp3",
    ]);
  });

  it("is unaffected by the order the categories arrive in", () => {
    // The pool is a filter over the catalogue, so the two spellings are the same
    // selection — and the hook must not treat the reorder as a playlist change,
    // which would re-deal the pass under a playing session.
    const { result, rerender } = renderHook(
      ({ categories }: { categories: string[] }) =>
        useFocusSound({ categories }),
      { initialProps: { categories: ["chillhop", "jazzhop"] } },
    );
    act(() => result.current.play());
    player.load.mockClear();
    rerender({ categories: ["jazzhop", "chillhop"] });
    expect(result.current.track?.id).toBe(chillhopTrack.id);
    expect(player.load).not.toHaveBeenCalled();
  });

  it("does not re-deal the pass when the caller passes a fresh array each render", () => {
    // The realistic caller writes `categories={settings.focusSoundCategories}`,
    // and a `?? []` anywhere on that path makes a new array every render. If the
    // hook keyed its memo on identity, that alone would replace the playlist on
    // every render and restart the pass forever.
    const { result, rerender } = renderHook(() =>
      useFocusSound({ categories: ["chillhop"] }),
    );
    act(() => result.current.play());
    act(() => result.current.next());
    const before = result.current.track;
    player.load.mockClear();
    rerender();
    rerender();
    expect(result.current.track).toBe(before);
    expect(player.load).not.toHaveBeenCalled();
  });

  it("honours a category that has shrunk to one track", () => {
    // The store stopped answering under a stored selection. One chillhop track
    // is what the user asked for; all ten categories is not.
    useFocusCatalogMock.mockReturnValue(FOCUS_SOUND_TRACKS);
    const { result } = renderHook(() =>
      useFocusSound({ categories: ["chillhop"] }),
    );
    expect(result.current.track?.id).toBe(chillhopTrack.id);
    act(() => result.current.next());
    expect(result.current.track?.id).toBe(chillhopTrack.id);
  });

  it("falls back to the whole list for a selection nothing matches", () => {
    const { result } = renderHook(() =>
      useFocusSound({ categories: ["retired-slug"] }),
    );
    expect(result.current.track?.id).toBe(GROWN[0].id);
    // The full list is back, so a track from another category is reachable.
    const ids = new Set<string>();
    for (let i = 0; i < GROWN.length; i++) {
      act(() => result.current.next());
      ids.add(result.current.track!.id);
    }
    expect(ids.size).toBe(GROWN.length);
  });

  it("switching category mid-session keeps the LABEL on what is really playing (#181)", () => {
    // #180 fixed this desync by moving the ELEMENT to match the label. #181
    // reverses the direction — a stray tap must not silence you mid-bar — so the
    // label follows the element instead: the chillhop track goes on playing and
    // `track` goes on naming it. The thing that must never happen either way is
    // reporting a track that is not the one coming out of the speakers, and both
    // categories hold two tracks here, so a length-keyed guard still sees nothing.
    const { result, rerender } = renderHook(
      ({ category }: { category: string }) =>
        useFocusSound({ categories: category ? [category] : [] }),
      { initialProps: { category: "chillhop" } },
    );
    act(() => result.current.play());
    player.load.mockClear();

    rerender({ category: "jazzhop" });

    expect(result.current.track?.id).toBe(chillhopTrack.id);
    expect(player.load).not.toHaveBeenCalled();
    expect(result.current.playing).toBe(true);
  });

  it("switching category mid-session restarts the pass inside the new playlist", () => {
    const { result, rerender } = renderHook(
      ({ category }: { category: string }) =>
        useFocusSound({ categories: category ? [category] : [] }),
      { initialProps: { category: "chillhop" } },
    );
    act(() => result.current.play());
    act(() => result.current.next()); // exhaust the chillhop pass
    rerender({ category: "jazzhop" });

    // #181 — what is audible carries on (the streamed chillhop track), and then
    // a fresh two-track pass over jazz hop: no chillhop entry, no repeat, and no
    // early wrap from the OLD heard-set saying the pass was already exhausted.
    expect(result.current.track?.id).toBe("catalog:paper-cranes.mp3");
    const heard: string[] = [];
    act(() => result.current.next());
    heard.push(result.current.track!.id);
    act(() => result.current.next());
    heard.push(result.current.track!.id);
    expect(new Set(heard).size).toBe(2);
    expect(heard).toEqual([jazzhopTrack.id, "catalog:terrace-dust.mp3"]);
  });

  it("switching back to no category keeps playing what is already playing", () => {
    // Widening the playlist is the #61 case, not a replacement: the current
    // track is still in the list, so nothing may interrupt.
    const { result, rerender } = renderHook(
      ({ category }: { category: string | null }) =>
        useFocusSound({ categories: category ? [category] : [] }),
      { initialProps: { category: "chillhop" } as { category: string | null } },
    );
    act(() => result.current.play());
    player.load.mockClear();

    rerender({ category: null });

    expect(result.current.track?.id).toBe(chillhopTrack.id);
    expect(player.load).not.toHaveBeenCalled();
    expect(result.current.playing).toBe(true);
  });

  it("the catalog arriving under a selected category does not interrupt", () => {
    useFocusCatalogMock.mockReturnValue(FOCUS_SOUND_TRACKS);
    const { result, rerender } = renderHook(() =>
      useFocusSound({ categories: ["chillhop"] }),
    );
    act(() => result.current.play());
    player.load.mockClear();

    useFocusCatalogMock.mockReturnValue(GROWN);
    rerender();

    expect(result.current.track?.id).toBe(chillhopTrack.id);
    expect(player.load).not.toHaveBeenCalled();
    // ...and the pass now reaches the track that just arrived.
    act(() => result.current.next());
    expect(result.current.track?.id).toBe("catalog:paper-cranes.mp3");
  });
});

/**
 * #181 — the two things the in-session player asks of this hook: jump to a named
 * track, and survive the playlist being re-ticked underneath a playing session.
 */
describe("useFocusSound — jump + re-tick from the player (#181)", () => {
  const streamed = (name: string, category: string, label: string) => ({
    id: `catalog:${name}.mp3`,
    title: name,
    category,
    categoryLabel: label,
    src: `/api/focus-catalog/audio?track=${name}.mp3`,
  });

  const GROWN = [
    ...FOCUS_SOUND_TRACKS,
    streamed("paper-cranes", "chillhop", "Chillhop"),
    streamed("terrace-dust", "jazzhop", "Jazz hop"),
  ];
  const chillhopTrack = FOCUS_SOUND_TRACKS.find(
    (t) => t.category === "chillhop",
  )!;
  const jazzhopTrack = FOCUS_SOUND_TRACKS.find(
    (t) => t.category === "jazzhop",
  )!;

  beforeEach(() => useFocusCatalogMock.mockReturnValue(GROWN));

  it("exposes the catalogue and the resolved pool for the panel to draw", () => {
    const { result } = renderHook(() =>
      useFocusSound({ categories: ["chillhop"] }),
    );
    // The tick-list counts are read off the whole catalogue; the jump-list is
    // read off the pool. Both come from here so the panel never re-resolves one
    // of them from a second source that could disagree.
    expect(result.current.catalog).toBe(GROWN);
    expect(result.current.pool.map((t) => t.id)).toEqual([
      chillhopTrack.id,
      "catalog:paper-cranes.mp3",
    ]);
  });

  it("jumpTo() plays the named track and continues from there through the pool", () => {
    const { result } = renderHook(() => useFocusSound());
    act(() => result.current.play());
    player.load.mockClear();

    act(() => result.current.jumpTo(jazzhopTrack.id));

    expect(result.current.track?.id).toBe(jazzhopTrack.id);
    expect(player.load).toHaveBeenCalledWith(jazzhopTrack.src);
    // "…and continues from there": the next advance is the pool's NEXT entry,
    // not a restart at the head.
    act(() => result.current.next());
    expect(result.current.track?.id).toBe(GROWN[3].id);
  });

  it("jumpTo() under shuffle deals the chosen track to the head of a full pass", () => {
    // The `startAt` contract, reused rather than reinvented: every track still
    // appears exactly once, and the chosen one is first.
    const { result } = renderHook(() => useFocusSound({ shuffle: true }));
    act(() => result.current.play());
    act(() => result.current.jumpTo(jazzhopTrack.id));
    expect(result.current.track?.id).toBe(jazzhopTrack.id);

    const heard = new Set([result.current.track!.id]);
    for (let i = 1; i < GROWN.length; i++) {
      act(() => result.current.next());
      heard.add(result.current.track!.id);
    }
    expect(heard.size).toBe(GROWN.length);
  });

  it("jumpTo() leaves the transport alone — a paused session stays paused", () => {
    // Same contract as next()/prev(): the panel's click says "make this the
    // current track", never "start my music". Starting it would also break the
    // #43 coupling, which is the only thing allowed to resume audio mid-session.
    const { result } = renderHook(() => useFocusSound());
    act(() => result.current.jumpTo(jazzhopTrack.id));
    expect(result.current.track?.id).toBe(jazzhopTrack.id);
    expect(result.current.playing).toBe(false);
    expect(player.play).not.toHaveBeenCalled();
  });

  it("jumpTo() ignores a track that is not in the pool", () => {
    const { result } = renderHook(() =>
      useFocusSound({ categories: ["chillhop"] }),
    );
    act(() => result.current.play());
    player.load.mockClear();

    act(() => result.current.jumpTo(jazzhopTrack.id));
    act(() => result.current.jumpTo("no-such-track"));

    expect(result.current.track?.id).toBe(chillhopTrack.id);
    expect(player.load).not.toHaveBeenCalled();
  });

  it("unticking the playing track's playlist does not cut the audio", () => {
    // The whole point: a stray tap must not silence you mid-bar. The track
    // finishes; only what comes AFTER it is drawn from the new pool.
    const { result, rerender } = renderHook(
      ({ categories }: { categories: string[] }) =>
        useFocusSound({ categories }),
      { initialProps: { categories: ["chillhop", "jazzhop"] } },
    );
    act(() => result.current.play());
    expect(result.current.track?.id).toBe(chillhopTrack.id);
    player.load.mockClear();

    rerender({ categories: ["jazzhop"] });

    expect(player.load).not.toHaveBeenCalled();
    expect(player.pause).not.toHaveBeenCalled();
    expect(player.stop).not.toHaveBeenCalled();
    expect(result.current.playing).toBe(true);
    // …and it still says what is audible, rather than a jazz hop track it is not
    // playing.
    expect(result.current.track?.id).toBe(chillhopTrack.id);
  });

  it("the next advance after an untick comes from the new pool", () => {
    const { result, rerender } = renderHook(
      ({ categories }: { categories: string[] }) =>
        useFocusSound({ categories }),
      { initialProps: { categories: ["chillhop", "jazzhop"] } },
    );
    act(() => result.current.play());
    rerender({ categories: ["jazzhop"] });

    act(() => result.current.next());
    expect(result.current.track?.id).toBe(jazzhopTrack.id);
    expect(player.load).toHaveBeenCalledWith(jazzhopTrack.src);
    // The pass over the new pool is whole — both jazz hop tracks, no repeat.
    act(() => result.current.next());
    expect(result.current.track?.id).toBe("catalog:terrace-dust.mp3");
  });

  it("prev() after an untick goes to the new pool's TAIL, like any other run off the head", () => {
    // The pass dealt over the new pool has not been entered yet (cursor -1), so
    // prev() runs off its head. #68's rule for that is "go to the tail of the
    // SAME pass — a deliberate user tap is never a reason to re-deal", and an
    // unticked track is not an exception to it. Stated as a test because the
    // alternative (snapping to the head) would make prev() and next() do the
    // same thing here, which is the one answer that is definitely wrong.
    const { result, rerender } = renderHook(
      ({ categories }: { categories: string[] }) =>
        useFocusSound({ categories }),
      { initialProps: { categories: ["chillhop", "jazzhop"] } },
    );
    act(() => result.current.play());
    rerender({ categories: ["jazzhop"] });
    // Orphaned: still naming the chillhop track the element is really on.
    expect(result.current.track?.id).toBe(chillhopTrack.id);

    act(() => result.current.prev());

    expect(result.current.track?.id).toBe("catalog:terrace-dust.mp3");
    expect(player.load).toHaveBeenCalledWith(
      "/api/focus-catalog/audio?track=terrace-dust.mp3",
    );
  });

  it("a track ENDING after an untick advances into the new pool", () => {
    // The realistic path: the user unticks and then simply lets the track run
    // out. The element's own `ended` has to land in the new pool, not replay
    // something that is no longer in it.
    const { result, rerender } = renderHook(
      ({ categories }: { categories: string[] }) =>
        useFocusSound({ categories }),
      { initialProps: { categories: ["chillhop", "jazzhop"] } },
    );
    act(() => result.current.play());
    rerender({ categories: ["jazzhop"] });

    endTrack();

    expect(result.current.track?.id).toBe(jazzhopTrack.id);
  });

  it("re-ticking the playlist while its track is still audible re-adopts it", () => {
    // The switch must never be destructive, so untick-then-tick has to land back
    // where it started: still playing, still named, and the pass re-dealt AROUND
    // it rather than restarted.
    const { result, rerender } = renderHook(
      ({ categories }: { categories: string[] }) =>
        useFocusSound({ categories }),
      { initialProps: { categories: ["chillhop", "jazzhop"] } },
    );
    act(() => result.current.play());
    rerender({ categories: ["jazzhop"] });
    player.load.mockClear();

    rerender({ categories: ["chillhop", "jazzhop"] });

    expect(player.load).not.toHaveBeenCalled();
    expect(result.current.playing).toBe(true);
    expect(result.current.track?.id).toBe(chillhopTrack.id);
    // Re-adopted, not orphaned: the advance continues through the pool from
    // where the current track sits, rather than from its head.
    act(() => result.current.next());
    expect(result.current.track?.id).toBe(jazzhopTrack.id);
  });

  it("unticking before anything has played opens the new pool at its head", () => {
    // No element yet means there is nothing to protect, and pretending a silent
    // session is mid-track would leave `track` naming something the next Start
    // would not play.
    const { result, rerender } = renderHook(
      ({ categories }: { categories: string[] }) =>
        useFocusSound({ categories }),
      { initialProps: { categories: ["chillhop", "jazzhop"] } },
    );
    rerender({ categories: ["jazzhop"] });
    expect(result.current.track?.id).toBe(jazzhopTrack.id);

    act(() => result.current.play());
    expect(createPlaylistPlayer).toHaveBeenCalledWith(
      jazzhopTrack.src,
      expect.anything(),
    );
  });

  it("toggling shuffle while an unticked track is still audible does not interrupt it", () => {
    const { result, rerender } = renderHook(
      ({ categories }: { categories: string[] }) =>
        useFocusSound({ categories }),
      { initialProps: { categories: ["chillhop", "jazzhop"] } },
    );
    act(() => result.current.play());
    rerender({ categories: ["jazzhop"] });
    player.load.mockClear();

    act(() => result.current.toggleShuffle());

    expect(player.load).not.toHaveBeenCalled();
    expect(result.current.track?.id).toBe(chillhopTrack.id);
    // The re-dealt pass still covers the new pool in full.
    const heard = new Set<string>();
    act(() => result.current.next());
    heard.add(result.current.track!.id);
    act(() => result.current.next());
    heard.add(result.current.track!.id);
    expect(heard).toEqual(
      new Set([jazzhopTrack.id, "catalog:terrace-dust.mp3"]),
    );
  });

  it("jumping clears the unticked track and rejoins the pool", () => {
    const { result, rerender } = renderHook(
      ({ categories }: { categories: string[] }) =>
        useFocusSound({ categories }),
      { initialProps: { categories: ["chillhop", "jazzhop"] } },
    );
    act(() => result.current.play());
    rerender({ categories: ["jazzhop"] });

    act(() => result.current.jumpTo("catalog:terrace-dust.mp3"));

    expect(result.current.track?.id).toBe("catalog:terrace-dust.mp3");
    expect(player.load).toHaveBeenCalledWith(
      "/api/focus-catalog/audio?track=terrace-dust.mp3",
    );
    act(() => result.current.next());
    expect(result.current.track?.id).toBe(jazzhopTrack.id);
  });
});
