// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";

// Fake player instance shared by the mocked createPlaylistPlayer. Declared via
// vi.hoisted so it exists when the (hoisted) vi.mock factory runs. `element`
// also captures the onEnded handler the hook installs, so tests can fire a
// track-end the way the real <audio> element would (#68).
const { createPlaylistPlayer, player, element } = vi.hoisted(() => {
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
  return { createPlaylistPlayer, player, element };
});

vi.mock("@/lib/focus-sounds", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/focus-sounds")>();
  return { ...actual, createPlaylistPlayer };
});

import { useFocusSound, DEFAULT_FOCUS_VOLUME } from "@/lib/use-focus-sound";
import { FOCUS_SOUND_TRACKS } from "@/lib/focus-sounds";

beforeEach(() => {
  vi.clearAllMocks();
  element.onEnded = undefined;
});

/** Fire the shared element's `ended` handler — what the browser does when a
 * track finishes playing. */
function endTrack() {
  act(() => element.onEnded?.());
}

describe("useFocusSound", () => {
  it("seeds the current track from the initial sound, paused, at the default volume", () => {
    const { result } = renderHook(() => useFocusSound("lofi_calm"));
    expect(result.current.track?.id).toBe("lofi_calm");
    expect(result.current.playing).toBe(false);
    expect(result.current.volume).toBe(DEFAULT_FOCUS_VOLUME);
    expect(result.current.hasTracks).toBe(true);
  });

  it("falls back to the first track when initial sound is off/unknown", () => {
    const { result } = renderHook(() => useFocusSound("off"));
    expect(result.current.track?.id).toBe(FOCUS_SOUND_TRACKS[0].id);
  });

  it("play() lazily creates the playlist player (with volume) and starts it", () => {
    const { result } = renderHook(() => useFocusSound("lofi_calm"));
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
    const { result } = renderHook(() => useFocusSound("lofi_calm"));
    act(() => result.current.play());
    act(() => result.current.toggle());
    expect(player.pause).toHaveBeenCalled();
    expect(result.current.playing).toBe(false);
    act(() => result.current.toggle());
    expect(result.current.playing).toBe(true);
  });

  it("pause() then play() resume the SAME element — never load() (position preserved)", () => {
    const { result } = renderHook(() => useFocusSound("lofi_calm"));
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
    const { result } = renderHook(() => useFocusSound("lofi_calm"));
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
    const { result } = renderHook(() => useFocusSound("lofi_calm"));
    act(() => result.current.play());
    act(() => result.current.setVolume(0.8));
    expect(player.setVolume).toHaveBeenLastCalledWith(0.8);
    expect(result.current.volume).toBe(0.8);
    act(() => result.current.setVolume(5));
    expect(player.setVolume).toHaveBeenLastCalledWith(1);
    expect(result.current.volume).toBe(1);
  });

  it("stop() halts playback and clears the playing flag", () => {
    const { result } = renderHook(() => useFocusSound("lofi_calm"));
    act(() => result.current.play());
    act(() => result.current.stop());
    expect(player.stop).toHaveBeenCalled();
    expect(result.current.playing).toBe(false);
  });

  it("stops the element on unmount", () => {
    const { result, unmount } = renderHook(() => useFocusSound("lofi_calm"));
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
    const { result } = renderHook(() => useFocusSound("lofi_calm"));
    act(() => result.current.play());
    expect(result.current.track?.id).toBe(FOCUS_SOUND_TRACKS[0].id);
    endTrack();
    // Advanced to the next track in the pass, on the SAME element.
    expect(result.current.track?.id).toBe(FOCUS_SOUND_TRACKS[1].id);
    expect(player.load).toHaveBeenLastCalledWith(FOCUS_SOUND_TRACKS[1].src);
    expect(createPlaylistPlayer).toHaveBeenCalledTimes(1);
  });

  it("in-order playback hears every track exactly once, then wraps to the start", () => {
    const { result } = renderHook(() => useFocusSound("lofi_calm"));
    act(() => result.current.play());
    const heard = playPass(result);
    expect(heard).toEqual(FOCUS_SOUND_TRACKS.map((t) => t.id));
    expect(new Set(heard).size).toBe(N);
    // Only NOW does it wrap — the pass is exhausted.
    endTrack();
    expect(result.current.track?.id).toBe(FOCUS_SOUND_TRACKS[0].id);
  });

  it("shuffled playback hears every track exactly once per pass (never twice)", () => {
    const { result } = renderHook(() =>
      useFocusSound("lofi_calm", { shuffle: true }),
    );
    act(() => result.current.play());
    const heard = playPass(result);
    expect(new Set(heard).size).toBe(N);
    // Shuffled, not merely reordered by chance: the pass still starts on the
    // track the user chose in settings.
    expect(heard[0]).toBe(FOCUS_SOUND_TRACKS[0].id);
  });

  it("a shuffled pass reshuffles on exhaustion without repeating the track that just played", () => {
    // Repeat: a random-pick-per-advance implementation passes this only by luck.
    for (let attempt = 0; attempt < 25; attempt++) {
      const { result, unmount } = renderHook(() =>
        useFocusSound("lofi_calm", { shuffle: true }),
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

  it("a track ending while the timer has it paused does not advance (#43 coupling)", () => {
    const { result } = renderHook(() => useFocusSound("lofi_calm"));
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
    const { result } = renderHook(() => useFocusSound("lofi_calm"));
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
    const off = renderHook(() => useFocusSound("lofi_calm"));
    expect(off.result.current.shuffle).toBe(false);
    const on = renderHook(() => useFocusSound("lofi_calm", { shuffle: true }));
    expect(on.result.current.shuffle).toBe(true);
  });

  it("toggleShuffle flips the state and reports it for persistence", () => {
    const onShuffleChange = vi.fn();
    const { result } = renderHook(() =>
      useFocusSound("lofi_calm", { onShuffleChange }),
    );
    act(() => result.current.toggleShuffle());
    expect(result.current.shuffle).toBe(true);
    expect(onShuffleChange).toHaveBeenLastCalledWith(true);
    act(() => result.current.toggleShuffle());
    expect(result.current.shuffle).toBe(false);
    expect(onShuffleChange).toHaveBeenLastCalledWith(false);
  });

  it("toggling shuffle never interrupts the track that's playing", () => {
    const { result } = renderHook(() => useFocusSound("lofi_calm"));
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
    const { result } = renderHook(() =>
      useFocusSound("lofi_calm", { shuffle: true }),
    );
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
