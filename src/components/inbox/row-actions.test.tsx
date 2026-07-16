// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { RowActions } from "./row-actions";

afterEach(cleanup);

describe("RowActions", () => {
  it("renders inline actions in order, each firing its own handler directly (no menu involved)", () => {
    const onFirst = vi.fn();
    const onSecond = vi.fn();
    render(
      <RowActions
        inline={[
          <button key="a" onClick={onFirst}>
            First
          </button>,
          <button key="b" onClick={onSecond}>
            Second
          </button>,
        ]}
        schedule={null}
        menu={[]}
      />,
    );
    const buttons = screen.getAllByRole("button");
    expect(buttons[0]).toHaveTextContent("First");
    expect(buttons[1]).toHaveTextContent("Second");
    fireEvent.click(screen.getByRole("button", { name: "First" }));
    expect(onFirst).toHaveBeenCalledOnce();
    expect(onSecond).not.toHaveBeenCalled();
  });

  it("end cluster renders in order: schedule, delete, then ▾", () => {
    render(
      <RowActions
        inline={[<button key="a">First</button>]}
        schedule={{ state: "ready_steps", onScheduleSteps: vi.fn() }}
        del={<button key="d">Delete</button>}
        menu={[]}
      />,
    );
    const names = screen
      .getAllByRole("button")
      .map((b) => b.getAttribute("aria-label") ?? b.textContent);
    expect(names).toEqual(["First", "Schedule", "Delete", "All options"]);
  });

  it("del is omitted from the end cluster when not provided", () => {
    render(<RowActions inline={[]} schedule={null} menu={[]} />);
    expect(screen.queryByRole("button", { name: /delete/i })).toBeNull();
  });

  it("▾ trigger is labeled 'All options' and opens the dismissable list of menu entries verbatim", () => {
    render(
      <RowActions
        inline={[]}
        schedule={null}
        menu={[<button key="m1">Move to…</button>, <button key="m2">Snooze 1h</button>]}
      />,
    );
    expect(screen.queryByRole("button", { name: /move to/i })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "All options" }));
    expect(screen.getByRole("button", { name: /move to/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /snooze 1h/i })).toBeInTheDocument();
  });

  it("Escape closes the ▾ popover (dismissable-popover idiom)", () => {
    render(<RowActions inline={[]} schedule={null} menu={[<button key="m1">Move to…</button>]} />);
    fireEvent.click(screen.getByRole("button", { name: "All options" }));
    expect(screen.getByRole("button", { name: /move to/i })).toBeInTheDocument();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("button", { name: /move to/i })).toBeNull();
  });

  it("outside click closes the ▾ popover (dismissable-popover idiom)", () => {
    render(
      <div>
        <RowActions inline={[]} schedule={null} menu={[<button key="m1">Move to…</button>]} />
        <button>Outside</button>
      </div>,
    );
    fireEvent.click(screen.getByRole("button", { name: "All options" }));
    expect(screen.getByRole("button", { name: /move to/i })).toBeInTheDocument();
    fireEvent.pointerDown(screen.getByRole("button", { name: "Outside" }));
    expect(screen.queryByRole("button", { name: /move to/i })).toBeNull();
  });

  it("never renders role=\"menu\", even with the ▾ popover open", () => {
    render(<RowActions inline={[]} schedule={null} menu={[<button key="m1">Move to…</button>]} />);
    expect(screen.queryByRole("menu")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "All options" }));
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("ready_steps: 📅 fires onScheduleSteps immediately", () => {
    const fn = vi.fn();
    render(<RowActions inline={[]} menu={[]} schedule={{ state: "ready_steps", onScheduleSteps: fn }} />);
    fireEvent.click(screen.getByRole("button", { name: /schedule/i }));
    expect(fn).toHaveBeenCalledOnce();
  });

  it("needs_duration: 📅 opens the popover; picking 30 fires onScheduleSingle(30)", () => {
    const fn = vi.fn();
    render(<RowActions inline={[]} menu={[]} schedule={{ state: "needs_duration", onScheduleSingle: fn }} />);
    fireEvent.click(screen.getByRole("button", { name: /schedule/i }));
    fireEvent.click(screen.getByRole("button", { name: /^30 min$/i }));
    expect(fn).toHaveBeenCalledWith(30);
  });

  it("custom duration input schedules with the typed minutes", () => {
    const fn = vi.fn();
    render(<RowActions inline={[]} menu={[]} schedule={{ state: "needs_duration", onScheduleSingle: fn }} />);
    fireEvent.click(screen.getByRole("button", { name: /schedule/i }));
    fireEvent.change(screen.getByRole("spinbutton"), { target: { value: "25" } });
    fireEvent.click(screen.getByRole("button", { name: /go/i }));
    expect(fn).toHaveBeenCalledWith(25);
  });

  it("pending disables the 📅 control, closing the double-submit race", () => {
    const fn = vi.fn();
    render(
      <RowActions
        inline={[]}
        menu={[]}
        schedule={{ state: "ready_steps", onScheduleSteps: fn, pending: true }}
      />,
    );
    const scheduleButton = screen.getByRole("button", { name: /schedule/i });
    expect(scheduleButton).toBeDisabled();
    fireEvent.click(scheduleButton);
    expect(fn).not.toHaveBeenCalled();
  });

  it("custom duration input has min/max/step bounds and visibly refuses minutes over 480", () => {
    const fn = vi.fn();
    render(<RowActions inline={[]} menu={[]} schedule={{ state: "needs_duration", onScheduleSingle: fn }} />);
    fireEvent.click(screen.getByRole("button", { name: /schedule/i }));
    const input = screen.getByRole("spinbutton");
    expect(input).toHaveAttribute("min", "1");
    expect(input).toHaveAttribute("max", "480");
    expect(input).toHaveAttribute("step", "1");

    fireEvent.change(input, { target: { value: "9999" } });
    const goButton = screen.getByRole("button", { name: /go/i });
    expect(goButton).toBeDisabled();
    fireEvent.click(goButton);
    expect(fn).not.toHaveBeenCalled();
    expect(screen.getByText(/1.*480/)).toBeInTheDocument();
  });

  it("reconnect state renders the OAuth link, not a button", () => {
    render(<RowActions inline={[]} menu={[]} schedule={{ state: "reconnect" }} />);
    expect(screen.getByRole("link", { name: /reconnect google/i })).toHaveAttribute(
      "href",
      "/api/google/oauth/start",
    );
  });

  it("no schedule prop → no 📅 control (guest rows)", () => {
    render(<RowActions inline={[]} schedule={null} menu={[<span key="a">Edit</span>]} />);
    expect(screen.queryByRole("button", { name: /schedule/i })).toBeNull();
  });
});
