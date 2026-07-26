// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";

// Fake player instance shared by the mocked createLoopPlayer. Declared via
// vi.hoisted so it exists when the (hoisted) vi.mock factory runs.
const { createLoopPlayer, player } = vi.hoisted(() => {
  const player = {
    play: vi.fn(),
    pause: vi.fn(),
    stop: vi.fn(),
    setVolume: vi.fn(),
    load: vi.fn(),
  };
  const createLoopPlayer = vi.fn(
    (_src: string, _opts?: { volume?: number }) => player,
  );
  return { createLoopPlayer, player };
});

vi.mock("@/lib/focus-sounds", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/focus-sounds")>();
  return { ...actual, createLoopPlayer };
});

import { useFocusSound, DEFAULT_FOCUS_VOLUME } from "@/lib/use-focus-sound";
import { FOCUS_SOUND_TRACKS } from "@/lib/focus-sounds";

beforeEach(() => vi.clearAllMocks());

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

  it("play() lazily creates the looping player (with volume) and starts it", () => {
    const { result } = renderHook(() => useFocusSound("lofi_calm"));
    act(() => result.current.play());
    expect(createLoopPlayer).toHaveBeenCalledTimes(1);
    expect(createLoopPlayer).toHaveBeenCalledWith(FOCUS_SOUND_TRACKS[0].src, {
      volume: DEFAULT_FOCUS_VOLUME,
    });
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
    expect(createLoopPlayer).toHaveBeenCalledTimes(1);
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
    unmount();
    expect(player.stop).toHaveBeenCalled();
  });
});
