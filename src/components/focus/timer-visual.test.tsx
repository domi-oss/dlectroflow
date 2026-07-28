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

  // #66 — on the setup screen the ring must show ONE number. `subLabel` swaps
  // the "of Nm" total (a second, competing figure) for a word that says what the
  // single number means.
  it.each(styles)(
    "%s style: a subLabel replaces the 'of Nm' total with the given words",
    (style) => {
      render(
        <TimerVisual
          style={style}
          remainingSec={600}
          totalSec={600}
          phase="setup"
          reducedMotion={false}
          voice="plain"
          subLabel="focus time"
        />,
      );
      const root = screen.getByTestId(`timer-visual-${style}`);
      expect(within(root).getByText("10:00")).toBeInTheDocument();
      expect(within(root).getByText("focus time")).toBeInTheDocument();
      expect(within(root).queryByText(/of 10m/)).not.toBeInTheDocument();
    },
  );

  it("the ring graphic is aria-hidden — the readout text is the exposed figure", () => {
    const { container } = render(
      <TimerVisual
        style="ring"
        remainingSec={600}
        totalSec={600}
        phase="setup"
        reducedMotion={false}
        voice="plain"
      />,
    );
    expect(container.querySelector("svg")).toHaveAttribute(
      "aria-hidden",
      "true",
    );
    expect(screen.getByText("10:00")).toBeInTheDocument();
  });

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

  // #40 Phase 3.1 — the neon signature on the live (running/paused) timer.
  it("running ring uses the brand gradient stroke on a near-black glow field", () => {
    const { container } = render(
      <TimerVisual
        style="ring"
        remainingSec={300}
        totalSec={600}
        phase="running"
        reducedMotion={false}
        voice="plain"
      />,
    );
    expect(
      container.querySelector('circle[stroke="url(#timerRingGrad)"]'),
    ).not.toBeNull();
    expect(container.innerHTML).toContain("shadow-[var(--shadow-glow-dark)]");
  });

  it.each(["bar", "mug"] as const)(
    "running %s fills with the brand gradient on a neon field",
    (style) => {
      const { container } = render(
        <TimerVisual
          style={style}
          remainingSec={300}
          totalSec={600}
          phase="running"
          reducedMotion={false}
          voice="plain"
        />,
      );
      expect(container.innerHTML).toContain(
        "[background-image:var(--gradient-brand)]",
      );
      expect(container.innerHTML).toContain("shadow-[var(--shadow-glow-dark)]");
    },
  );

  // #89 — a PAUSED session's ring doubles as a paced breathing guide (4s in /
  // 6s out; the cadence itself lives in the `focus-breathe` keyframes, asserted
  // in globals.breathe.test.ts). The marker attribute is what these tests can
  // see: jsdom loads no stylesheet, so the component's contract is "does the
  // ring opt into the pacer", not "is it moving".
  describe("breathing pacer on pause (#89)", () => {
    const ringSvg = (container: HTMLElement) =>
      container.querySelector("[data-testid='timer-visual-ring'] svg");

    it("the paused ring opts into the pacer", () => {
      const { container } = render(
        <TimerVisual
          style="ring"
          remainingSec={300}
          totalSec={600}
          phase="paused"
          reducedMotion={false}
          voice="plain"
        />,
      );
      expect(ringSvg(container)).toHaveAttribute("data-breathing");
    });

    // It is a guide you can choose to follow, not information: the element it
    // rides on stays out of the a11y tree, so pausing announces nothing new to a
    // screen reader (the phase is already carried by the Pause/Resume control).
    it("stays out of the a11y tree", () => {
      const { container } = render(
        <TimerVisual
          style="ring"
          remainingSec={300}
          totalSec={600}
          phase="paused"
          reducedMotion={false}
          voice="plain"
        />,
      );
      expect(ringSvg(container)).toHaveAttribute("aria-hidden", "true");
      expect(container.querySelector("[aria-live]")).toBeNull();
    });

    it.each(["setup", "running", "timeup"] as const)(
      "the %s ring does NOT breathe — the pacer is the paused state only",
      (phase) => {
        const { container } = render(
          <TimerVisual
            style="ring"
            remainingSec={300}
            totalSec={600}
            phase={phase}
            reducedMotion={false}
            voice="plain"
          />,
        );
        expect(ringSvg(container)).not.toHaveAttribute("data-breathing");
      },
    );

    // The spec is explicit: reduced motion turns the pacer OFF, it does not slow
    // it down. Leaning on the global @media rule in globals.css would instead
    // leave a 0.01ms single-iteration animation on the element.
    it("reduced motion disables it outright rather than slowing it", () => {
      const { container } = render(
        <TimerVisual
          style="ring"
          remainingSec={300}
          totalSec={600}
          phase="paused"
          reducedMotion={true}
          voice="plain"
        />,
      );
      expect(ringSvg(container)).not.toHaveAttribute("data-breathing");
    });

    // A breathing bar / mug / set of digits is a different (worse) idea — the
    // ring is the shape a breath maps onto. The other three styles keep the
    // paused view they have today.
    it.each(["digits", "bar", "mug"] as const)(
      "%s style: nothing breathes when paused (ring-only pacer)",
      (style) => {
        const { container } = render(
          <TimerVisual
            style={style}
            remainingSec={300}
            totalSec={600}
            phase="paused"
            reducedMotion={false}
            voice="plain"
          />,
        );
        expect(container.querySelector("[data-breathing]")).toBeNull();
      },
    );

    // Legibility through the whole cycle: the animated element is the ring
    // graphic alone, so the mm:ss readout (a sibling overlay) neither scales nor
    // fades with it.
    it("animates the ring graphic only — the readout is outside it", () => {
      const { container } = render(
        <TimerVisual
          style="ring"
          remainingSec={125}
          totalSec={600}
          phase="paused"
          reducedMotion={false}
          voice="plain"
        />,
      );
      expect(ringSvg(container)?.textContent ?? "").not.toContain("2:05");
      expect(screen.getByText("2:05")).toBeInTheDocument();
    });

    // No layout shift entering or leaving the paused state: the pacer adds no
    // element and changes no box — the ring's fixed 16rem frame is byte-for-byte
    // the same markup running and paused, apart from the marker attribute.
    it("adds no element and no size change on entering the paused state", () => {
      const props = {
        style: "ring",
        remainingSec: 300,
        totalSec: 600,
        reducedMotion: false,
        voice: "plain",
      } as const;
      const running = render(<TimerVisual {...props} phase="running" />);
      const runningHtml = running.container.innerHTML;
      cleanup();
      const paused = render(<TimerVisual {...props} phase="paused" />);
      expect(paused.container.innerHTML.replace(' data-breathing=""', "")).toBe(
        runningHtml,
      );
    });
  });

  it("keeps the warm amber semantic at time's-up (not repainted with brand)", () => {
    const { container } = render(
      <TimerVisual
        style="ring"
        remainingSec={0}
        totalSec={600}
        phase="timeup"
        reducedMotion={false}
        voice="plain"
      />,
    );
    expect(container.querySelector(".stroke-amber-500")).not.toBeNull();
    expect(
      container.querySelector('circle[stroke="url(#timerRingGrad)"]'),
    ).toBeNull();
  });
});
