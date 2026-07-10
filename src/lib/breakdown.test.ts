import { describe, it, expect } from "vitest";
import { localBreakdown, reorder, blankStep } from "./breakdown";

describe("reorder", () => {
  it("moves an item from one index to another (down)", () => {
    expect(reorder(["a", "b", "c", "d"], 0, 2)).toEqual(["b", "c", "a", "d"]);
  });
  it("moves an item up", () => {
    expect(reorder(["a", "b", "c", "d"], 3, 1)).toEqual(["a", "d", "b", "c"]);
  });
  it("is a no-op when from === to", () => {
    expect(reorder(["a", "b", "c"], 1, 1)).toEqual(["a", "b", "c"]);
  });
  it("returns a new array (does not mutate the input)", () => {
    const input = ["a", "b", "c"];
    const out = reorder(input, 0, 2);
    expect(input).toEqual(["a", "b", "c"]);
    expect(out).not.toBe(input);
  });
  it("clamps out-of-range indices instead of dropping items", () => {
    expect(reorder(["a", "b", "c"], 0, 99)).toEqual(["b", "c", "a"]);
    expect(reorder(["a", "b", "c"], -1, 0)).toEqual(["a", "b", "c"]);
  });
});

describe("blankStep", () => {
  it("returns an empty, editable step with a positive default estimate", () => {
    const s = blankStep();
    expect(s.text).toBe("");
    expect(s.estMinutes).toBeGreaterThan(0);
    expect(typeof s.subtaskEmoji).toBe("string");
  });
});

describe("localBreakdown", () => {
  it("returns a non-empty ordered proposal with positive estimates", () => {
    const p = localBreakdown("Write the quarterly report");
    expect(p.parentEmoji).toBeTruthy();
    expect(p.steps.length).toBeGreaterThanOrEqual(3);
    for (const s of p.steps) {
      expect(s.text.length).toBeGreaterThan(0);
      expect(s.estMinutes).toBeGreaterThan(0);
      expect(s.subtaskEmoji).toBeTruthy();
    }
  });
});
