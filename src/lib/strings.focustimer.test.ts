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
    expect(t("focusSettings.soundOff", "plain")).toBe("Off");
    expect(t("focusSettings.soundLofiCalm", "plain")).toBe("Lo-fi (calm)");
  });

  it("#43 — lo-fi picker + mini-player control labels resolve; plain stays plain", () => {
    expect(t("focusSettings.preview", "plain")).toBe("Preview");
    expect(t("focusSettings.stopPreview", "plain")).toBe("Stop preview");
    expect(t("focus.sound.play", "plain")).toBe("Play focus sound");
    expect(t("focus.sound.pause", "plain")).toBe("Pause focus sound");
    expect(t("focus.sound.next", "plain")).toBe("Next track");
    expect(t("focus.sound.prev", "plain")).toBe("Previous track");
    expect(t("focus.sound.volume", "plain")).toBe("Volume");
    // Region label picks up a playful headphones anchor only in playful voice.
    expect(t("focus.sound.region", "plain")).toBe("Focus sound");
    expect(t("focus.sound.region", "playful")).toBe("🎧 Focus sound");
  });
});
