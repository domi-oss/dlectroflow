// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { RowActions } from "./row-actions";

afterEach(cleanup);

describe("RowActions", () => {
  it("ready_steps: 📅 fires onScheduleSteps immediately", () => {
    const fn = vi.fn();
    render(<RowActions overflow={[]} schedule={{ state: "ready_steps", onScheduleSteps: fn }} />);
    fireEvent.click(screen.getByRole("button", { name: /schedule/i }));
    expect(fn).toHaveBeenCalledOnce();
  });

  it("needs_duration: 📅 opens the popover; picking 30 fires onScheduleSingle(30)", () => {
    const fn = vi.fn();
    render(<RowActions overflow={[]} schedule={{ state: "needs_duration", onScheduleSingle: fn }} />);
    fireEvent.click(screen.getByRole("button", { name: /schedule/i }));
    fireEvent.click(screen.getByRole("button", { name: /^30 min$/i }));
    expect(fn).toHaveBeenCalledWith(30);
  });

  it("custom duration input schedules with the typed minutes", () => {
    const fn = vi.fn();
    render(<RowActions overflow={[]} schedule={{ state: "needs_duration", onScheduleSingle: fn }} />);
    fireEvent.click(screen.getByRole("button", { name: /schedule/i }));
    fireEvent.change(screen.getByRole("spinbutton"), { target: { value: "25" } });
    fireEvent.click(screen.getByRole("button", { name: /go/i }));
    expect(fn).toHaveBeenCalledWith(25);
  });

  it("pending disables the 📅 control, closing the double-submit race", () => {
    const fn = vi.fn();
    render(
      <RowActions overflow={[]} schedule={{ state: "ready_steps", onScheduleSteps: fn, pending: true }} />,
    );
    const scheduleButton = screen.getByRole("button", { name: /schedule/i });
    expect(scheduleButton).toBeDisabled();
    fireEvent.click(scheduleButton);
    expect(fn).not.toHaveBeenCalled();
  });

  it("has min/step bounds on the custom duration input and refuses minutes over 480", () => {
    const fn = vi.fn();
    render(<RowActions overflow={[]} schedule={{ state: "needs_duration", onScheduleSingle: fn }} />);
    fireEvent.click(screen.getByRole("button", { name: /schedule/i }));
    const input = screen.getByRole("spinbutton");
    expect(input).toHaveAttribute("min", "1");
    expect(input).toHaveAttribute("step", "1");
    fireEvent.change(input, { target: { value: "9999" } });
    fireEvent.click(screen.getByRole("button", { name: /go/i }));
    expect(fn).not.toHaveBeenCalled();
  });

  it("reconnect state renders the OAuth link, not a button", () => {
    render(<RowActions overflow={[]} schedule={{ state: "reconnect" }} />);
    expect(screen.getByRole("link", { name: /reconnect google/i })).toHaveAttribute(
      "href", "/api/google/oauth/start",
    );
  });

  it("no schedule prop → no 📅 control (guest rows)", () => {
    render(<RowActions overflow={[<span key="a">Edit</span>]} schedule={null} />);
    expect(screen.queryByRole("button", { name: /schedule/i })).toBeNull();
  });

  it("overflow entries render inside the ⋯ menu after opening it", () => {
    render(<RowActions overflow={[<button key="d">Delete</button>]} schedule={null} />);
    fireEvent.click(screen.getByRole("button", { name: /more actions/i }));
    expect(screen.getByRole("button", { name: /delete/i })).toBeInTheDocument();
  });
});
