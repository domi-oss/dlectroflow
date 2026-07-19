import { describe, it, expect } from "vitest";
import { t } from "@/lib/strings";

describe("launcher strings", () => {
  it("meta-line units resolve in both voices", () => {
    expect(t("focus.meta.focusedToday", "plain")).toBe("focused today");
    expect(t("focus.meta.dayStreak", "plain")).toBe("-day streak");
    expect(t("focus.meta.toClear", "plain")).toBe("to clear");
  });

  it("hero + lane CTAs resolve, plain voice stays emoji-free of decoration", () => {
    expect(t("focus.hero.resume", "plain")).toBe("▶ Resume focus");
    expect(t("focus.hero.resume", "playful")).toBe("▶ Resume focusing");
    expect(t("focus.hero.left", "plain")).toBe("left");
    expect(t("focus.hero.next", "plain")).toBe("next →");
    expect(t("focus.lane.start", "plain")).toBe("▶ Start");
    expect(t("focus.lane.open", "plain")).toBe("▶ Open");
  });

  it("all-cleared copy differs by voice", () => {
    expect(t("focus.launcher.allClear", "plain")).not.toBe(
      t("focus.launcher.allClear", "playful"),
    );
  });
});
