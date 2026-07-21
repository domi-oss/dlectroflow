// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// A fake HTMLAudioElement — records construction + play/pause.
const audioPlay = vi.fn().mockResolvedValue(undefined);
const audioPause = vi.fn();
class FakeAudio {
  src: string;
  loop = false;
  currentTime = 0;
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

describe("focus-sounds — FOCUS_SOUND_SRC", () => {
  it("maps off → null and lofi_calm → the bundled asset", async () => {
    const { FOCUS_SOUND_SRC } = await import("@/lib/focus-sounds");
    expect(FOCUS_SOUND_SRC.off).toBeNull();
    expect(FOCUS_SOUND_SRC.lofi_calm).toBe("/audio/lofi-calm.mp3");
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
    const p = createLoopPlayer("/audio/lofi-calm.mp3");
    p.play();
    expect(audioPlay).toHaveBeenCalled();
    p.pause();
    expect(audioPause).toHaveBeenCalledTimes(1);
    p.stop();
    expect(audioPause).toHaveBeenCalledTimes(2);
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
