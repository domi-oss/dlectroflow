// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { BadgeGrid } from "@/components/dashboard/badge-grid";
import { DASHBOARD_BADGE_KEYS } from "@/lib/constants";

afterEach(cleanup);

describe("BadgeGrid", () => {
  it("renders all nine dashboard badges (7 wireframe + 2 legacy, plain voice)", () => {
    render(<BadgeGrid voice="plain" earned={[]} />);
    for (const label of [
      "First breakdown",
      "First scheduled",
      "First focus",
      "Task complete",
      "Full work week",
      "Inbox zero",
      "Comeback",
      "10 steps in a day",
      "Beat your best streak",
    ]) {
      expect(screen.getByText(new RegExp(label))).toBeInTheDocument();
    }
    expect(DASHBOARD_BADGE_KEYS).toHaveLength(9);
  });

  it("surfaces the legacy badges with accessible earned/locked state", () => {
    render(<BadgeGrid voice="plain" earned={["ten_steps_day"]} />);

    const earned = screen.getByLabelText("10 steps in a day — earned");
    expect(earned).toHaveAttribute("data-earned", "true");
    expect(earned.textContent).not.toContain("🔒");

    const locked = screen.getByLabelText("Beat your best streak — not earned yet");
    expect(locked).toHaveAttribute("data-earned", "false");
    expect(locked.textContent).toContain("🔒");
  });

  it("shows earned badges without a lock and unearned badges locked", () => {
    render(<BadgeGrid voice="plain" earned={["first_focus"]} />);

    const earned = screen.getByLabelText("First focus — earned");
    expect(earned).toHaveAttribute("data-earned", "true");
    expect(earned.textContent).not.toContain("🔒");

    const locked = screen.getByLabelText("Comeback — not earned yet");
    expect(locked).toHaveAttribute("data-earned", "false");
    expect(locked.textContent).toContain("🔒");
  });

  it("uses playful labels when the voice is playful", () => {
    render(<BadgeGrid voice="playful" earned={["first_breakdown"]} />);
    expect(screen.getByText(/First Slice/)).toBeInTheDocument(); // 🍰 First Slice
    expect(screen.getByText(/Back for Seconds/)).toBeInTheDocument(); // 📦 Comeback (locked)
  });
});
