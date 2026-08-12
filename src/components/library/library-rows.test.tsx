// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  render,
  screen,
  cleanup,
  fireEvent,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { LibraryRows } from "@/components/library/library-rows";
import type { Item } from "@/components/inbox/bucket";
import type { AgingSettings } from "@/lib/aging";

const push = vi.fn();
const refresh = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push, refresh }),
}));

// Reuse the Inbox's real, workspace-scoped server actions — mocked here so the
// wiring (which action fires + refresh/navigation) is observable.
vi.mock("@/app/actions/braindump", () => ({
  ensureFocusStep: vi.fn().mockResolvedValue(null),
  completeItem: vi.fn().mockResolvedValue(undefined),
  deleteBrainDumpItem: vi.fn().mockResolvedValue(undefined),
  bulkBrainDumpAction: vi.fn().mockResolvedValue({ count: 1 }),
  setItemEstimate: vi.fn().mockResolvedValue(undefined),
}));

import {
  ensureFocusStep,
  completeItem,
  deleteBrainDumpItem,
  bulkBrainDumpAction,
  setItemEstimate,
} from "@/app/actions/braindump";

const settings: AgingSettings = {
  agingThresholdMinutes: 60,
  demoOverrideSeconds: null,
  agingHours: 24,
  overdueHours: 48,
  wayOverdueHours: 72,
};

function makeItem(overrides: Partial<Item> & { id: string }): Item {
  return {
    text: overrides.id,
    createdAt: new Date(Date.now() - 3600_000),
    status: "triaged",
    triagedAt: null,
    remindedAt: null,
    snoozedUntil: null,
    taskId: null,
    freshenedAt: null,
    promptDismissedAt: null,
    breakdownRequestedAt: null,
    stepsTotal: 0,
    stepsDone: 0,
    taskStatus: null,
    completedAt: null,
    scheduledAt: null,
    estMinutes: null,
    steps: [],
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});
afterEach(cleanup);

const NOW = Date.now();

describe("LibraryRows — per-row actions (reuses Inbox wiring)", () => {
  it("Start focusing ensures a step, then navigates to the focus timer", async () => {
    vi.mocked(ensureFocusStep).mockResolvedValue("step-9");
    const user = userEvent.setup();
    render(
      <LibraryRows
        items={[makeItem({ id: "plated-1" })]}
        tab="plated"
        voice="plain"
        now={NOW}
        settings={settings}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Start focusing" }));

    await waitFor(() =>
      expect(ensureFocusStep).toHaveBeenCalledWith("plated-1"),
    );
    expect(push).toHaveBeenCalledWith("/focus/step-9");
  });

  it("Complete marks the item done and refreshes", async () => {
    const user = userEvent.setup();
    render(
      <LibraryRows
        items={[makeItem({ id: "plated-1" })]}
        tab="plated"
        voice="plain"
        now={NOW}
        settings={settings}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Complete" }));

    await waitFor(() => expect(completeItem).toHaveBeenCalledWith("plated-1"));
    expect(refresh).toHaveBeenCalled();
  });

  it("Delete is a two-step confirm (first tap arms, second tap deletes)", async () => {
    const user = userEvent.setup();
    render(
      <LibraryRows
        items={[makeItem({ id: "plated-1" })]}
        tab="plated"
        voice="plain"
        now={NOW}
        settings={settings}
      />,
    );

    // First tap: arms the confirm — nothing deleted yet, Cancel now visible.
    await user.click(screen.getByRole("button", { name: "Delete" }));
    expect(deleteBrainDumpItem).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeInTheDocument();

    // Second tap on the confirming Delete actually deletes.
    await user.click(screen.getByRole("button", { name: "Delete" }));
    await waitFor(() =>
      expect(deleteBrainDumpItem).toHaveBeenCalledWith("plated-1"),
    );
  });

  it("Cancel aborts the delete without calling the action", async () => {
    const user = userEvent.setup();
    render(
      <LibraryRows
        items={[makeItem({ id: "plated-1" })]}
        tab="plated"
        voice="plain"
        now={NOW}
        settings={settings}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Delete" }));
    await user.click(screen.getByRole("button", { name: "Cancel" }));

    expect(deleteBrainDumpItem).not.toHaveBeenCalled();
    // Back to the armed-again state: the 🗑 Delete control is present once more.
    expect(screen.getByRole("button", { name: "Delete" })).toBeInTheDocument();
  });

  it("the same actions are available on Saved-for-later (pantry) rows", async () => {
    const user = userEvent.setup();
    render(
      <LibraryRows
        items={[
          makeItem({
            id: "pantry-1",
            status: "inbox",
            snoozedUntil: new Date(Date.now() + 86_400_000),
          }),
        ]}
        tab="pantry"
        voice="plain"
        now={NOW}
        settings={settings}
      />,
    );

    expect(
      screen.getByRole("button", { name: "Start focusing" }),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Complete" }));
    await waitFor(() => expect(completeItem).toHaveBeenCalledWith("pantry-1"));
  });

  it("pantry rows show no Select button, meta, or estimate pill (unchanged behavior)", () => {
    render(
      <LibraryRows
        items={[
          makeItem({
            id: "pantry-1",
            status: "inbox",
            snoozedUntil: new Date(Date.now() + 86_400_000),
          }),
        ]}
        tab="pantry"
        voice="plain"
        now={NOW}
        settings={settings}
      />,
    );
    expect(screen.queryByRole("button", { name: /^select$/i })).toBeNull();
    expect(screen.queryByText(/≈\d+ min/)).toBeNull();
    expect(screen.getByText(/wakes/i)).toBeInTheDocument();
  });
});

describe("LibraryRows (plated) — meta, editable estimate, select mode", () => {
  it("shows a 5-min default estimate that persists on edit", () => {
    render(
      <LibraryRows
        items={[makeItem({ id: "a", text: "todo a", estMinutes: null })]}
        tab="plated"
        voice="plain"
        now={NOW}
        settings={settings}
      />,
    );
    expect(screen.getByText(/≈5 min/)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /edit estimate/i }));
    const input = screen.getByRole("spinbutton", { name: /edit estimate/i });
    fireEvent.change(input, { target: { value: "20" } });
    fireEvent.blur(input);

    expect(setItemEstimate).toHaveBeenCalledWith("a", 20);
  });

  it("entering a non-numeric or empty value does not persist an estimate", () => {
    render(
      <LibraryRows
        items={[makeItem({ id: "a", text: "todo a", estMinutes: null })]}
        tab="plated"
        voice="plain"
        now={NOW}
        settings={settings}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /edit estimate/i }));
    const input = screen.getByRole("spinbutton", { name: /edit estimate/i });

    // A type="number" input sanitizes an invalid string to "" before onChange
    // fires, so "abc" ends up as val = 0 (Number("") = 0) here too — the
    // val > 0 guard blocks it regardless of whether it arrives as 0 or NaN.
    fireEvent.change(input, { target: { value: "abc" } });
    fireEvent.blur(input);
    expect(setItemEstimate).not.toHaveBeenCalled();

    // Re-open and clear the field entirely — same "" → 0 path, should not
    // persist a "0 min" estimate.
    fireEvent.click(screen.getByRole("button", { name: /edit estimate/i }));
    const input2 = screen.getByRole("spinbutton", { name: /edit estimate/i });
    fireEvent.change(input2, { target: { value: "" } });
    fireEvent.blur(input2);
    expect(setItemEstimate).not.toHaveBeenCalled();
  });

  // #51 — the title is the dominant row text (larger + heavier); metadata
  // (age/estimate) recedes to text-xs, matching the inbox treatment.
  it("#51: the task title is the dominant row text (text-base font-semibold)", () => {
    render(
      <LibraryRows
        items={[makeItem({ id: "a", text: "todo a" })]}
        tab="plated"
        voice="plain"
        now={NOW}
        settings={settings}
      />,
    );
    const title = screen.getByText("todo a");
    expect(title.className).toMatch(/text-base/);
    expect(title.className).toMatch(/font-semibold/);
  });

  it("select mode → complete calls bulkBrainDumpAction with the ticked ids", async () => {
    render(
      <LibraryRows
        items={[
          makeItem({ id: "a", text: "todo a", estMinutes: null }),
          makeItem({ id: "b", text: "todo b", estMinutes: 10 }),
        ]}
        tab="plated"
        voice="plain"
        now={NOW}
        settings={settings}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /^select$/i }));
    fireEvent.click(screen.getByRole("checkbox", { name: /todo a/i }));
    // The bulk bar is the ONE surface that calls `t("action.complete")` without
    // going through `CompleteButton` (select-action-bar.tsx), which is why #253
    // treated the detick as a strings change with consumers.
    fireEvent.click(screen.getByRole("button", { name: /^complete$/i }));

    await waitFor(() =>
      expect(bulkBrainDumpAction).toHaveBeenCalledWith(["a"], "complete"),
    );
  });
});

// ── #44 — the note affordance on a SINGLE-STEP task row ─────────────────────
//
// The gap the owner found on the review app: multi-step tasks reached the note
// through their expanded step list, and single-step ones — which are real
// `Task` rows with a real `notes` column — had no route to it at all outside
// /tasks/[id]. The component tests for `NoteField` all passed throughout,
// because a component test cannot see a surface that never mounts the
// component. These assert PRESENCE on the surface.
describe("LibraryRows — the note affordance (#44)", () => {
  it("offers a note on a task-backed plated row, named after the task", () => {
    render(
      <LibraryRows
        items={[
          makeItem({ id: "p1", text: "Renew the passport", taskId: "t1" }),
        ]}
        tab="plated"
        voice="plain"
        now={Date.now()}
        settings={settings}
      />,
    );
    expect(
      screen.getByRole("button", { name: "Note for Renew the passport" }),
    ).toBeTruthy();
  });

  it("shows an existing note as text without expanding anything", () => {
    render(
      <LibraryRows
        items={[
          makeItem({
            id: "p1",
            text: "Renew the passport",
            taskId: "t1",
            notes: "photo booth on the high street",
          }),
        ]}
        tab="plated"
        voice="plain"
        now={Date.now()}
        settings={settings}
      />,
    );
    expect(screen.getByTestId("note-text").textContent).toBe(
      "photo booth on the high street",
    );
  });

  it("offers no note on a row with no Task behind it", () => {
    // A saved-for-later brain-dump item that has never been triaged has no
    // `Task` row, so there is no `notes` column to write to. The affordance is
    // absent rather than present-and-failing.
    render(
      <LibraryRows
        items={[makeItem({ id: "s1", text: "someday maybe", taskId: null })]}
        tab="pantry"
        voice="plain"
        now={Date.now()}
        settings={settings}
      />,
    );
    expect(screen.queryByRole("button", { name: /^note for/i })).toBeNull();
  });

  it("offers a note on a task-backed pantry row", () => {
    render(
      <LibraryRows
        items={[makeItem({ id: "s2", text: "later thing", taskId: "t2" })]}
        tab="pantry"
        voice="plain"
        now={Date.now()}
        settings={settings}
      />,
    );
    expect(
      screen.getByRole("button", { name: "Note for later thing" }),
    ).toBeTruthy();
  });
});

// ── #44 — WHERE the collapsed trigger sits (owner request, review app) ──────
//
// It shipped on its own line under the action row. The owner asked for it in
// the action group beside Complete. Pinned here because "which container is
// this button in" is invisible to every behavioural test — the disclosure
// worked correctly in both placements, which is exactly why it needs a test of
// its own rather than being left to survive on somebody remembering.
describe("LibraryRows — the note trigger sits in the action group (#44)", () => {
  const renderRow = (over: Partial<Item> = {}) =>
    render(
      <LibraryRows
        items={[
          makeItem({ id: "p1", text: "Prep the deck", taskId: "t1", ...over }),
        ]}
        tab="plated"
        voice="plain"
        now={Date.now()}
        settings={settings}
      />,
    );

  it("puts the trigger in the SAME action group as Complete", () => {
    renderRow();
    const complete = screen.getByRole("button", { name: "Complete" });
    const trigger = screen.getByRole("button", {
      name: "Note for Prep the deck",
    });
    const group = complete.closest("[data-row-actions]");
    expect(group).not.toBeNull();
    expect(trigger.closest("[data-row-actions]")).toBe(group);
  });

  it("keeps the editor body OUT of the action group, below the row", async () => {
    // The textarea cannot live in a one-line flex row. It opens underneath —
    // but it must still read as belonging to THIS row, so it stays inside the
    // same <li> while sitting outside the action line.
    const user = userEvent.setup();
    renderRow();
    await user.click(
      screen.getByRole("button", { name: "Note for Prep the deck" }),
    );
    const box = screen.getByRole("textbox");
    expect(box.closest("[data-row-actions]")).toBeNull();
    expect(box.closest("li")).toBe(
      screen.getByRole("button", { name: "Complete" }).closest("li"),
    );
  });

  it("keeps the save indicator with the trigger, not loose in the row", async () => {
    // It reports on the NOTE. Left behind in the row it would read as the row's
    // own status — "Saved ✓" next to Complete means something else entirely.
    const user = userEvent.setup();
    renderRow();
    const trigger = screen.getByRole("button", {
      name: "Note for Prep the deck",
    });
    await user.click(trigger);
    await user.type(screen.getByRole("textbox"), "hi");
    const indicator = await waitFor(() => {
      const el = document.querySelector("[data-save-status]");
      expect(el).not.toBeNull();
      return el as HTMLElement;
    });
    expect(trigger.parentElement?.contains(indicator)).toBe(true);
  });

  it("still resolves aria-controls while collapsed, and keeps the 44px target", () => {
    renderRow();
    const trigger = screen.getByRole("button", {
      name: "Note for Prep the deck",
    });
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    const controls = trigger.getAttribute("aria-controls") as string;
    expect(document.getElementById(controls)).not.toBeNull();
    expect(trigger.className).toContain("min-h-11");
  });

  it("shows a saved note as text below the row, not inside the action group", () => {
    renderRow({ notes: "bring the printed copy" });
    const text = screen.getByTestId("note-text");
    expect(text.closest("[data-row-actions]")).toBeNull();
    expect(text.closest("li")).not.toBeNull();
  });
});

// ── #184's rule, applied to the hub's own rows (folded in on #251) ──────────
//
// `inbox-view.test.tsx` measures EVERY control in `[data-row-actions]` and says
// why: !270 checked one control and the buttons either side of it were 24px. This
// file only ever checked the note trigger, and the 🗑 beside it was one of the
// ones that got missed — a 24px delete target on a phone, next to a 44px note
// trigger, on a surface that has shipped. Asserted over the whole group here for
// the same reason it is there, rather than adding a second single-control check.
//
// jsdom computes no layout, so this checks the classes that produce the box.
describe("LibraryRows — every control in the action group is a 44px target", () => {
  const expectFullTargets = (scope: HTMLElement) => {
    const groups = scope.querySelectorAll<HTMLElement>("[data-row-actions]");
    expect(groups.length).toBeGreaterThan(0);
    for (const group of Array.from(groups)) {
      const controls = group.querySelectorAll<HTMLElement>("button, a");
      expect(controls.length).toBeGreaterThan(0);
      for (const control of Array.from(controls)) {
        const name = control.getAttribute("aria-label") ?? control.textContent;
        expect(control.className, `"${name}" is under 44px tall`).toContain(
          "min-h-11",
        );
        expect(control.className, `"${name}" is under 44px wide`).toContain(
          "min-w-11",
        );
      }
    }
  };

  const renderTab = (tab: "plated" | "pantry") =>
    render(
      <LibraryRows
        items={[makeItem({ id: `${tab}-1`, taskId: "t1" })]}
        tab={tab}
        voice="plain"
        now={NOW}
        settings={settings}
      />,
    );

  it.each(["plated", "pantry"] as const)("%s rows, at rest", (tab) => {
    const { container } = renderTab(tab);
    expectFullTargets(container);
  });

  it("and the armed delete confirm, which replaces a 44px control", async () => {
    // The pair takes the 🗑's place, so a smaller pair shrinks the action line
    // under the pointer at exactly the moment a mis-tap deletes something.
    const user = userEvent.setup();
    renderTab("plated");
    await user.click(screen.getByRole("button", { name: "Delete" }));
    for (const name of ["Delete", "Cancel"]) {
      const control = screen.getByRole("button", { name });
      expect(control.className, `"${name}" is under 44px tall`).toContain(
        "min-h-11",
      );
      expect(control.className, `"${name}" is under 44px wide`).toContain(
        "min-w-11",
      );
    }
  });
});
