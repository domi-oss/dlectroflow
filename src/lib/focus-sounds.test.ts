// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { FocusSound } from "@/lib/constants";

// A fake HTMLAudioElement — records construction + play/pause + mutations.
const audioPlay = vi.fn().mockResolvedValue(undefined);
const audioPause = vi.fn();
class FakeAudio {
  src: string;
  loop = false;
  currentTime = 0;
  volume = 1;
  onended: (() => void) | null = null;
  play = audioPlay;
  pause = audioPause;
  constructor(src: string) {
    this.src = src;
  }
}

const vibrate = vi.fn();
const wakeRelease = vi.fn().mockResolvedValue(undefined);
const wakeRequest = vi.fn().mockResolvedValue({ release: wakeRelease });

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("Audio", FakeAudio as unknown as typeof Audio);
  vi.stubGlobal("navigator", { vibrate, wakeLock: { request: wakeRequest } });
});
afterEach(() => vi.unstubAllGlobals());

describe("focus-sounds — FOCUS_SOUND_SRC + track catalog", () => {
  it("maps off → null and lofi_calm → the bundled ambient track (placeholder replaced)", async () => {
    const { FOCUS_SOUND_SRC } = await import("@/lib/focus-sounds");
    expect(FOCUS_SOUND_SRC.off).toBeNull();
    expect(FOCUS_SOUND_SRC.lofi_calm).toBe("/audio/lofi/aurora-on-mute.mp3");
    // The dead silent placeholder must no longer be referenced.
    expect(Object.values(FOCUS_SOUND_SRC)).not.toContain(
      "/audio/lofi-calm.mp3",
    );
  });

  it("has one curated track per non-off FocusSound value, all under /audio/lofi/", async () => {
    const { FOCUS_SOUND_TRACKS, FOCUS_SOUND_SRC } =
      await import("@/lib/focus-sounds");
    const nonOff = Object.values(FocusSound).filter(
      (v) => v !== FocusSound.Off,
    );
    // Every non-off enum value is a real track, and vice-versa.
    expect(FOCUS_SOUND_TRACKS.map((t) => t.id).sort()).toEqual(
      [...nonOff].sort(),
    );
    for (const t of FOCUS_SOUND_TRACKS) {
      expect(t.src).toMatch(/^\/audio\/lofi\/.+\.mp3$/);
      expect(t.title.length).toBeGreaterThan(0);
      expect(t.categoryLabel.length).toBeGreaterThan(0);
      expect(FOCUS_SOUND_SRC[t.id]).toBe(t.src);
    }
    // 10 open-lofi categories, one track each.
    expect(new Set(FOCUS_SOUND_TRACKS.map((t) => t.category)).size).toBe(
      FOCUS_SOUND_TRACKS.length,
    );
  });
});

describe("focus-sounds — pure playlist helpers", () => {
  it("focusTrackById / focusTrackIndex resolve real tracks and reject off/unknown", async () => {
    const { focusTrackById, focusTrackIndex, FOCUS_SOUND_TRACKS } =
      await import("@/lib/focus-sounds");
    expect(focusTrackById(FocusSound.LofiCalm)?.id).toBe(FocusSound.LofiCalm);
    expect(focusTrackById("off")).toBeUndefined();
    expect(focusTrackById("nope")).toBeUndefined();
    expect(focusTrackIndex(FOCUS_SOUND_TRACKS[0].id)).toBe(0);
    expect(focusTrackIndex("off")).toBe(-1);
  });

  it("next/prev cycle the playlist and wrap around", async () => {
    const { nextFocusTrackId, prevFocusTrackId, FOCUS_SOUND_TRACKS } =
      await import("@/lib/focus-sounds");
    const ids = FOCUS_SOUND_TRACKS.map((t) => t.id);
    const first = ids[0];
    const last = ids[ids.length - 1];
    expect(nextFocusTrackId(first)).toBe(ids[1]);
    expect(nextFocusTrackId(last)).toBe(first); // wrap forward
    expect(prevFocusTrackId(first)).toBe(last); // wrap back
    expect(prevFocusTrackId(ids[1])).toBe(first);
  });

  it("next/prev fall back to first/last when given off/unknown", async () => {
    const { nextFocusTrackId, prevFocusTrackId, FOCUS_SOUND_TRACKS } =
      await import("@/lib/focus-sounds");
    const ids = FOCUS_SOUND_TRACKS.map((t) => t.id);
    expect(nextFocusTrackId("off")).toBe(ids[0]);
    expect(prevFocusTrackId("off")).toBe(ids[ids.length - 1]);
  });

  it("clampVolume constrains to [0,1] and defaults NaN to 1", async () => {
    const { clampVolume } = await import("@/lib/focus-sounds");
    expect(clampVolume(0.5)).toBe(0.5);
    expect(clampVolume(-3)).toBe(0);
    expect(clampVolume(9)).toBe(1);
    expect(clampVolume(Number.NaN)).toBe(1);
  });
});

describe("createAlarm", () => {
  it("plays the chime from the start and vibrates on play()", async () => {
    const { createAlarm } = await import("@/lib/focus-sounds");
    createAlarm().play();
    expect(audioPlay).toHaveBeenCalled();
    expect(vibrate).toHaveBeenCalled();
  });
});

describe("createLoopPlayer", () => {
  it("loops, and play/pause/stop drive the element", async () => {
    const { createLoopPlayer } = await import("@/lib/focus-sounds");
    const p = createLoopPlayer("/audio/lofi/aurora-on-mute.mp3");
    p.play();
    expect(audioPlay).toHaveBeenCalled();
    p.pause();
    expect(audioPause).toHaveBeenCalledTimes(1);
    p.stop();
    expect(audioPause).toHaveBeenCalledTimes(2);
  });

  it("setVolume clamps and initial volume is applied", async () => {
    const { createLoopPlayer } = await import("@/lib/focus-sounds");
    const captured: FakeAudio[] = [];
    vi.stubGlobal(
      "Audio",
      class extends FakeAudio {
        constructor(src: string) {
          super(src);
          captured.push(this);
        }
      } as unknown as typeof Audio,
    );
    const p = createLoopPlayer("/audio/lofi/aurora-on-mute.mp3", {
      volume: 0.3,
    });
    expect(captured[0].volume).toBe(0.3);
    p.setVolume(2); // clamps to 1
    expect(captured[0].volume).toBe(1);
  });

  it("play() after pause() resumes from the current position (no currentTime reset)", async () => {
    const { createLoopPlayer } = await import("@/lib/focus-sounds");
    const captured: FakeAudio[] = [];
    vi.stubGlobal(
      "Audio",
      class extends FakeAudio {
        constructor(src: string) {
          super(src);
          captured.push(this);
        }
      } as unknown as typeof Audio,
    );
    const p = createLoopPlayer("/audio/lofi/aurora-on-mute.mp3");
    p.play();
    // Simulate playback progress, then a timer-driven pause + resume.
    captured[0].currentTime = 42;
    p.pause();
    expect(captured[0].currentTime).toBe(42);
    p.play();
    // Resume must NOT rewind — play() leaves currentTime untouched.
    expect(captured[0].currentTime).toBe(42);
  });

  it("stop() rewinds to the start (session-end semantics)", async () => {
    const { createLoopPlayer } = await import("@/lib/focus-sounds");
    const captured: FakeAudio[] = [];
    vi.stubGlobal(
      "Audio",
      class extends FakeAudio {
        constructor(src: string) {
          super(src);
          captured.push(this);
        }
      } as unknown as typeof Audio,
    );
    const p = createLoopPlayer("/audio/lofi/aurora-on-mute.mp3");
    p.play();
    captured[0].currentTime = 30;
    p.stop();
    expect(captured[0].currentTime).toBe(0);
  });

  it("load() swaps the source and resumes only when playing", async () => {
    const { createLoopPlayer } = await import("@/lib/focus-sounds");
    const captured: FakeAudio[] = [];
    vi.stubGlobal(
      "Audio",
      class extends FakeAudio {
        constructor(src: string) {
          super(src);
          captured.push(this);
        }
      } as unknown as typeof Audio,
    );
    const p = createLoopPlayer("/audio/lofi/aurora-on-mute.mp3");
    // Not playing yet: load swaps src but does not auto-play.
    p.load("/audio/lofi/3-am-echoes.mp3");
    expect(captured[0].src).toBe("/audio/lofi/3-am-echoes.mp3");
    expect(audioPlay).not.toHaveBeenCalled();
    // Now playing: load swaps src AND resumes.
    p.play();
    audioPlay.mockClear();
    p.load("/audio/lofi/cafe-da-tarde.mp3");
    expect(captured[0].src).toBe("/audio/lofi/cafe-da-tarde.mp3");
    expect(audioPlay).toHaveBeenCalled();
  });
});

describe("createPreviewPlayer", () => {
  it("plays one source and stopping pauses it; a second preview replaces the first", async () => {
    const { createPreviewPlayer } = await import("@/lib/focus-sounds");
    const preview = createPreviewPlayer();
    preview.play("/audio/lofi/aurora-on-mute.mp3");
    expect(audioPlay).toHaveBeenCalledTimes(1);
    preview.play("/audio/lofi/3-am-echoes.mp3"); // stops+replaces
    expect(audioPause).toHaveBeenCalled();
    expect(audioPlay).toHaveBeenCalledTimes(2);
    const pausesBeforeStop = audioPause.mock.calls.length;
    preview.stop();
    expect(audioPause.mock.calls.length).toBe(pausesBeforeStop + 1);
  });
});

describe("acquireWakeLock", () => {
  it("requests a screen wake lock and releases via the guard", async () => {
    const { acquireWakeLock } = await import("@/lib/focus-sounds");
    const guard = await acquireWakeLock();
    expect(wakeRequest).toHaveBeenCalledWith("screen");
    guard.release();
    expect(wakeRelease).toHaveBeenCalled();
  });

  it("degrades to a no-op guard when the Wake Lock API is unavailable", async () => {
    vi.stubGlobal("navigator", {}); // no wakeLock
    const { acquireWakeLock } = await import("@/lib/focus-sounds");
    const guard = await acquireWakeLock();
    expect(() => guard.release()).not.toThrow();
    expect(wakeRequest).not.toHaveBeenCalled();
  });
});
