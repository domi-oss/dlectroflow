// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AutoAdvance, AUTO_ADVANCE_SEC } from "@/components/focus/auto-advance";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function setup(
  overrides: Partial<React.ComponentProps<typeof AutoAdvance>> = {},
) {
  const onAdvance = vi.fn();
  const onCancel = vi.fn();
  const utils = render(
    <AutoAdvance
      label="Next step"
      targetText="Draft the intro"
      voice="plain"
      reducedMotion={false}
      onAdvance={onAdvance}
      onCancel={onCancel}
      {...overrides}
    />,
  );
  return { onAdvance, onCancel, ...utils };
}

describe("AutoAdvance (#142)", () => {
  it("advances exactly once after the countdown elapses", async () => {
    vi.useFakeTimers();
    const { onAdvance } = setup();
    expect(onAdvance).not.toHaveBeenCalled();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(AUTO_ADVANCE_SEC * 1000);
    });
    expect(onAdvance).toHaveBeenCalledTimes(1);
    // Nothing re-fires once it has gone.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(onAdvance).toHaveBeenCalledTimes(1);
  });

  it("counts down visibly, one second at a time", async () => {
    vi.useFakeTimers();
    setup();
    expect(screen.getByTestId("auto-advance-count")).toHaveTextContent(
      String(AUTO_ADVANCE_SEC),
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(screen.getByTestId("auto-advance-count")).toHaveTextContent(
      String(AUTO_ADVANCE_SEC - 1),
    );
  });

  it("'Stay here' cancels: no navigation, and the escape is announced", async () => {
    const user = userEvent.setup();
    const { onAdvance, onCancel } = setup();
    await user.click(screen.getByRole("button", { name: /stay here/i }));
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onAdvance).not.toHaveBeenCalled();
    // The live region is the SAME element throughout, so its text CHANGING is
    // what gets announced — a freshly-mounted region often is not.
    expect(screen.getByRole("status")).toHaveTextContent(/staying here/i);
  });

  it("stays cancelled — the clock does not keep running underneath", async () => {
    vi.useFakeTimers();
    const { onAdvance } = setup();
    await act(async () => {
      screen.getByRole("button", { name: /stay here/i }).click();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(onAdvance).not.toHaveBeenCalled();
  });

  it("Escape cancels it too — a non-visual escape that needs no tabbing (WCAG 2.2.1)", async () => {
    const user = userEvent.setup();
    const { onAdvance, onCancel } = setup();
    await user.keyboard("{Escape}");
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onAdvance).not.toHaveBeenCalled();
  });

  it("announces the pending navigation and how to stop it, before it happens", () => {
    setup();
    const status = screen.getByRole("status");
    expect(status).toHaveTextContent(/next step/i);
    expect(status).toHaveTextContent(new RegExp(`${AUTO_ADVANCE_SEC} seconds`));
    expect(status).toHaveTextContent(/escape/i);
    expect(status).toHaveTextContent(/stay here/i);
  });

  it("the ticking number is hidden from assistive tech, so it cannot spam the live region", () => {
    setup();
    expect(screen.getByTestId("auto-advance-count")).toHaveAttribute(
      "aria-hidden",
      "true",
    );
  });

  it("holds the countdown while the panel has focus — the escape is not a race", async () => {
    vi.useFakeTimers();
    const { onAdvance } = setup();
    // Focus lands on a DIFFERENT control than the escape, to prove the hold is
    // focus-*within* the panel and not one button's special case.
    await act(async () => {
      screen.getByRole("button", { name: /go now/i }).focus();
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(onAdvance).not.toHaveBeenCalled();
  });

  it("resumes once focus leaves again", async () => {
    vi.useFakeTimers();
    const { onAdvance } = setup();
    const stay = screen.getByRole("button", { name: /stay here/i });
    await act(async () => {
      stay.focus();
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(onAdvance).not.toHaveBeenCalled();
    await act(async () => {
      stay.blur();
      await vi.advanceTimersByTimeAsync(AUTO_ADVANCE_SEC * 1000);
    });
    expect(onAdvance).toHaveBeenCalledTimes(1);
  });

  it("'Go now' skips the wait", async () => {
    const user = userEvent.setup();
    const { onAdvance } = setup();
    await user.click(screen.getByRole("button", { name: /go now/i }));
    expect(onAdvance).toHaveBeenCalledTimes(1);
  });

  it("after cancelling, the target is still reachable — never a dead end", async () => {
    const user = userEvent.setup();
    const { onAdvance } = setup();
    await user.click(screen.getByRole("button", { name: /stay here/i }));
    const go = screen.getByRole("button", { name: /go now/i });
    // …and focus went with it, rather than being dropped on <body> when the
    // button that was pressed unmounted (WCAG 2.4.3).
    expect(go).toHaveFocus();
    await user.click(go);
    expect(onAdvance).toHaveBeenCalledTimes(1);
  });

  it("every control is a ≥44px target", () => {
    setup();
    for (const name of [/go now/i, /stay here/i]) {
      expect(screen.getByRole("button", { name })).toHaveClass("min-h-[44px]");
    }
  });

  it("names what it is advancing to, so the destination is not a surprise", () => {
    setup();
    expect(screen.getByText("Draft the intro")).toBeInTheDocument();
  });

  it("reduced motion drops the animated progress track", () => {
    const { container } = setup({ reducedMotion: true });
    expect(container.querySelector("[data-auto-advance-progress]")).toBeNull();
  });

  it("…and keeps it when motion is allowed", () => {
    const { container } = setup({ reducedMotion: false });
    expect(
      container.querySelector("[data-auto-advance-progress]"),
    ).not.toBeNull();
  });

  it("renders the caller's extra control (the hyper focus off-switch)", () => {
    setup({ extra: <button type="button">Turn off hyper focus mode</button> });
    expect(
      screen.getByRole("button", { name: /turn off hyper focus mode/i }),
    ).toBeInTheDocument();
  });
});
