// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { TaskNoteRow } from "@/components/breakdown/task-note";

/**
 * #186 — `TaskNoteRow` picks the note GRAIN, and that is the whole substance.
 *
 * A row can hold a note in one of two columns and only one of them is live.
 * Before triage it is `BrainDumpItem.notes`; after triage
 * `brainDumpItemToTaskData` has copied it onto the `Task`, and every note surface
 * reads `Task.notes` from then on. Picking wrong is not a rendering bug — it
 * writes a column nothing displays, which to the person is a save that silently
 * did nothing.
 *
 * `#44` shipped this wrapper with only the task branch, and the comment
 * explaining the absence outlived the reason: `BrainDumpItem` had no `notes`
 * column at all, so an affordance on a Needs-review row could only ever fail.
 * #186 added the column, which is why the branch exists now rather than because
 * anyone changed their mind about the UI.
 */

const updateTaskNotes = vi.fn().mockResolvedValue({ ok: true, notes: "x" });
const updateItemNotes = vi.fn().mockResolvedValue({ ok: true, notes: "x" });
vi.mock("@/app/actions/task-notes", () => ({
  updateTaskNotes: (...args: unknown[]) => updateTaskNotes(...args),
}));
vi.mock("@/app/actions/step-notes", () => ({
  updateStepNotes: vi.fn().mockResolvedValue({ ok: true, notes: null }),
}));
vi.mock("@/app/actions/item-notes", () => ({
  updateItemNotes: (...args: unknown[]) => updateItemNotes(...args),
}));

afterEach(cleanup);
beforeEach(() => vi.clearAllMocks());

describe("TaskNoteRow — grain selection (#186)", () => {
  it("writes the TASK column for a task-backed row", async () => {
    const user = userEvent.setup();
    render(
      <TaskNoteRow
        taskId="t1"
        itemId="i1"
        taskTitle="Ship the thing"
        notes="live task note"
        itemNotes="stale item copy"
        voice="plain"
        autoSaveDelayMs={0}
      />,
    );
    // The note it shows is the live one, not the leftover.
    expect(screen.getByTestId("note-text").textContent).toBe("live task note");
    await user.click(screen.getByRole("button", { name: /^Note for/ }));
    await user.type(screen.getByRole("textbox", { name: /^Note for/ }), "!");
    await waitFor(() => expect(updateTaskNotes).toHaveBeenCalled());
    expect(updateTaskNotes.mock.calls[0][0]).toBe("t1");
    expect(updateItemNotes).not.toHaveBeenCalled();
  });

  it("writes the ITEM column for an untriaged row", async () => {
    const user = userEvent.setup();
    render(
      <TaskNoteRow
        taskId={null}
        itemId="i1"
        taskTitle="raw thought"
        itemNotes="can under sink"
        voice="plain"
        autoSaveDelayMs={0}
      />,
    );
    expect(screen.getByTestId("note-text").textContent).toBe("can under sink");
    await user.click(screen.getByRole("button", { name: /^Note for/ }));
    await user.type(screen.getByRole("textbox", { name: /^Note for/ }), "!");
    await waitFor(() => expect(updateItemNotes).toHaveBeenCalled());
    expect(updateItemNotes.mock.calls[0][0]).toBe("i1");
    expect(updateTaskNotes).not.toHaveBeenCalled();
  });

  it("names the control after the row, in either grain (WCAG 2.5.3 + #44)", () => {
    // The failure this prevents is a list of rows all offering a button called
    // "Note". The grain must not change the naming discipline.
    render(
      <TaskNoteRow
        taskId={null}
        itemId="i1"
        taskTitle="water the plants"
        voice="plain"
      />,
    );
    const trigger = screen.getByRole("button", {
      name: "Note for water the plants",
    });
    expect((trigger.textContent ?? "").trim()).toBe("Note");
  });

  it("shows a captured note without anyone expanding anything", () => {
    // #179 splits a note off at capture, so the note exists before anybody has
    // opened a disclosure. If reading it cost a tap, an inline capture would look
    // like text that had gone missing.
    render(
      <TaskNoteRow
        taskId={null}
        itemId="i1"
        taskTitle="water the plants"
        itemNotes="can under sink"
        voice="plain"
      />,
    );
    expect(screen.getByTestId("note-text").textContent).toBe("can under sink");
  });

  it("still renders nothing when there is no row to write to at all", () => {
    // Both ids null — a surface that has not been given the item's id yet. The
    // caller still has to render its action group, so both halves come back null
    // rather than the whole row disappearing.
    const seen: unknown[] = [];
    render(
      <TaskNoteRow taskId={null} itemId={null} taskTitle="x" voice="plain">
        {(parts) => {
          seen.push(parts);
          return <span data-testid="placed" />;
        }}
      </TaskNoteRow>,
    );
    expect(seen).toEqual([{ trigger: null, body: null }]);
    expect(screen.getByTestId("placed")).toBeTruthy();
  });

  it("hands the caller both halves to place, in the item grain too", () => {
    // List rows put the trigger inside their action group and the body below the
    // action line (owner request, settled on !270). The item branch has to offer
    // the same render prop or the Needs-review row could not follow it.
    render(
      <TaskNoteRow
        taskId={null}
        itemId="i1"
        taskTitle="raw thought"
        voice="plain"
      >
        {({ trigger, body }) => (
          <div>
            <div data-testid="actions">{trigger}</div>
            <div data-testid="below">{body}</div>
          </div>
        )}
      </TaskNoteRow>,
    );
    const actions = screen.getByTestId("actions");
    expect(
      actions.querySelector("button[aria-label='Note for raw thought']"),
    ).toBeTruthy();
    expect(screen.getByTestId("below").querySelector("textarea")).toBeTruthy();
  });
});
