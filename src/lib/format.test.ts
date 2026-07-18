import { describe, it, expect } from "vitest";
import { formatAgo, formatWake } from "./format";

describe("formatAgo", () => {
  it("renders seconds/minutes/hours/days", () => {
    expect(formatAgo(5_000)).toBe("5s ago");
    expect(formatAgo(5 * 60_000)).toBe("5m ago");
    expect(formatAgo(3 * 3_600_000)).toBe("3h ago");
    expect(formatAgo(2 * 86_400_000)).toBe("2d ago");
  });
});

describe("formatWake", () => {
  it("accepts a Date and a string and returns a weekday + time", () => {
    const d = new Date("2026-07-20T08:00:00");
    expect(formatWake(d)).toBe(formatWake(d.toISOString()));
    expect(formatWake(d)).toMatch(/\w{3}/); // "Mon" etc.
  });
});
