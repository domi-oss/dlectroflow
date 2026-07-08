import { describe, it, expect } from "vitest";
import { localBreakdown } from "./breakdown";

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
