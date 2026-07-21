// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  FocusStepTracker,
  type TrackerStep,
} from "@/components/focus/focus-step-tracker";

afterEach(cleanup);

const steps: TrackerStep[] = [
  { id: "s1", text: "Outline", done: true, estMinutes: 5, subtaskEmoji: null },
  {
    id: "s2",
    text: "Draft intro",
    done: false,
    estMinutes: 20,
    subtaskEmoji: "✍️",
  },
  { id: "s3", text: "Polish", done: false, estMinutes: 10, subtaskEmoji: null },
];

describe("FocusStepTracker", () => {
  it("renders one segment per step and marks the current one via aria-current (not colour alone)", () => {
    render(
      <FocusStepTracker
        steps={steps}
        currentStepId="s2"
        expanded={false}
        onToggle={() => {}}
        voice="plain"
      />,
    );
    const segs = screen.getAllByTestId("tracker-segment");
    expect(segs).toHaveLength(3);
    expect(segs[1]).toHaveAttribute("aria-current", "step");
    expect(segs[0]).not.toHaveAttribute("aria-current");
  });

  it("the steps toggle reports expanded state and fires onToggle", async () => {
    const user = userEvent.setup();
    const onToggle = vi.fn();
    render(
      <FocusStepTracker
        steps={steps}
        currentStepId="s2"
        expanded={false}
        onToggle={onToggle}
        voice="plain"
      />,
    );
    const toggle = screen.getByRole("button", { name: /steps/i });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    await user.click(toggle);
    expect(onToggle).toHaveBeenCalled();
  });

  it("when expanded, shows the vertical stepper with ✓ / ● / ○ glyphs + per-step estimates", () => {
    render(
      <FocusStepTracker
        steps={steps}
        currentStepId="s2"
        expanded
        onToggle={() => {}}
        voice="plain"
      />,
    );
    expect(screen.getByText("Outline")).toBeInTheDocument();
    expect(screen.getByText(/Draft intro/)).toBeInTheDocument();
    expect(screen.getByText("Polish")).toBeInTheDocument();
    // Glyphs present (done ✓, current ●, upcoming ○).
    expect(screen.getByText("✓")).toBeInTheDocument();
    expect(screen.getByText("●")).toBeInTheDocument();
    expect(screen.getAllByText("○").length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText(/20m/)).toBeInTheDocument();
  });

  it("hides the stepper list when collapsed", () => {
    render(
      <FocusStepTracker
        steps={steps}
        currentStepId="s2"
        expanded={false}
        onToggle={() => {}}
        voice="plain"
      />,
    );
    expect(screen.queryByText("Outline")).not.toBeInTheDocument();
  });
});
