import { describe, it, expect } from "vitest";
import { t } from "@/lib/strings";

describe("focus-timer redesign strings (MR ②)", () => {
  it("timer readout + controls resolve; plain stays free of decorative emoji", () => {
    expect(t("focus.timer.completeStep", "plain")).toBe("✓ Complete step");
    expect(t("focus.timer.of", "plain")).toBe("of");
    expect(t("focus.timer.steps", "plain")).toBe("steps");
  });

  it("the first-run hint resolves in both voices", () => {
    expect(t("focus.tip.body", "plain")).toMatch(/make this timer yours/i);
    expect(t("focus.tip.cta", "plain")).toBe("Open settings →");
    expect(t("focus.tip.body", "playful")).not.toBe(
      t("focus.tip.body", "plain"),
    );
  });

  it("settings labels resolve; the heading gets a playful emoji anchor only in playful", () => {
    expect(t("focusSettings.heading", "plain")).toBe("Focus timer");
    expect(t("focusSettings.heading", "playful")).toBe("⏱️ Focus timer");
    expect(t("focusSettings.styleMug", "plain")).toBe("Mug");
  });

  it("#43 — mini-player control labels resolve; plain stays plain", () => {
    expect(t("focus.sound.play", "plain")).toBe("Play focus sound");
    expect(t("focus.sound.pause", "plain")).toBe("Pause focus sound");
    expect(t("focus.sound.next", "plain")).toBe("Next track");
    expect(t("focus.sound.prev", "plain")).toBe("Previous track");
    expect(t("focus.sound.volume", "plain")).toBe("Volume");
    // Region label picks up a playful headphones anchor only in playful voice.
    expect(t("focus.sound.region", "plain")).toBe("Focus sound");
    expect(t("focus.sound.region", "playful")).toBe("🎧 Focus sound");
  });

  it("#68 — the settings copy promises a playlist, never a looping track", () => {
    // Nothing loops a single file any more, so the hint must not say it does.
    expect(t("focusSettings.soundHint", "plain")).toMatch(/playlist/i);
    for (const voice of ["plain", "playful"] as const) {
      expect(t("focusSettings.soundHint", voice)).not.toMatch(/loop/i);
    }
  });

  it("#180 — the switch's hint says where the playlist controls went", () => {
    // The removal's only mitigation. It has to name BOTH things that moved —
    // playlists and individual tracks — and say they are in the player, or the
    // simplification reads as a feature that was taken away.
    for (const voice of ["plain", "playful"] as const) {
      const hint = t("focusSettings.soundPlayerHint", voice);
      expect(hint).toMatch(/playlist/i);
      expect(hint).toMatch(/track/i);
      expect(hint).toMatch(/player/i);
    }
  });

  it("#65 — the pause-coupling setting names its consequence and keeps plain emoji-free", () => {
    expect(t("focusSettings.pauseTogether", "plain")).toBe(
      "Pause music and timer together",
    );
    // Same behavioural-toggle convention as the alarm: playful gets a glyph
    // anchor, plain stays plain.
    expect(t("focusSettings.pauseTogether", "playful")).toBe(
      "⏸️ Pause music and timer together",
    );
    for (const voice of ["plain", "playful"] as const) {
      // The hint must say what it costs you, not just what it does.
      expect(t("focusSettings.pauseTogetherHint", voice)).toMatch(
        /also pauses the timer/i,
      );
      expect(t("focusSettings.pauseTogetherHint", voice)).toMatch(
        /keeps running/i,
      );
    }
  });

  it("#65 — the coupled transport labels resolve identically in both voices (functional control)", () => {
    for (const voice of ["plain", "playful"] as const) {
      expect(t("focus.sound.pauseTogether", voice)).toBe(
        "Pause music and timer",
      );
      expect(t("focus.sound.resumeTogether", voice)).toBe(
        "Resume music and timer",
      );
    }
  });

  it("#68 — shuffle label + state text resolve identically in both voices (functional control)", () => {
    expect(t("focus.sound.shuffle", "plain")).toBe("Shuffle tracks");
    expect(t("focus.sound.shuffle", "playful")).toBe("Shuffle tracks");
    expect(t("focus.sound.shuffled", "plain")).toBe("Shuffled");
    expect(t("focus.sound.shuffled", "playful")).toBe("Shuffled");
  });
});
