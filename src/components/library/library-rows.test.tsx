// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  render,
  screen,
  cleanup,
  fireEvent,
  waitFor,
  within,
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

  /**
   * #253 — the ▾ is this row's CANONICAL action list, and this spec exists because
   * nothing here asserted its contents at all: a mid-issue pass reduced the list to
   * `[delete]` alone and the whole suite stayed green.
   *
   * The owner's principle is that the ▾ holds everything a row can do and the inline
   * bar is a shortcut subset of it — so both twins are restored, and this is asserted
   * as an exact ordered list because completeness is the claim.
   *
   * DERIVED for this surface rather than copied from the inbox's eight, and the three
   * absences are asserted too, so a later "consistency" pass cannot quietly add
   * capability this surface has no plumbing for:
   *   • no `Move to…` — there is no bucket-move dispatcher on this page at all;
   *   • no `Add as multi-step to-do` / `Add as single-task to-do` — both tabs are
   *     already triaged, so one names what the row is and the other has no handler;
   *   • no `Edit time estimate` — `EstimateEditor` is a permanently-visible 44px
   *     control on the row's meta line, so a ▾ twin would be the `editMenuItem`
   *     mirror the owner had removed. (`task-steps.tsx` keeps its estimate entry
   *     because there the estimate is a plain `<span>` and the entry is the only
   *     route — same test, opposite answer, which is what makes it a test.)
   */
  it.each(["plated", "pantry"] as const)(
    "%s: the ▾ is the row's canonical actions, in order, grouped, all 44px",
    async (tab) => {
      const user = userEvent.setup();
      render(
        <LibraryRows
          items={[makeItem({ id: "row-1" })]}
          tab={tab}
          voice="plain"
          now={NOW}
          settings={settings}
        />,
      );
      await user.click(screen.getByRole("button", { name: "All options" }));
      const popup = screen.getByRole("dialog", { name: "All options" });
      const entries = within(popup).getAllByRole("button");
      expect(entries.map((b) => b.textContent)).toEqual([
        "Start visual focus timer",
        "Mark as completed",
        "Delete",
      ]);
      for (const entry of entries) {
        expect(entry.className, `"${entry.textContent}"`).toContain("min-h-11");
      }
      // One rule, before the destructive entry — decoration, so it has no role and
      // cannot be announced or counted as an entry.
      expect(
        popup.querySelectorAll(":scope > [aria-hidden='true']"),
      ).toHaveLength(1);
      for (const absent of [
        "Move to…",
        "Add as multi-step to-do",
        "Add as single-task to-do",
        "Edit time estimate",
      ]) {
        expect(
          within(popup).queryByText(absent),
          `"${absent}" arrived on a library row without the plumbing for it`,
        ).toBeNull();
      }
    },
  );

  // Both restored twins dispatch, asserted independently of their inline siblings:
  // "the inline button works" is not evidence that the entry does, and a duplicate
  // wired to nothing is exactly what a restore can get wrong.
  it("the ▾ 'Start visual focus timer' entry ensures a focus step", async () => {
    const user = userEvent.setup();
    (ensureFocusStep as ReturnType<typeof vi.fn>).mockResolvedValueOnce("st-9");
    render(
      <LibraryRows
        items={[makeItem({ id: "row-1" })]}
        tab="plated"
        voice="plain"
        now={NOW}
        settings={settings}
      />,
    );
    await user.click(screen.getByRole("button", { name: "All options" }));
    await user.click(
      screen.getByRole("button", { name: "Start visual focus timer" }),
    );
    await waitFor(() => expect(ensureFocusStep).toHaveBeenCalledWith("row-1"));
    await waitFor(() => expect(push).toHaveBeenCalledWith("/focus/st-9"));
  });

  it("the ▾ 'Mark as completed' entry completes the item and refreshes", async () => {
    const user = userEvent.setup();
    render(
      <LibraryRows
        items={[makeItem({ id: "row-1" })]}
        tab="plated"
        voice="plain"
        now={NOW}
        settings={settings}
      />,
    );
    await user.click(screen.getByRole("button", { name: "All options" }));
    await user.click(screen.getByRole("button", { name: "Mark as completed" }));
    await waitFor(() => expect(completeItem).toHaveBeenCalledWith("row-1"));
    expect(refresh).toHaveBeenCalled();
  });

  // #253 — Delete is reached from the ▾ list. The inline 🗑 went with the trailing
  // icon cluster, and the list entry (which was already there as a mirror) is now
  // the route. The two-step confirm itself is unchanged, and the ARMED pair still
  // renders in the ▾ popup where the entry was.
  const armDelete = async (user: ReturnType<typeof userEvent.setup>) => {
    await user.click(screen.getByRole("button", { name: "All options" }));
    await user.click(screen.getByRole("button", { name: "Delete" }));
  };

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
    await armDelete(user);
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

    await armDelete(user);
    await user.click(screen.getByRole("button", { name: "Cancel" }));

    expect(deleteBrainDumpItem).not.toHaveBeenCalled();
    // Back to the resting state: the ▾ list offers Delete once more.
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

  /**
   * The same check with the ▾ list OPEN, which is where most of this row's controls
   * now live.
   *
   * `anchored-popup.ts` justifies `rowMenuEntry` keeping a redundant `min-w-11` on
   * the grounds that "the target-size guards in `inbox-view.test.tsx` and
   * `library-rows.test.tsx` measure BOTH dimensions of every control inside
   * `[data-row-actions]` — and the popup is portaled in there, so an open list is in
   * scope". That was true of `inbox-view.test.tsx` and FALSE of this file: every
   * call of `expectFullTargets` above renders the list closed, so the only thing
   * ever checked here was the resting line, and this file's other ▾ assertions look
   * at `min-h-11` alone. The comment was describing a control that did not exist.
   *
   * Added rather than the comment being narrowed, because the width floor is worth
   * having asserted somewhere on this surface: it is the dimension an emoji-only or
   * short-label entry loses first.
   */
  it.each(["plated", "pantry"] as const)(
    "%s rows, with the ▾ list open",
    async (tab) => {
      const user = userEvent.setup();
      const { container } = renderTab(tab);
      await user.click(screen.getByRole("button", { name: "All options" }));
      // Guard the guard: the popup is portaled into the row's `[data-row-actions]`
      // host, so if it ever stops being, `expectFullTargets` would silently go back
      // to measuring only the resting line and passing.
      const popup = screen.getByRole("dialog", { name: "All options" });
      expect(popup.closest("[data-row-actions]")).not.toBeNull();
      expect(
        popup.querySelectorAll("button, a").length,
        "the open ▾ contributed no controls to measure",
      ).toBeGreaterThan(0);
      expectFullTargets(container);
    },
  );

  it("and the armed delete confirm, which replaces a 44px control", async () => {
    // The pair takes the place of the ▾ entry that opened it — itself 44px via
    // `rowMenuEntry` since #253 made it the only route to delete — so a smaller
    // pair shrinks the line under the pointer at exactly the moment a mis-tap
    // deletes something.
    const user = userEvent.setup();
    renderTab("plated");
    await user.click(screen.getByRole("button", { name: "All options" }));
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
