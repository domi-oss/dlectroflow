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
import { GOOGLE_ACCOUNT_HINT } from "@/components/integrations/google-account-hint";
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

  // ── #253 — the trailing icon cluster is gone ─────────────────────────────
  //
  // `move` / `schedule` / `del` used to render 📥 / 📅 / 🗑 in a `flex-nowrap`
  // group pinned right of the inline actions. All three were duplicates of menu
  // entries the ▾ list already carried, and at 360px the group wrapped onto a
  // band of its own — a third row of controls on every card, for nothing new.
  //
  // The props are REMOVED rather than left rendering nothing. A prop that is
  // still accepted but has no render site is how #213 came to describe a fix in
  // terms of `schedule=`, whose only render path was `row-actions.tsx:504`.
  it("renders exactly one control of its own: the ▾ trigger, after the inline actions", () => {
    render(
      <RowActions
        inline={[<button key="a">First</button>]}
        menu={[<button key="m">Delete</button>]}
      />,
    );
    const names = screen
      .getAllByRole("button")
      .map((b) => b.getAttribute("aria-label") ?? b.textContent);
    expect(names).toEqual(["First", "All options"]);
  });

  it("the ▾ trigger is pinned right on its OWN wrapper — no cluster group around it", () => {
    const { container } = render(
      <RowActions
        inline={[<button key="a">First</button>]}
        menu={[<button key="m">Move to…</button>]}
      />,
    );
    const line = container.querySelector("[data-row-actions]")!;
    const trigger = screen.getByRole("button", { name: "All options" });
    // `data-row-menu` is the stable hook the popup's markup is asserted through,
    // replacing the `.flex-nowrap` class the old cluster was found by — a class
    // is a styling decision and this is a structural one, which is the same
    // reasoning `data-row-actions` carries on the line itself.
    const pinned = trigger.closest("[data-row-menu]");
    expect(pinned).not.toBeNull();
    expect(pinned!.className).toContain("ml-auto");
    expect(pinned!.className).toContain("shrink-0");
    expect(line.lastElementChild).toBe(pinned);
    // The `flex-nowrap` group existed to stop the cluster splitting mid-way and
    // stranding this trigger with a mis-anchored popover. One control cannot
    // split, so the group is gone rather than kept as a one-child wrapper.
    expect(trigger.closest(".flex-nowrap")).toBeNull();
  });

  it("▾ trigger is labeled 'All options' and opens the dismissable list of menu entries verbatim", () => {
    render(
      <RowActions
        inline={[]}
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
      <RowActions inline={[]} menu={[<button key="m1">Move to…</button>]} />,
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
        <RowActions inline={[]} menu={[<button key="m1">Move to…</button>]} />
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
      <RowActions inline={[]} menu={[<button key="m1">Move to…</button>]} />,
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
      <ScheduleControl state="ready_steps" onScheduleSteps={vi.fn()} />,
    );
    // ready_steps acts immediately — no popup, so nothing to advertise.
    expect(
      screen.getByRole("button", { name: /schedule/i }),
    ).not.toHaveAttribute("aria-haspopup");
    unmount();

    render(
      <ScheduleControl state="needs_duration" onScheduleSingle={vi.fn()} />,
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
      <RowActions inline={[]} menu={[<button key="m1">Move to…</button>]} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "All options" }));
    // #253 — anchored on `data-row-menu` now that the `.flex-nowrap` cluster
    // this used to find is gone. Same question, and it still has to be asked of
    // the element the popup is PORTALED into: Base UI renders the positioner and
    // popup inside that container, so a `div` appearing there is what would
    // break the enclosing phrasing content.
    const menuHost = container.querySelector("[data-row-menu]")!;
    expect(menuHost.querySelectorAll("div")).toHaveLength(0);
  });

  it('never renders role="menu", even with the ▾ popover open', () => {
    render(
      <RowActions inline={[]} menu={[<button key="m1">Move to…</button>]} />,
    );
    expect(screen.queryByRole("menu")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "All options" }));
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("ready_steps: 📅 fires onScheduleSteps immediately", () => {
    const fn = vi.fn();
    render(<ScheduleControl state="ready_steps" onScheduleSteps={fn} />);
    fireEvent.click(screen.getByRole("button", { name: /schedule/i }));
    expect(fn).toHaveBeenCalledOnce();
  });

  it("needs_duration: 📅 opens the popover; picking 30 fires onScheduleSingle(30)", () => {
    const fn = vi.fn();
    render(<ScheduleControl state="needs_duration" onScheduleSingle={fn} />);
    fireEvent.click(screen.getByRole("button", { name: /schedule/i }));
    fireEvent.click(screen.getByRole("button", { name: /^30 min$/i }));
    expect(fn).toHaveBeenCalledWith(30);
  });

  it("Duo a11y fix: needs_duration 📅 uses aria-haspopup='dialog' (focus-capturing popover, no role=menu)", () => {
    render(
      <ScheduleControl state="needs_duration" onScheduleSingle={vi.fn()} />,
    );
    expect(screen.getByRole("button", { name: /schedule/i })).toHaveAttribute(
      "aria-haspopup",
      "dialog",
    );
  });

  it("custom duration input schedules with the typed minutes", () => {
    const fn = vi.fn();
    render(<ScheduleControl state="needs_duration" onScheduleSingle={fn} />);
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
      <ScheduleControl
        state="ready_steps"
        onScheduleSteps={fn}
        pending={true}
      />,
    );
    const scheduleButton = screen.getByRole("button", { name: /schedule/i });
    expect(scheduleButton).toBeDisabled();
    fireEvent.click(scheduleButton);
    expect(fn).not.toHaveBeenCalled();
  });

  it("custom duration input has min/max/step bounds and visibly refuses minutes over 480", () => {
    const fn = vi.fn();
    render(<ScheduleControl state="needs_duration" onScheduleSingle={fn} />);
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
    render(<ScheduleControl state="needs_duration" onScheduleSingle={fn} />);
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
      <ScheduleControl state="needs_duration" onScheduleSingle={vi.fn()} />,
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
      <ScheduleControl state="needs_duration" onScheduleSingle={vi.fn()} />,
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
      <ScheduleControl state="needs_duration" onScheduleSingle={vi.fn()} />,
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
      <ScheduleControl
        state="needs_duration"
        onScheduleSingle={onScheduleSingle}
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
    render(<ScheduleControl state="reconnect" />);
    expect(
      screen.getByRole("link", { name: /reconnect google/i }),
    ).toHaveAttribute("href", "/api/google/oauth/start");
  });

  // #253 removed "no schedule prop → no 📅 control (guest rows)" and the v6
  // "end cluster … renders in order: move, schedule, delete, then 🔽" ordering
  // test. Both asserted the shape of a cluster this component no longer has, and
  // the guest case they protected is now structural: there is no 📅 on any row,
  // connected or not. What replaces them is the pair at the top of this describe
  // ("renders exactly one control of its own" + "pinned right on its OWN
  // wrapper"), plus the caller-level assertions in inbox-view.test.tsx that every
  // one of the three dropped icons is still reachable from the ▾ list.
});

describe("ScheduleControl — ICS states", () => {
  it("ics_ready_steps: 📅 fires onScheduleIcs() immediately (icon variant, aria 'Add to calendar')", () => {
    const fn = vi.fn();
    render(<ScheduleControl state="ics_ready_steps" onScheduleIcs={fn} />);
    fireEvent.click(screen.getByRole("button", { name: /add to calendar/i }));
    expect(fn).toHaveBeenCalledWith();
  });
  it("ics_needs_duration: opens the popover; picking 30 fires onScheduleIcs(30)", () => {
    const fn = vi.fn();
    render(<ScheduleControl state="ics_needs_duration" onScheduleIcs={fn} />);
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
    const { rerender } = render(<RowActions inline={[]} menu={[]} scheduled />);
    expect(screen.getByText(/scheduled ✓/i)).toBeInTheDocument();
    rerender(<RowActions inline={[]} menu={[]} />);
    expect(screen.queryByText(/scheduled ✓/i)).toBeNull();
  });

  it("a11y: 'Scheduled ✓' uses AA-tuned per-theme emerald (not the sub-AA emerald-600)", () => {
    render(<RowActions inline={[]} menu={[]} scheduled />);
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
    render(<ScheduleControl state="ready_steps" onScheduleSteps={vi.fn()} />);
    expect(
      hasMinTarget(screen.getByRole("button", { name: /schedule/i })),
    ).toBe(true);
  });

  it("🔽 All-options icon button has a ≥44px hit area", () => {
    render(<RowActions inline={[]} menu={[]} />);
    expect(
      hasMinTarget(screen.getByRole("button", { name: "All options" })),
    ).toBe(true);
  });

  it("duration preset + Go pill buttons have a ≥44px hit area", () => {
    render(
      <ScheduleControl state="needs_duration" onScheduleSingle={vi.fn()} />,
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
    render(<ScheduleControl state="ready_steps" onScheduleSteps={vi.fn()} />);
    const btn = screen.getByRole("button", { name: /schedule/i });
    expect(btn.className).toContain("hover:bg-accent");
    expect(btn.className).toContain("rounded-md");
    expect(btn.className).not.toMatch(/\bborder\b/);
  });

  it("▾ All-options trigger is a borderless, hover-accent ghost control", () => {
    render(<RowActions inline={[]} menu={[]} />);
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
      <ScheduleControl
        state="ready_steps"
        taskTitle="do flex training"
        scheduleIntent={intent}
        onScheduleSteps={onScheduleSteps}
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
      <ScheduleControl
        state="ready_steps"
        taskTitle="t"
        scheduleIntent={intent}
        onScheduleSteps={vi.fn()}
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
      <ScheduleControl
        state="ready_steps"
        scheduleIntent={null}
        onScheduleSteps={onScheduleSteps}
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
      <ScheduleControl
        state="ics_ready_steps"
        taskTitle="t"
        scheduleIntent={intent}
        onScheduleIcs={onScheduleIcs}
      />,
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Add to calendar (.ics)" }),
    );
    expect(onScheduleIcs).toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  // #253 — the regression guard for the branch reorder. The 📅 icon was the ONLY
  // route to this dialog until #253 deleted it, so without this the whole of #106
  // would have become unreachable from an inbox row while every label still read
  // correctly and every existing test still passed.
  it("the ▾-list entry opens the same dialog, so #253 did not delete #106", async () => {
    const onScheduleSteps = vi.fn();
    render(
      <ScheduleControl
        variant="menu"
        label="Schedule"
        state="ready_steps"
        taskTitle="do flex training"
        scheduleIntent={intent}
        onScheduleSteps={onScheduleSteps}
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

  // With no intent resolved yet the ▾ entry keeps firing immediately, exactly as
  // the icon did — a control that is dead while data is in flight is worse than
  // one that pushes the server-resolved defaults.
  it("the ▾-list entry still fires immediately when no intent has loaded", async () => {
    const onScheduleSteps = vi.fn();
    render(
      <ScheduleControl
        variant="menu"
        label="Schedule"
        state="ready_steps"
        scheduleIntent={null}
        onScheduleSteps={onScheduleSteps}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: "Schedule" }));
    expect(onScheduleSteps).toHaveBeenCalledOnce();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("keeps the ≥44px touch target on the menu's trigger", () => {
    render(
      <ScheduleControl
        state="ready_steps"
        taskTitle="t"
        scheduleIntent={intent}
        onScheduleSteps={vi.fn()}
      />,
    );
    const btn = screen.getByRole("button", { name: "Schedule" });
    expect(btn.className).toContain("min-h-11");
    expect(btn.className).toContain("min-w-11");
  });

  it("pending disables the trigger and says why, so the menu cannot be opened mid-push", () => {
    render(
      <ScheduleControl
        state="ready_steps"
        taskTitle="t"
        scheduleIntent={intent}
        onScheduleSteps={vi.fn()}
        pending={true}
      />,
    );
    const trigger = screen.getByRole("button", { name: /^Schedule\b/ });
    expect(trigger).toBeDisabled();
    // #169 — the reason travels with the control. `pending` used to be one
    // list-wide flag, so the only true sentence would have been "something,
    // somewhere, is busy"; it now means one row, so the control names it. A
    // disabled button is skipped by most screen readers, which is why this
    // rides on the accessible NAME rather than on `aria-describedby`.
    expect(trigger).toHaveAccessibleName(
      "Schedule — already in progress for this row",
    );
    expect(trigger).toHaveAttribute(
      "title",
      trigger.getAttribute("aria-label"),
    );
    expect(trigger).toHaveAttribute("aria-busy", "true");
  });

  it("an idle trigger carries no busy wording and no aria-busy", () => {
    // The other half of the pair: the reason must appear only while it is
    // true, or it is just noise on every row of the list (#169).
    render(
      <ScheduleControl
        state="ready_steps"
        taskTitle="t"
        scheduleIntent={intent}
        onScheduleSteps={vi.fn()}
      />,
    );
    const trigger = screen.getByRole("button", { name: "Schedule" });
    expect(trigger).toBeEnabled();
    expect(trigger).not.toHaveAttribute("aria-busy");
  });
});

// ── #128 — which Google account to connect ───────────────────────────────────
// A managed work account can be refused by its own administrator at Google's
// consent step: no callback comes back, so there is no error state to render
// and nothing in the logs. The only fix is preventive copy before the click —
// but this control is repeated once per inbox row, so WHERE the sentence is
// visible depends on how much room the variant has.
describe("ScheduleControl — the pick-your-account hint (#128)", () => {
  const hintFor = (link: HTMLElement) =>
    document.getElementById(link.getAttribute("aria-describedby") ?? "");

  it("menu variant: the ▾ column has room, so the hint is visible and described", () => {
    render(<ScheduleControl variant="menu" state="connect" />);
    const link = screen.getByRole("link", { name: /connect google/i });
    expect(hintFor(link)).toHaveTextContent(GOOGLE_ACCOUNT_HINT);
  });

  it("menu variant: reconnect carries it too — an admin can block an app that used to work", () => {
    render(<ScheduleControl variant="menu" state="reconnect" />);
    const link = screen.getByRole("link", { name: /reconnect google/i });
    expect(hintFor(link)).toHaveTextContent(GOOGLE_ACCOUNT_HINT);
  });

  it("icon variant: no per-row paragraph — the hint rides on title instead", () => {
    // Every unconnected row renders this link. A visible sentence on each one
    // would be the same paragraph a dozen times down the page, so the compact
    // control keeps the guidance as its accessible description via `title`
    // (the same tooltip mechanism the 📅 / Scheduled ✓ controls already use).
    render(<ScheduleControl state="connect" />);
    const link = screen.getByRole("link", { name: /connect google/i });
    expect(link).toHaveAttribute("title", GOOGLE_ACCOUNT_HINT);
    expect(link).not.toHaveAttribute("aria-describedby");
    expect(screen.queryByText(GOOGLE_ACCOUNT_HINT)).toBeNull();
  });

  it("accountHintId: a caller rendering its own hint owns the association", () => {
    // The task working view wraps this control in a bordered pill, so its hint
    // has to live OUTSIDE the control — it passes the id in rather than
    // leaving the guidance as loose text beside the link.
    render(
      <>
        <ScheduleControl state="connect" accountHintId="task-hint" />
        <span id="task-hint">{GOOGLE_ACCOUNT_HINT}</span>
      </>,
    );
    const link = screen.getByRole("link", { name: /connect google/i });
    expect(link).toHaveAttribute("aria-describedby", "task-hint");
    // No duplicate description: `title` would be a second, competing one.
    expect(link).not.toHaveAttribute("title");
  });

  it("says nothing about accounts once there is nothing to connect", () => {
    render(
      <ScheduleControl
        variant="menu"
        state="ready_steps"
        onScheduleSteps={vi.fn()}
      />,
    );
    expect(screen.queryByText(GOOGLE_ACCOUNT_HINT)).toBeNull();
  });
});

// #183 sweep — the same shape as the brain-dump input: a placeholder standing
// in for a name. One line, and the popup it lives in already says "duration",
// so the field only has to name itself within that context.
describe("ScheduleControl — the custom-duration input is named (#183)", () => {
  it("has a computed accessible name, not just placeholder='min'", async () => {
    const user = userEvent.setup();
    render(
      <ScheduleControl state="needs_duration" onScheduleSingle={vi.fn()} />,
    );
    await user.click(screen.getByRole("button", { name: "Schedule" }));
    const field = await screen.findByRole("spinbutton", {
      name: "Custom duration in minutes",
    });
    expect(field.getAttribute("placeholder")).toBe("min");
  });
});
