// @vitest-environment jsdom
/**
 * #251 — the Library's Done tab had no controls at all.
 *
 * `LibraryRow` in library/page.tsx is a read-only server component: the
 * `plated`/`pantry` tabs render the interactive `<LibraryRows>` (delete
 * included) while Done rendered a static row, so a completed to-do could not be
 * removed from the hub either. This is the narrow client island that fixes it —
 * see the component's own doc comment for why it is not `<LibraryRows>`.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { LibraryDoneDelete, LIB_PANEL_HEADING_ID } from "./library-done-delete";

const refresh = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh }),
}));
vi.mock("@/app/actions/braindump", () => ({
  deleteBrainDumpItem: vi.fn().mockResolvedValue(undefined),
}));

import { deleteBrainDumpItem } from "@/app/actions/braindump";

/**
 * The row in its panel. The heading is what `library/page.tsx` renders as the
 * panel's `aria-labelledby` target, and it is the element focus is handed to
 * once the row is gone — so a fixture without it would prove nothing about the
 * hand-off.
 */
function renderRow(id = "done-1") {
  return render(
    <section aria-labelledby={LIB_PANEL_HEADING_ID}>
      <p id={LIB_PANEL_HEADING_ID} tabIndex={-1}>
        Finished, for the record.
      </p>
      <ul>
        <li>
          <span>Reply to recruiter</span>
          <LibraryDoneDelete id={id} voice="plain" />
        </li>
      </ul>
    </section>,
  );
}

beforeEach(() => vi.clearAllMocks());
afterEach(() => cleanup());

describe("LibraryDoneDelete (#251)", () => {
  it("is a two-step confirm — the first press arms, the second deletes", async () => {
    const user = userEvent.setup();
    renderRow();

    await user.click(screen.getByRole("button", { name: "Delete" }));
    expect(deleteBrainDumpItem).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Delete" }));
    await waitFor(() =>
      expect(deleteBrainDumpItem).toHaveBeenCalledWith("done-1"),
    );
    // The hub's own read is what has to be refreshed: the action revalidates
    // the routes it knows about, not whichever one the press came from.
    await waitFor(() => expect(refresh).toHaveBeenCalled());
  });

  it("Cancel disarms without deleting, and the control comes back", async () => {
    const user = userEvent.setup();
    renderRow();

    await user.click(screen.getByRole("button", { name: "Delete" }));
    await user.click(screen.getByRole("button", { name: "Cancel" }));

    expect(deleteBrainDumpItem).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Delete" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Cancel" })).toBeNull();
  });

  it("names the resting icon control, which is otherwise a bare glyph", () => {
    renderRow();
    const control = screen.getByRole("button", { name: "Delete" });
    // The visible label is 🗑, so `aria-label` is the whole accessible name
    // (WCAG 4.1.2) and `title` is the pointer user's half of the same fact.
    expect(control).toHaveAttribute("aria-label", "Delete");
    expect(control).toHaveAttribute("title", "Delete");
  });

  it("clears the house 44px minimum, resting and armed", async () => {
    const user = userEvent.setup();
    renderRow();

    const resting = screen.getByRole("button", { name: "Delete" });
    expect(resting.className).toContain("min-h-11");
    expect(resting.className).toContain("min-w-11");

    await user.click(resting);
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

  it("hands focus to the panel heading rather than leaving it on <body>", async () => {
    const user = userEvent.setup();
    renderRow();

    await user.click(screen.getByRole("button", { name: "Delete" }));
    await user.click(screen.getByRole("button", { name: "Delete" }));

    // The confirming button unmounts with the press and the row goes with the
    // refresh, so the browser has already dropped focus on <body> (WCAG 2.4.3).
    await waitFor(() =>
      expect(document.activeElement).toBe(
        document.getElementById(LIB_PANEL_HEADING_ID),
      ),
    );
  });

  it("does not take focus back from somewhere the user moved it", async () => {
    // Repair, not steal: a press that lands while the user has gone elsewhere
    // must leave them there. `document.activeElement` being anything but
    // <body> is the whole test — the hand-off is for focus that was lost.
    const user = userEvent.setup();
    renderRow();
    const elsewhere = document.createElement("button");
    elsewhere.textContent = "somewhere else";
    document.body.appendChild(elsewhere);

    await user.click(screen.getByRole("button", { name: "Delete" }));
    await user.click(screen.getByRole("button", { name: "Delete" }));
    elsewhere.focus();

    await waitFor(() => expect(deleteBrainDumpItem).toHaveBeenCalled());
    expect(document.activeElement).toBe(elsewhere);
    elsewhere.remove();
  });
});
