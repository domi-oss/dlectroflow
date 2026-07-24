import { describe, it, expect } from "vitest";
import { typefaceRootAttrs } from "./typeface";
import { Typeface } from "./constants";

describe("typefaceRootAttrs", () => {
  it("maps a known typeface to the data-font attr", () => {
    expect(typefaceRootAttrs({ typeface: Typeface.OpenDyslexic })).toEqual({
      "data-font": "opendyslexic",
    });
  });

  it("maps every allowed typeface through unchanged", () => {
    for (const value of Object.values(Typeface)) {
      expect(typefaceRootAttrs({ typeface: value })).toEqual({
        "data-font": value,
      });
    }
  });

  it("unknown value degrades to figtree", () => {
    expect(typefaceRootAttrs({ typeface: "bogus" })).toEqual({
      "data-font": "figtree",
    });
  });

  it("empty string degrades to figtree", () => {
    expect(typefaceRootAttrs({ typeface: "" })).toEqual({
      "data-font": "figtree",
    });
  });
});
