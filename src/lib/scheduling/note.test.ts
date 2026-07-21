import { describe, it, expect } from "vitest";
import { focusUrl, buildScheduleNote } from "./note";

describe("focusUrl", () => {
  it("deep-links to the specific step when a stepId is given", () => {
    expect(focusUrl("https://app.example", "step_123")).toBe(
      "https://app.example/focus/step_123",
    );
  });
  it("links to the focus launcher when there is no step", () => {
    expect(focusUrl("https://app.example")).toBe("https://app.example/focus");
    expect(focusUrl("https://app.example", null)).toBe(
      "https://app.example/focus",
    );
  });
  it("tolerates a trailing slash on the origin", () => {
    expect(focusUrl("https://app.example/", "s1")).toBe(
      "https://app.example/focus/s1",
    );
  });
});

describe("buildScheduleNote", () => {
  it("plain voice: prompt line + the absolute step deep-link", () => {
    const note = buildScheduleNote({
      origin: "https://app.example",
      voice: "plain",
      stepId: "s1",
    });
    expect(note).toContain("https://app.example/focus/s1");
    expect(note).toMatch(/focus timer/i);
    expect(note).not.toContain("🍽️"); // plain voice has no decorative emoji
  });

  it("playful voice: uses the playful prompt but the same URL", () => {
    const note = buildScheduleNote({
      origin: "https://app.example",
      voice: "playful",
      stepId: "s1",
    });
    expect(note).toContain("🍽️");
    expect(note).toContain("https://app.example/focus/s1");
  });

  it("no step → launcher URL (never a bare /focus/)", () => {
    const note = buildScheduleNote({
      origin: "https://app.example",
      voice: "plain",
    });
    expect(note).toContain("https://app.example/focus");
    expect(note).not.toMatch(/\/focus\/(?:\s|$)/);
  });
});
