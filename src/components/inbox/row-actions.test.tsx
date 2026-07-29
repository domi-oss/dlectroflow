// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import {
  render,
  screen,
  fireEvent,
  cleanup,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { RowActions, ScheduleControl } from "./row-actions";
import { SchedulePriority, ScheduleHours } from "@/lib/scheduling/types";
import type { ScheduleIntent } from "@/lib/scheduling/types";

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

  it("mobile-wrap fix: the end cluster (move/schedule/delete/▾) shares one flex-nowrap ancestor so it wraps as a unit, never splitting the ▾ trigger off alone (owner mobile-screenshot bug)", () => {
    render(
      <RowActions
        inline={[<button key="a">First</button>]}
        move={<button key="mv">Move</button>}
        schedule={{ state: "ready_steps", onScheduleSteps: vi.fn() }}
        del={<button key="d">Delete</button>}
        menu={[]}
      />,
    );
    const moveBtn = screen.getByRole("button", { name: "Move" });
    const scheduleBtn = screen.getByRole("button", { name: /schedule/i });
    const deleteBtn = screen.getByRole("button", { name: "Delete" });
    const menuBtn = screen.getByRole("button", { name: "All options" });
    // Nearest common ancestor of the first and last end-cluster controls must
    // be the same nowrap group — i.e. move's parent chain includes the exact
    // element that also contains the ▾ trigger.
    const nowrapGroup = moveBtn.closest(".flex-nowrap");
    expect(nowrapGroup).not.toBeNull();
    expect(nowrapGroup).toContainElement(scheduleBtn);
    expect(nowrapGroup).toContainElement(deleteBtn);
    expect(nowrapGroup).toContainElement(menuBtn);
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
        menu={[
          <button key="m1">Move to…</button>,
          <button key="m2">Snooze 1h</button>,
        ]}
      />,
    );
    expect(screen.queryByRole("button", { name: /move to/i })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "All options" }));
    expect(
      screen.getByRole("button", { name: /move to/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /snooze 1h/i }),
    ).toBeInTheDocument();
  });

  it("Escape closes the ▾ popover (dismissable-popover idiom)", () => {
    render(
      <RowActions
        inline={[]}
        schedule={null}
        menu={[<button key="m1">Move to…</button>]}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "All options" }));
    expect(
      screen.getByRole("button", { name: /move to/i }),
    ).toBeInTheDocument();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("button", { name: /move to/i })).toBeNull();
  });

  // #92 — dismissal is Base UI's now, which treats a mouse outside-press as a
  // full click rather than a bare pointerdown (a drag that starts outside no
  // longer dismisses; touch still dismisses on first contact). Hence the real
  // click here instead of the synthetic `pointerDown`.
  it("outside click closes the ▾ popover (dismissable-popover idiom)", async () => {
    render(
      <div>
        <RowActions
          inline={[]}
          schedule={null}
          menu={[<button key="m1">Move to…</button>]}
        />
        <button>Outside</button>
      </div>,
    );
    fireEvent.click(screen.getByRole("button", { name: "All options" }));
    expect(
      screen.getByRole("button", { name: /move to/i }),
    ).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Outside" }));
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: /move to/i })).toBeNull(),
    );
  });

  // ── #92 popup wiring ──────────────────────────────────────────────────────
  it("the 🔽 popover is a named dialog its trigger points at", () => {
    render(
      <RowActions
        inline={[]}
        schedule={null}
        menu={[<button key="m1">Move to…</button>]}
      />,
    );
    const trigger = screen.getByRole("button", { name: "All options" });
    expect(trigger).toHaveAttribute("aria-haspopup", "dialog");
    expect(trigger).toHaveAttribute("aria-expanded", "false");

    fireEvent.click(trigger);
    // A `dialog` with no accessible name is an axe violation, and unusable with
    // a screen reader — the popup carries its own label since there is no
    // visible heading to reference.
    const popup = screen.getByRole("dialog", { name: "All options" });
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    expect(trigger).toHaveAttribute("aria-controls", popup.id);
    expect(popup).toContainElement(
      screen.getByRole("button", { name: /move to/i }),
    );
  });

  it("the 📅 duration popover is a named dialog, and only exists when there is a duration to pick", () => {
    const { unmount } = render(
      <RowActions
        inline={[]}
        menu={[]}
        schedule={{ state: "ready_steps", onScheduleSteps: vi.fn() }}
      />,
    );
    // ready_steps acts immediately — no popup, so nothing to advertise.
    expect(
      screen.getByRole("button", { name: /schedule/i }),
    ).not.toHaveAttribute("aria-haspopup");
    unmount();

    render(
      <RowActions
        inline={[]}
        menu={[]}
        schedule={{ state: "needs_duration", onScheduleSingle: vi.fn() }}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /schedule/i }));
    expect(
      screen.getByRole("dialog", { name: /schedule — duration/i }),
    ).toContainElement(screen.getByRole("spinbutton"));
  });

  // Row popups sit inside the action line's phrasing content; a `<div>` there
  // is invalid markup (and would close an enclosing `<p>` early).
  it("renders the 🔽 popover out of phrasing-content elements only", () => {
    const { container } = render(
      <RowActions
        inline={[]}
        schedule={null}
        menu={[<button key="m1">Move to…</button>]}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "All options" }));
    const cluster = container.querySelector(".flex-nowrap")!;
    expect(cluster.querySelectorAll("div")).toHaveLength(0);
  });

  it('never renders role="menu", even with the ▾ popover open', () => {
    render(
      <RowActions
        inline={[]}
        schedule={null}
        menu={[<button key="m1">Move to…</button>]}
      />,
    );
    expect(screen.queryByRole("menu")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "All options" }));
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("ready_steps: 📅 fires onScheduleSteps immediately", () => {
    const fn = vi.fn();
    render(
      <RowActions
        inline={[]}
        menu={[]}
        schedule={{ state: "ready_steps", onScheduleSteps: fn }}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /schedule/i }));
    expect(fn).toHaveBeenCalledOnce();
  });

  it("needs_duration: 📅 opens the popover; picking 30 fires onScheduleSingle(30)", () => {
    const fn = vi.fn();
    render(
      <RowActions
        inline={[]}
        menu={[]}
        schedule={{ state: "needs_duration", onScheduleSingle: fn }}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /schedule/i }));
    fireEvent.click(screen.getByRole("button", { name: /^30 min$/i }));
    expect(fn).toHaveBeenCalledWith(30);
  });

  it("Duo a11y fix: needs_duration 📅 uses aria-haspopup='dialog' (focus-capturing popover, no role=menu)", () => {
    render(
      <RowActions
        inline={[]}
        menu={[]}
        schedule={{ state: "needs_duration", onScheduleSingle: vi.fn() }}
      />,
    );
    expect(screen.getByRole("button", { name: /schedule/i })).toHaveAttribute(
      "aria-haspopup",
      "dialog",
    );
  });

  it("custom duration input schedules with the typed minutes", () => {
    const fn = vi.fn();
    render(
      <RowActions
        inline={[]}
        menu={[]}
        schedule={{ state: "needs_duration", onScheduleSingle: fn }}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /schedule/i }));
    fireEvent.change(screen.getByRole("spinbutton"), {
      target: { value: "25" },
    });
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
    render(
      <RowActions
        inline={[]}
        menu={[]}
        schedule={{ state: "needs_duration", onScheduleSingle: fn }}
      />,
    );
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
    render(
      <RowActions
        inline={[]}
        menu={[]}
        schedule={{ state: "needs_duration", onScheduleSingle: fn }}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /schedule/i }));
    fireEvent.change(screen.getByRole("spinbutton"), {
      target: { value: "0.5" },
    });
    const goButton = screen.getByRole("button", { name: /go/i });
    expect(goButton).toBeDisabled();
    fireEvent.click(goButton);
    expect(fn).not.toHaveBeenCalled();
  });

  it("clears the custom duration input when the popover is dismissed + reopened (Duo review)", () => {
    render(
      <RowActions
        inline={[]}
        menu={[]}
        schedule={{ state: "needs_duration", onScheduleSingle: vi.fn() }}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /schedule/i }));
    fireEvent.change(screen.getByRole("spinbutton"), {
      target: { value: "99" },
    });
    fireEvent.keyDown(document, { key: "Escape" }); // dismiss
    fireEvent.click(screen.getByRole("button", { name: /schedule/i })); // reopen
    expect(screen.getByRole("spinbutton")).toHaveValue(null);
  });

  // #23 — the clear-on-close used to be a single effect watching `open`, so it
  // covered every dismissal route at once. These pin the two routes the Duo
  // review test above doesn't: clicking away, and re-clicking the trigger.
  it("clears the custom duration input when the popover is closed by an outside click", async () => {
    render(
      <RowActions
        inline={[]}
        menu={[]}
        schedule={{ state: "needs_duration", onScheduleSingle: vi.fn() }}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /schedule/i }));
    fireEvent.change(screen.getByRole("spinbutton"), {
      target: { value: "99" },
    });
    await userEvent.click(document.body); // click away (see #92 note above)
    await waitFor(() => expect(screen.queryByRole("spinbutton")).toBeNull());
    fireEvent.click(screen.getByRole("button", { name: /schedule/i })); // reopen
    expect(screen.getByRole("spinbutton")).toHaveValue(null);
  });

  it("clears the custom duration input when the trigger itself closes the popover", () => {
    render(
      <RowActions
        inline={[]}
        menu={[]}
        schedule={{ state: "needs_duration", onScheduleSingle: vi.fn() }}
      />,
    );
    const trigger = screen.getByRole("button", { name: /schedule/i });
    fireEvent.click(trigger);
    fireEvent.change(screen.getByRole("spinbutton"), {
      target: { value: "99" },
    });
    fireEvent.click(trigger); // close via the trigger
    fireEvent.click(trigger); // reopen
    expect(screen.getByRole("spinbutton")).toHaveValue(null);
  });

  it("clears the custom duration input after a preset is picked", () => {
    const onScheduleSingle = vi.fn();
    render(
      <RowActions
        inline={[]}
        menu={[]}
        schedule={{ state: "needs_duration", onScheduleSingle }}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /schedule/i }));
    fireEvent.change(screen.getByRole("spinbutton"), {
      target: { value: "99" },
    });
    fireEvent.click(screen.getByRole("button", { name: "30 min" }));
    expect(onScheduleSingle).toHaveBeenCalledWith(30);
    fireEvent.click(screen.getByRole("button", { name: /schedule/i })); // reopen
    expect(screen.getByRole("spinbutton")).toHaveValue(null);
  });

  it("reconnect state renders the OAuth link, not a button", () => {
    render(
      <RowActions inline={[]} menu={[]} schedule={{ state: "reconnect" }} />,
    );
    expect(
      screen.getByRole("link", { name: /reconnect google/i }),
    ).toHaveAttribute("href", "/api/google/oauth/start");
  });

  it("no schedule prop → no 📅 control (guest rows)", () => {
    render(
      <RowActions
        inline={[]}
        schedule={null}
        menu={[<span key="a">Edit</span>]}
      />,
    );
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
    expect(names).toEqual([
      "First",
      "Move to",
      "Schedule",
      "Delete",
      "All options",
    ]);
  });
});

describe("ScheduleControl — ICS states", () => {
  it("ics_ready_steps: 📅 fires onScheduleIcs() immediately (icon variant, aria 'Add to calendar')", () => {
    const fn = vi.fn();
    render(
      <RowActions
        inline={[]}
        menu={[]}
        schedule={{ state: "ics_ready_steps", onScheduleIcs: fn }}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /add to calendar/i }));
    expect(fn).toHaveBeenCalledWith();
  });
  it("ics_needs_duration: opens the popover; picking 30 fires onScheduleIcs(30)", () => {
    const fn = vi.fn();
    render(
      <RowActions
        inline={[]}
        menu={[]}
        schedule={{ state: "ics_needs_duration", onScheduleIcs: fn }}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /add to calendar/i }));
    fireEvent.click(screen.getByRole("button", { name: /^30 min$/i }));
    expect(fn).toHaveBeenCalledWith(30);
  });
  it("menu variant renders the label and fires onScheduleIcs", () => {
    const fn = vi.fn();
    render(
      <ScheduleControl
        variant="menu"
        state="ics_ready_steps"
        onScheduleIcs={fn}
        label="Add to calendar (.ics)"
      />,
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Add to calendar (.ics)" }),
    );
    expect(fn).toHaveBeenCalledWith();
  });
});

describe("RowActions — Scheduled indicator", () => {
  it("renders 'Scheduled ✓' when scheduled, hides it otherwise", () => {
    const { rerender } = render(
      <RowActions inline={[]} schedule={null} menu={[]} scheduled />,
    );
    expect(screen.getByText(/scheduled ✓/i)).toBeInTheDocument();
    rerender(<RowActions inline={[]} schedule={null} menu={[]} />);
    expect(screen.queryByText(/scheduled ✓/i)).toBeNull();
  });

  it("a11y: 'Scheduled ✓' uses AA-tuned per-theme emerald (not the sub-AA emerald-600)", () => {
    render(<RowActions inline={[]} schedule={null} menu={[]} scheduled />);
    const el = screen.getByText(/scheduled ✓/i);
    expect(el.className).toContain("text-emerald-700");
    expect(el.className).toContain("dark:text-emerald-400");
    expect(el.className).not.toContain("text-emerald-600");
  });
});

describe("a11y: touch targets ≥ 44px on icon/pill controls", () => {
  const hasMinTarget = (el: HTMLElement) =>
    el.className.includes("min-h-11") && el.className.includes("min-w-11");

  it("📅 schedule icon button has a ≥44px hit area", () => {
    render(
      <RowActions
        inline={[]}
        menu={[]}
        schedule={{ state: "ready_steps", onScheduleSteps: vi.fn() }}
      />,
    );
    expect(
      hasMinTarget(screen.getByRole("button", { name: /schedule/i })),
    ).toBe(true);
  });

  it("🔽 All-options icon button has a ≥44px hit area", () => {
    render(<RowActions inline={[]} menu={[]} schedule={null} />);
    expect(
      hasMinTarget(screen.getByRole("button", { name: "All options" })),
    ).toBe(true);
  });

  it("duration preset + Go pill buttons have a ≥44px hit area", () => {
    render(
      <RowActions
        inline={[]}
        menu={[]}
        schedule={{ state: "needs_duration", onScheduleSingle: vi.fn() }}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /schedule/i }));
    expect(
      hasMinTarget(screen.getByRole("button", { name: /^30 min$/i })),
    ).toBe(true);
    expect(hasMinTarget(screen.getByRole("button", { name: /go/i }))).toBe(
      true,
    );
  });
});

describe("shape consistency: 📅 + ▾ carry the same ghost hover as Complete/Add-to-do (Duo shape fix)", () => {
  it("📅 schedule icon (ready_steps) is a borderless, hover-accent ghost control — same treatment as CompleteButton", () => {
    render(
      <RowActions
        inline={[]}
        menu={[]}
        schedule={{ state: "ready_steps", onScheduleSteps: vi.fn() }}
      />,
    );
    const btn = screen.getByRole("button", { name: /schedule/i });
    expect(btn.className).toContain("hover:bg-accent");
    expect(btn.className).toContain("rounded-md");
    expect(btn.className).not.toMatch(/\bborder\b/);
  });

  it("▾ All-options trigger is a borderless, hover-accent ghost control", () => {
    render(<RowActions inline={[]} menu={[]} schedule={null} />);
    const btn = screen.getByRole("button", { name: "All options" });
    expect(btn.className).toContain("hover:bg-accent");
    expect(btn.className).toContain("rounded-md");
    expect(btn.className).not.toMatch(/\bborder\b/);
  });
});

describe("ScheduleControl — menu variant (▾ dropdown 'Schedule' entry)", () => {
  it("ready_steps: renders a 'Schedule' text button that fires onScheduleSteps", () => {
    const fn = vi.fn();
    render(
      <ScheduleControl
        variant="menu"
        state="ready_steps"
        onScheduleSteps={fn}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Schedule" }));
    expect(fn).toHaveBeenCalledOnce();
  });

  it("needs_duration: 'Schedule' expands presets inline; picking 30 fires onScheduleSingle(30)", () => {
    const fn = vi.fn();
    render(
      <ScheduleControl
        variant="menu"
        state="needs_duration"
        onScheduleSingle={fn}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Schedule" }));
    fireEvent.click(screen.getByRole("button", { name: /^30 min$/i }));
    expect(fn).toHaveBeenCalledWith(30);
  });

  it("reconnect: renders the OAuth link even in menu variant", () => {
    render(<ScheduleControl variant="menu" state="reconnect" />);
    expect(
      screen.getByRole("link", { name: /reconnect google/i }),
    ).toHaveAttribute("href", "/api/google/oauth/start");
  });
});

// ── #106 — the Schedule menu on the Google steps path ────────────────────────
describe("ScheduleControl — the Schedule menu (#106)", () => {
  const intent: ScheduleIntent = {
    dueAt: new Date("2026-07-31T16:00:00.000Z"),
    priority: SchedulePriority.High,
    hours: ScheduleHours.Work,
    busy: true,
    units: [
      { id: "s1", order: 1, total: 2, text: "a", estMinutes: 30 },
      { id: "s2", order: 2, total: 2, text: "b", estMinutes: 30 },
    ],
  };

  it("opens the menu instead of firing immediately when steps are ready", async () => {
    const onScheduleSteps = vi.fn();
    render(
      <RowActions
        inline={[]}
        menu={[]}
        schedule={{
          state: "ready_steps",
          taskTitle: "do flex training",
          scheduleIntent: intent,
          onScheduleSteps,
        }}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: "Schedule" }));
    const dialog = screen.getByRole("dialog", { name: /do flex training/i });
    expect(onScheduleSteps).not.toHaveBeenCalled();

    await userEvent.click(
      within(dialog).getByRole("button", { name: /^schedule$/i }),
    );
    expect(onScheduleSteps).toHaveBeenCalledWith(
      expect.objectContaining({ priority: "high", hours: "work" }),
    );
  });

  it("advertises the popup on the trigger, as the duration popover does", () => {
    render(
      <RowActions
        inline={[]}
        menu={[]}
        schedule={{
          state: "ready_steps",
          taskTitle: "t",
          scheduleIntent: intent,
          onScheduleSteps: vi.fn(),
        }}
      />,
    );
    expect(screen.getByRole("button", { name: "Schedule" })).toHaveAttribute(
      "aria-haspopup",
      "dialog",
    );
  });

  // The control must never be dead: before an intent has loaded (or on a row
  // whose parent does not supply one), 📅 keeps today's immediate behaviour.
  it("falls back to firing immediately when no intent has loaded yet", async () => {
    const onScheduleSteps = vi.fn();
    render(
      <RowActions
        inline={[]}
        menu={[]}
        schedule={{
          state: "ready_steps",
          scheduleIntent: null,
          onScheduleSteps,
        }}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: "Schedule" }));
    expect(onScheduleSteps).toHaveBeenCalledOnce();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  // A guest with no Reclaim has nothing to choose beyond a deadline, and turning
  // their one-click download into a two-step dialog would be a regression.
  it("still fires the .ics path immediately — no menu, no regression for guests", async () => {
    const onScheduleIcs = vi.fn();
    render(
      <RowActions
        inline={[]}
        menu={[]}
        schedule={{
          state: "ics_ready_steps",
          taskTitle: "t",
          scheduleIntent: intent,
          onScheduleIcs,
        }}
      />,
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Add to calendar (.ics)" }),
    );
    expect(onScheduleIcs).toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("keeps the ≥44px touch target on the menu's trigger", () => {
    render(
      <RowActions
        inline={[]}
        menu={[]}
        schedule={{
          state: "ready_steps",
          taskTitle: "t",
          scheduleIntent: intent,
          onScheduleSteps: vi.fn(),
        }}
      />,
    );
    const btn = screen.getByRole("button", { name: "Schedule" });
    expect(btn.className).toContain("min-h-11");
    expect(btn.className).toContain("min-w-11");
  });

  it("pending disables the trigger, so the menu cannot be opened mid-push", () => {
    render(
      <RowActions
        inline={[]}
        menu={[]}
        schedule={{
          state: "ready_steps",
          taskTitle: "t",
          scheduleIntent: intent,
          onScheduleSteps: vi.fn(),
          pending: true,
        }}
      />,
    );
    expect(screen.getByRole("button", { name: "Schedule" })).toBeDisabled();
  });
});
