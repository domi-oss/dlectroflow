// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { RowActions, ScheduleControl } from "./row-actions";

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

  it("Duo a11y fix: needs_duration 📅 uses aria-haspopup='dialog' (focus-capturing popover, no role=menu)", () => {
    render(<RowActions inline={[]} menu={[]} schedule={{ state: "needs_duration", onScheduleSingle: vi.fn() }} />);
    expect(screen.getByRole("button", { name: /schedule/i })).toHaveAttribute("aria-haspopup", "dialog");
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

  it("Duo fix: a fractional custom duration below 1 (e.g. 0.5) is out of range", () => {
    const fn = vi.fn();
    render(<RowActions inline={[]} menu={[]} schedule={{ state: "needs_duration", onScheduleSingle: fn }} />);
    fireEvent.click(screen.getByRole("button", { name: /schedule/i }));
    fireEvent.change(screen.getByRole("spinbutton"), { target: { value: "0.5" } });
    const goButton = screen.getByRole("button", { name: /go/i });
    expect(goButton).toBeDisabled();
    fireEvent.click(goButton);
    expect(fn).not.toHaveBeenCalled();
  });

  it("clears the custom duration input when the popover is dismissed + reopened (Duo review)", () => {
    render(<RowActions inline={[]} menu={[]} schedule={{ state: "needs_duration", onScheduleSingle: vi.fn() }} />);
    fireEvent.click(screen.getByRole("button", { name: /schedule/i }));
    fireEvent.change(screen.getByRole("spinbutton"), { target: { value: "99" } });
    fireEvent.keyDown(document, { key: "Escape" }); // dismiss
    fireEvent.click(screen.getByRole("button", { name: /schedule/i })); // reopen
    expect(screen.getByRole("spinbutton")).toHaveValue(null);
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

  it("v6: end cluster with a move slot renders in order: move, schedule, delete, then 🔽 (All options)", () => {
    render(
      <RowActions
        inline={[<button key="a">First</button>]}
        move={
          <button key="mv" aria-label="Move to">
            📥
          </button>
        }
        schedule={{ state: "ready_steps", onScheduleSteps: vi.fn() }}
        del={<button key="d">Delete</button>}
        menu={[]}
      />,
    );
    const names = screen
      .getAllByRole("button")
      .map((b) => b.getAttribute("aria-label") ?? b.textContent);
    expect(names).toEqual(["First", "Move to", "Schedule", "Delete", "All options"]);
  });
});

describe("ScheduleControl — ICS states", () => {
  it("ics_ready_steps: 📅 fires onScheduleIcs() immediately (icon variant, aria 'Add to calendar')", () => {
    const fn = vi.fn();
    render(<RowActions inline={[]} menu={[]} schedule={{ state: "ics_ready_steps", onScheduleIcs: fn }} />);
    fireEvent.click(screen.getByRole("button", { name: /add to calendar/i }));
    expect(fn).toHaveBeenCalledWith();
  });
  it("ics_needs_duration: opens the popover; picking 30 fires onScheduleIcs(30)", () => {
    const fn = vi.fn();
    render(<RowActions inline={[]} menu={[]} schedule={{ state: "ics_needs_duration", onScheduleIcs: fn }} />);
    fireEvent.click(screen.getByRole("button", { name: /add to calendar/i }));
    fireEvent.click(screen.getByRole("button", { name: /^30 min$/i }));
    expect(fn).toHaveBeenCalledWith(30);
  });
  it("menu variant renders the label and fires onScheduleIcs", () => {
    const fn = vi.fn();
    render(<ScheduleControl variant="menu" state="ics_ready_steps" onScheduleIcs={fn} label="Add to calendar (.ics)" />);
    fireEvent.click(screen.getByRole("button", { name: "Add to calendar (.ics)" }));
    expect(fn).toHaveBeenCalledWith();
  });
});

describe("RowActions — Scheduled indicator", () => {
  it("renders 'Scheduled ✓' when scheduled, hides it otherwise", () => {
    const { rerender } = render(<RowActions inline={[]} schedule={null} menu={[]} scheduled />);
    expect(screen.getByText(/scheduled ✓/i)).toBeInTheDocument();
    rerender(<RowActions inline={[]} schedule={null} menu={[]} />);
    expect(screen.queryByText(/scheduled ✓/i)).toBeNull();
  });
});

describe("ScheduleControl — menu variant (▾ dropdown 'Schedule' entry)", () => {
  it("ready_steps: renders a 'Schedule' text button that fires onScheduleSteps", () => {
    const fn = vi.fn();
    render(<ScheduleControl variant="menu" state="ready_steps" onScheduleSteps={fn} />);
    fireEvent.click(screen.getByRole("button", { name: "Schedule" }));
    expect(fn).toHaveBeenCalledOnce();
  });

  it("needs_duration: 'Schedule' expands presets inline; picking 30 fires onScheduleSingle(30)", () => {
    const fn = vi.fn();
    render(<ScheduleControl variant="menu" state="needs_duration" onScheduleSingle={fn} />);
    fireEvent.click(screen.getByRole("button", { name: "Schedule" }));
    fireEvent.click(screen.getByRole("button", { name: /^30 min$/i }));
    expect(fn).toHaveBeenCalledWith(30);
  });

  it("reconnect: renders the OAuth link even in menu variant", () => {
    render(<ScheduleControl variant="menu" state="reconnect" />);
    expect(screen.getByRole("link", { name: /reconnect google/i })).toHaveAttribute(
      "href",
      "/api/google/oauth/start",
    );
  });
});
