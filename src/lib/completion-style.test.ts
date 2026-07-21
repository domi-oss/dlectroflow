import { describe, it, expect } from "vitest";
import {
  completionRootAttrs,
  COMPLETE_TICK,
  COMPLETE_TEXT,
} from "@/lib/completion-style";

describe("completionRootAttrs", () => {
  it("maps the defaults (strike on + green)", () => {
    expect(
      completionRootAttrs({
        completeStrikethrough: true,
        completeTickColor: "green",
      }),
    ).toEqual({ "data-complete-strike": "on", "data-tick": "green" });
  });

  it("maps strike off + black", () => {
    expect(
      completionRootAttrs({
        completeStrikethrough: false,
        completeTickColor: "black",
      }),
    ).toEqual({ "data-complete-strike": "off", "data-tick": "black" });
  });

  it("falls back to green for any unknown tick colour", () => {
    expect(
      completionRootAttrs({
        completeStrikethrough: true,
        completeTickColor: "purple",
      }),
    ).toMatchObject({ "data-tick": "green" });
  });
});

describe("shared completion classes", () => {
  it("the tick colour + text decoration read the CSS custom properties", () => {
    expect(COMPLETE_TICK).toContain("var(--tick-color)");
    expect(COMPLETE_TEXT).toContain("var(--complete-decoration)");
  });
});
