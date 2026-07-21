// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup, within } from "@testing-library/react";
import { TimerVisual } from "@/components/focus/timer-visual";

afterEach(cleanup);

const styles = ["ring", "digits", "bar", "mug"] as const;

describe("TimerVisual", () => {
  it.each(styles)(
    "renders the %s style with the mm:ss + 'of Nm' readout (never colour-only)",
    (style) => {
      render(
        <TimerVisual
          style={style}
          remainingSec={125}
          totalSec={600}
          phase="running"
          reducedMotion={false}
          voice="plain"
        />,
      );
      const root = screen.getByTestId(`timer-visual-${style}`);
      expect(within(root).getByText("2:05")).toBeInTheDocument();
      expect(within(root).getByText(/of 10m/)).toBeInTheDocument();
    },
  );

  it("bar style exposes a progressbar with numeric min/now/max", () => {
    render(
      <TimerVisual
        style="bar"
        remainingSec={300}
        totalSec={600}
        phase="running"
        reducedMotion={false}
        voice="plain"
      />,
    );
    const bar = screen.getByRole("progressbar");
    expect(bar).toHaveAttribute("aria-valuemin", "0");
    expect(bar).toHaveAttribute("aria-valuemax", "10");
    expect(bar).toHaveAttribute("aria-valuenow", "5");
  });

  it("drops the animated transition under reduced motion (mug)", () => {
    const { container } = render(
      <TimerVisual
        style="mug"
        remainingSec={300}
        totalSec={600}
        phase="running"
        reducedMotion={true}
        voice="plain"
      />,
    );
    expect(container.innerHTML).not.toMatch(/transition-\[height\]/);
  });
});
