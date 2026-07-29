// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  render,
  screen,
  within,
  cleanup,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ScheduleMenu } from "./schedule-menu";
import { SchedulePriority, ScheduleHours } from "@/lib/scheduling/types";
import type { ScheduleIntent } from "@/lib/scheduling/types";

// The deadline maths (`deriveWindows`) is relative to `now`, so the clock is
// pinned: without it "is Fri 31 Jul far enough away for 1h30m of work?" changes
// answer as the calendar moves and these assertions would rot silently. Only
// `Date` is faked — userEvent needs real timers.
const NOW = new Date("2026-07-29T09:00:00.000+01:00"); // Wed, mid-morning BST

const intent: ScheduleIntent = {
  dueAt: new Date("2026-07-31T16:00:00.000Z"), // Fri 31 Jul, 17:00 BST
  priority: SchedulePriority.High,
  hours: ScheduleHours.Work,
  busy: true,
  units: [1, 2, 3].map((n) => ({
    id: `s${n}`,
    order: n,
    total: 3,
    text: `step ${n}`,
    estMinutes: 30,
  })),
};

function setup(over: Partial<React.ComponentProps<typeof ScheduleMenu>> = {}) {
  const onSchedule = vi.fn();
  const utils = render(
    <ScheduleMenu
      taskTitle="do flex training"
      intent={intent}
      showReclaimFields
      onSchedule={onSchedule}
      trigger={
        <button type="button" aria-label="Schedule">
          📅
        </button>
      }
      {...over}
    />,
  );
  return { onSchedule, ...utils };
}

async function open() {
  await userEvent.click(screen.getByRole("button", { name: "Schedule" }));
  return screen.getByRole("dialog");
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
  cleanup();
});

describe("ScheduleMenu", () => {
  it("names the dialog for screen readers and for axe's aria-dialog-name", async () => {
    setup();
    const dialog = await open();
    expect(dialog).toHaveAccessibleName(/schedule/i);
    // The task's own title, so a screen-reader user who opened the wrong row's
    // menu can tell from the dialog alone.
    expect(dialog).toHaveAccessibleName(/do flex training/i);
  });

  it("does not render the popup at all until it is opened", () => {
    setup();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("prefills from the intent it was given", async () => {
    setup();
    const dialog = await open();
    expect(within(dialog).getByLabelText(/done by/i)).toHaveValue("2026-07-31");
    expect(within(dialog).getByLabelText(/priority/i)).toHaveValue("high");
    expect(within(dialog).getByRole("radio", { name: /work/i })).toBeChecked();
    expect(
      within(dialog).getByRole("radio", { name: /personal/i }),
    ).not.toBeChecked();
  });

  it("offers every priority the vocabulary declares, labelled for humans", async () => {
    setup();
    const dialog = await open();
    const options = within(
      within(dialog).getByLabelText(/priority/i),
    ).getAllByRole("option");
    expect(options.map((o) => o.getAttribute("value"))).toEqual([
      "critical",
      "high",
      "normal",
      "low",
    ]);
    expect(options.map((o) => o.textContent)).toEqual([
      "Critical",
      "High",
      "Normal",
      "Low",
    ]);
  });

  it("shows the summary line for the prefilled intent", async () => {
    setup();
    const dialog = await open();
    const status = within(dialog).getByRole("status");
    expect(status).toHaveTextContent("3 steps");
    expect(status).toHaveTextContent("1h30m");
    // Polite, not assertive: it is recomputed on every keystroke in the date
    // field, and an assertive region would interrupt the typing it describes.
    expect(status).toHaveAttribute("aria-live", "polite");
  });

  it("hides priority and hours when only .ics is available — they do nothing there", async () => {
    setup({ showReclaimFields: false });
    const dialog = await open();
    expect(within(dialog).getByLabelText(/done by/i)).toBeInTheDocument();
    // NOT rendered, not merely disabled: a control that provably has no effect
    // on the active method should not be in the tab order at all.
    expect(within(dialog).queryByLabelText(/priority/i)).toBeNull();
    expect(within(dialog).queryByRole("radio", { name: /work/i })).toBeNull();
    expect(within(dialog).getByRole("status")).toBeInTheDocument();
  });

  it("hands back the edited intent, not the original", async () => {
    const { onSchedule } = setup();
    const dialog = await open();
    const date = within(dialog).getByLabelText(/done by/i);
    await userEvent.clear(date);
    await userEvent.type(date, "2026-08-07");
    await userEvent.selectOptions(
      within(dialog).getByLabelText(/priority/i),
      "critical",
    );
    await userEvent.click(
      within(dialog).getByRole("radio", { name: /personal/i }),
    );
    await userEvent.click(
      within(dialog).getByRole("button", { name: /^schedule$/i }),
    );

    expect(onSchedule).toHaveBeenCalledTimes(1);
    const sent = onSchedule.mock.calls[0][0] as ScheduleIntent;
    expect(sent.priority).toBe(SchedulePriority.Critical);
    expect(sent.hours).toBe(ScheduleHours.Personal);
    expect(sent.dueAt.toISOString().slice(0, 10)).toBe("2026-08-07");
    expect(sent.units).toHaveLength(3);
    // Scheduling closes the menu — the push is under way, there is nothing left
    // to edit.
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("keeps the deadline's time of day when only the date changes", async () => {
    const { onSchedule } = setup();
    const dialog = await open();
    const date = within(dialog).getByLabelText(/done by/i);
    await userEvent.clear(date);
    await userEvent.type(date, "2026-08-07");
    await userEvent.click(
      within(dialog).getByRole("button", { name: /^schedule$/i }),
    );
    // 17:00 BST on the original deadline, still 17:00 BST on the new one —
    // snapping to midnight would silently shrink the last window by a day.
    expect(
      (onSchedule.mock.calls[0][0] as ScheduleIntent).dueAt.toISOString(),
    ).toBe("2026-08-07T16:00:00.000Z");
  });

  it("warns, but still lets you schedule, when the deadline cannot fit the work", async () => {
    setup({
      intent: {
        ...intent,
        dueAt: new Date(Date.now() + 30 * 60_000),
        units: [1, 2, 3, 4, 5, 6, 7].map((n) => ({
          id: `s${n}`,
          order: n,
          total: 7,
          text: `step ${n}`,
          estMinutes: 60,
        })),
      },
    });
    const dialog = await open();
    expect(within(dialog).getByRole("status")).toHaveTextContent(/need/i);
    expect(
      within(dialog).getByRole("button", { name: /^schedule$/i }),
    ).toBeEnabled();
  });

  it("refuses to schedule with no deadline, and says why", async () => {
    const { onSchedule } = setup();
    const dialog = await open();
    await userEvent.clear(within(dialog).getByLabelText(/done by/i));

    const go = within(dialog).getByRole("button", { name: /^schedule$/i });
    expect(go).toBeDisabled();
    await userEvent.click(go);
    expect(onSchedule).not.toHaveBeenCalled();
    // Visibly, not silently — the same idiom as the duration popover's
    // out-of-range hint.
    expect(within(dialog).getByText(/pick a date/i)).toBeInTheDocument();
  });

  it("closes on Escape without scheduling", async () => {
    const { onSchedule } = setup();
    await open();
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(onSchedule).not.toHaveBeenCalled();
  });

  it("Cancel closes without scheduling", async () => {
    const { onSchedule } = setup();
    const dialog = await open();
    await userEvent.click(
      within(dialog).getByRole("button", { name: /cancel/i }),
    );
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(onSchedule).not.toHaveBeenCalled();
  });

  it("discards an abandoned edit — reopening shows the intent again, not the draft", async () => {
    setup();
    const first = await open();
    await userEvent.selectOptions(
      within(first).getByLabelText(/priority/i),
      "low",
    );
    await userEvent.keyboard("{Escape}");

    const second = await open();
    expect(within(second).getByLabelText(/priority/i)).toHaveValue("high");
  });

  // The whole point of persisting the intent: after a push the parent refreshes
  // and hands down what was just saved. Reopening has to show THAT, not the
  // values the menu was first mounted with.
  it("picks up a freshly persisted intent that arrived while it was closed", async () => {
    const { rerender } = setup();
    const first = await open();
    expect(within(first).getByLabelText(/priority/i)).toHaveValue("high");
    await userEvent.keyboard("{Escape}");

    rerender(
      <ScheduleMenu
        taskTitle="do flex training"
        intent={{ ...intent, priority: SchedulePriority.Critical }}
        showReclaimFields
        onSchedule={vi.fn()}
        trigger={
          <button type="button" aria-label="Schedule">
            📅
          </button>
        }
      />,
    );

    const second = await open();
    expect(within(second).getByLabelText(/priority/i)).toHaveValue("critical");
  });

  it("restores focus to the trigger when it closes", async () => {
    setup();
    await open();
    await userEvent.keyboard("{Escape}");
    expect(screen.getByRole("button", { name: "Schedule" })).toHaveFocus();
  });

  it("is fully operable from the keyboard", async () => {
    const { onSchedule } = setup();
    await userEvent.tab();
    expect(screen.getByRole("button", { name: "Schedule" })).toHaveFocus();
    await userEvent.keyboard("{Enter}");
    const dialog = screen.getByRole("dialog");
    expect(dialog).toBeInTheDocument();

    // Opening lands on the first field, so the deadline can be changed without
    // a single Tab — then Tab walks the rest in reading order and reaches the
    // primary action. (A radio group takes one tab stop, as native radios do.)
    // Base UI moves initial focus in an effect, so this is a wait, not a read.
    await waitFor(() =>
      expect(within(dialog).getByLabelText(/done by/i)).toHaveFocus(),
    );
    const rest = [
      within(dialog).getByLabelText(/priority/i),
      within(dialog).getByRole("radio", { name: /work/i }),
      within(dialog).getByRole("button", { name: /cancel/i }),
      within(dialog).getByRole("button", { name: /^schedule$/i }),
    ];
    for (const control of rest) {
      await userEvent.tab();
      expect(control).toHaveFocus();
    }
    await userEvent.keyboard("{Enter}");
    expect(onSchedule).toHaveBeenCalled();
  });

  it("switches the hours category with the arrow keys, as a radiogroup must", async () => {
    const { onSchedule } = setup();
    const dialog = await open();
    await userEvent.click(within(dialog).getByRole("radio", { name: /work/i }));
    await userEvent.keyboard("{ArrowRight}");
    expect(
      within(dialog).getByRole("radio", { name: /personal/i }),
    ).toBeChecked();
    await userEvent.click(
      within(dialog).getByRole("button", { name: /^schedule$/i }),
    );
    expect((onSchedule.mock.calls[0][0] as ScheduleIntent).hours).toBe(
      ScheduleHours.Personal,
    );
  });

  it("disables the primary action while a push is in flight", async () => {
    setup({ pending: true });
    const dialog = await open();
    expect(
      within(dialog).getByRole("button", { name: /^schedule$/i }),
    ).toBeDisabled();
  });

  it("gives every control a ≥44px touch target (WCAG 2.5.5)", async () => {
    setup();
    const dialog = await open();
    const hasMinTarget = (el: HTMLElement) => el.className.includes("min-h-11");
    for (const control of [
      within(dialog).getByLabelText(/done by/i),
      within(dialog).getByLabelText(/priority/i),
      within(dialog).getByRole("radio", { name: /work/i }).closest("label"),
      within(dialog)
        .getByRole("radio", { name: /personal/i })
        .closest("label"),
      within(dialog).getByRole("button", { name: /^schedule$/i }),
      within(dialog).getByRole("button", { name: /cancel/i }),
    ]) {
      expect(hasMinTarget(control as HTMLElement)).toBe(true);
    }
  });

  // Row popups sit inside the action line's phrasing content, so a `<div>` there
  // is invalid markup (and would close an enclosing `<p>` early) — the same
  // constraint row-actions.tsx's popovers already carry.
  it("renders no <div> — the popup lives inside phrasing content", async () => {
    const { container } = setup();
    await open();
    expect(container.querySelectorAll("div")).toHaveLength(0);
  });
});
