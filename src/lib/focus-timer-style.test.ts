import { describe, it, expect } from "vitest";
import { resolveTimerStyle } from "@/lib/focus-timer-style";

describe("resolveTimerStyle", () => {
  it("returns a stored, allowlisted style verbatim", () => {
    expect(resolveTimerStyle("ring", "plain")).toBe("ring");
    expect(resolveTimerStyle("digits", "playful")).toBe("digits");
    expect(resolveTimerStyle("bar", "plain")).toBe("bar");
    expect(resolveTimerStyle("mug", "plain")).toBe("mug");
  });

  it("falls back to the voice default when unset (null/undefined)", () => {
    expect(resolveTimerStyle(null, "playful")).toBe("mug");
    expect(resolveTimerStyle(null, "plain")).toBe("ring");
    expect(resolveTimerStyle(undefined, "playful")).toBe("mug");
  });

  it("falls back to the voice default for an unknown value", () => {
    expect(resolveTimerStyle("hourglass", "playful")).toBe("mug");
    expect(resolveTimerStyle("", "plain")).toBe("ring");
  });
});
