// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { TimerVisual } from "@/components/focus/timer-visual";
import {
  FocusStepTracker,
  type TrackerStep,
} from "@/components/focus/focus-step-tracker";

afterEach(cleanup);

const steps: TrackerStep[] = [
  { id: "s1", text: "Outline", done: true, estMinutes: 5, subtaskEmoji: null },
  { id: "s2", text: "Draft", done: false, estMinutes: 20, subtaskEmoji: null },
];

describe("focus-timer a11y sweep", () => {
  it("time status is text, not colour-only: the readout shows mm:ss + 'of Nm' in every style", () => {
    for (const style of ["ring", "digits", "bar", "mug"] as const) {
      cleanup();
      render(
        <TimerVisual
          style={style}
          remainingSec={65}
          totalSec={600}
          phase="timeup"
          reducedMotion={false}
          voice="plain"
        />,
      );
      expect(screen.getByText("1:05")).toBeInTheDocument();
      expect(screen.getByText(/of 10m/)).toBeInTheDocument();
    }
  });

  it("reduced motion removes the ring's stroke transition", () => {
    const { container } = render(
      <TimerVisual
        style="ring"
        remainingSec={300}
        totalSec={600}
        phase="running"
        reducedMotion={true}
        voice="plain"
      />,
    );
    expect(container.innerHTML).not.toMatch(/stroke-dashoffset 1s linear/);
  });

  it("the step tracker toggle is a ≥44px target with a text accessible name + aria-expanded", () => {
    render(
      <FocusStepTracker
        steps={steps}
        currentStepId="s2"
        expanded={false}
        onToggle={() => {}}
        voice="plain"
      />,
    );
    const toggle = screen.getByRole("button", { name: /steps/i });
    expect(toggle.className).toMatch(/min-h-\[44px\]/);
    expect(toggle).toHaveAttribute("aria-expanded");
  });

  it("the current step is marked with aria-current (not colour alone)", () => {
    render(
      <FocusStepTracker
        steps={steps}
        currentStepId="s2"
        expanded
        onToggle={() => {}}
        voice="plain"
      />,
    );
    const segs = screen.getAllByTestId("tracker-segment");
    expect(segs[1]).toHaveAttribute("aria-current", "step");
  });
});
