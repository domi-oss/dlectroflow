// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  MAX_SHOPPING_ITEMS,
  SHOPPING_ITEM_TEXT_MAX_LENGTH,
} from "@/lib/shopping";
import { ShoppingList } from "@/components/shopping/shopping-list";

/**
 * #199 — the shopping list surface.
 *
 * The assertions worth having here are the ones about what this page is NOT: no
 * estimate, no "break into steps", no schedule, no focus affordance. Those are
 * the four things every other list in this app offers, and a row that grew one
 * would put a shopping item into machinery the model deliberately keeps it out of.
 */

const { addMock, renameMock, doneMock, savedMock, deleteMock, refreshMock } =
  vi.hoisted(() => ({
    addMock: vi.fn().mockResolvedValue(undefined),
    renameMock: vi.fn().mockResolvedValue(undefined),
    doneMock: vi.fn().mockResolvedValue(undefined),
    savedMock: vi.fn().mockResolvedValue(undefined),
    deleteMock: vi.fn().mockResolvedValue(undefined),
    refreshMock: vi.fn(),
  }));

vi.mock("@/app/actions/shopping", () => ({
  addShoppingItem: addMock,
  renameShoppingItem: renameMock,
  setShoppingItemDone: doneMock,
  setShoppingItemSavedForLater: savedMock,
  deleteShoppingItem: deleteMock,
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: refreshMock }),
}));

const item = (
  over: Partial<Parameters<typeof ShoppingList>[0]["items"][number]>,
) => ({
  id: "s1",
  text: "Milk",
  done: false,
  savedForLater: false,
  order: 1,
  ...over,
});

beforeEach(() => vi.clearAllMocks());
afterEach(cleanup);

const renderList = (items: Parameters<typeof ShoppingList>[0]["items"] = []) =>
  render(<ShoppingList items={items} voice="plain" />);

describe("capturing", () => {
  it("adds the typed text and clears the field", async () => {
    renderList();
    const field = screen.getByLabelText(/add to the list/i);
    await userEvent.type(field, "oat milk");
    await userEvent.click(screen.getByRole("button", { name: /^add$/i }));
    expect(addMock).toHaveBeenCalledWith("oat milk");
    expect(field).toHaveValue("");
  });

  it("refuses a blank submit visibly, and does not call the action", async () => {
    renderList();
    await userEvent.click(screen.getByRole("button", { name: /^add$/i }));
    expect(addMock).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toHaveTextContent(
      /type something first/i,
    );
  });

  it("says the entry is too long rather than truncating it", async () => {
    renderList();
    const field = screen.getByLabelText(/add to the list/i);
    // `paste` rather than `type`: 201 keystrokes is a slow test for no extra
    // coverage, and paste is how an over-long entry actually arrives.
    await userEvent.click(field);
    await userEvent.paste("x".repeat(SHOPPING_ITEM_TEXT_MAX_LENGTH + 1));
    await userEvent.click(screen.getByRole("button", { name: /^add$/i }));
    expect(addMock).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toHaveTextContent(/200 characters/i);
  });

  it("marks the field invalid and points at the message (WCAG 3.3.1)", async () => {
    renderList();
    const field = screen.getByLabelText(/add to the list/i);
    expect(field).not.toHaveAttribute("aria-invalid", "true");
    await userEvent.click(screen.getByRole("button", { name: /^add$/i }));
    expect(field).toHaveAttribute("aria-invalid", "true");
    const describedBy = field.getAttribute("aria-describedby");
    expect(describedBy).toBeTruthy();
    expect(document.getElementById(describedBy!)).toHaveTextContent(
      /type something first/i,
    );
  });

  it("clears the error once the field is being used again", async () => {
    renderList();
    await userEvent.click(screen.getByRole("button", { name: /^add$/i }));
    expect(screen.getByRole("alert")).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText(/add to the list/i), "M");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("refuses to add past the cap, and says why", async () => {
    const full = Array.from({ length: MAX_SHOPPING_ITEMS }, (_, i) =>
      item({ id: `s${i}`, text: `thing ${i}`, order: i + 1 }),
    );
    renderList(full);
    await userEvent.type(screen.getByLabelText(/add to the list/i), "one more");
    await userEvent.click(screen.getByRole("button", { name: /^add$/i }));
    expect(addMock).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toHaveTextContent(/full at 500 items/i);
  });
});

describe("the two sections", () => {
  it("puts un-saved items under To buy, in capture order", () => {
    renderList([
      item({ id: "b", text: "Bread", order: 2 }),
      item({ id: "a", text: "Apples", order: 1 }),
    ]);
    const active = screen.getByRole("region", { name: /to buy/i });
    const texts = within(active)
      .getAllByRole("listitem")
      .map((li) => li.textContent);
    expect(texts[0]).toContain("Apples");
    expect(texts[1]).toContain("Bread");
  });

  it("shows a count of what is still to buy, excluding ticked and saved rows", () => {
    renderList([
      item({ id: "a", text: "Apples" }),
      item({ id: "b", text: "Bread", done: true }),
      item({ id: "c", text: "Cheese", savedForLater: true }),
    ]);
    expect(
      screen.getByRole("region", { name: /to buy/i }),
    ).toHaveAccessibleName(/1 item still to buy/i);
  });

  it("keeps a ticked item where it is rather than moving it", () => {
    renderList([item({ id: "a", text: "Apples", done: true })]);
    const active = screen.getByRole("region", { name: /to buy/i });
    expect(within(active).getByText("Apples")).toBeInTheDocument();
  });

  it("renders the saved-for-later section only when something is in it", () => {
    const { unmount } = renderList([item({ id: "a" })]);
    expect(
      screen.queryByRole("region", { name: /saved for later/i }),
    ).not.toBeInTheDocument();
    unmount();
    renderList([item({ id: "a", savedForLater: true })]);
    expect(
      screen.getByRole("region", { name: /saved for later/i }),
    ).toBeInTheDocument();
  });

  it("says nothing here comes back on its own", () => {
    renderList([item({ id: "a", savedForLater: true })]);
    expect(
      within(
        screen.getByRole("region", { name: /saved for later/i }),
      ).getByText(/comes back on its own/i),
    ).toBeInTheDocument();
  });

  it("shows an empty state instead of a bare heading", () => {
    renderList();
    expect(screen.getByText(/nothing on the list yet/i)).toBeInTheDocument();
  });
});

describe("row controls", () => {
  it("ticks and un-ticks", async () => {
    renderList([item({ id: "a", text: "Apples" })]);
    await userEvent.click(screen.getByRole("checkbox", { name: /apples/i }));
    expect(doneMock).toHaveBeenCalledWith("a", true);
    cleanup();
    renderList([item({ id: "a", text: "Apples", done: true })]);
    await userEvent.click(screen.getByRole("checkbox", { name: /apples/i }));
    expect(doneMock).toHaveBeenCalledWith("a", false);
  });

  it("moves an item down to saved for later, and back up again", async () => {
    renderList([item({ id: "a", text: "Apples" })]);
    await userEvent.click(
      screen.getByRole("button", { name: /save for later: apples/i }),
    );
    expect(savedMock).toHaveBeenCalledWith("a", true);
    cleanup();
    renderList([item({ id: "a", text: "Apples", savedForLater: true })]);
    await userEvent.click(
      screen.getByRole("button", { name: /move back to the list: apples/i }),
    );
    expect(savedMock).toHaveBeenCalledWith("a", false);
  });

  it("deletes", async () => {
    renderList([item({ id: "a", text: "Apples" })]);
    await userEvent.click(
      screen.getByRole("button", { name: /delete apples/i }),
    );
    expect(deleteMock).toHaveBeenCalledWith("a");
  });

  it("renames in place, on Enter", async () => {
    renderList([item({ id: "a", text: "Apples" })]);
    await userEvent.click(
      screen.getByRole("button", { name: /rename apples/i }),
    );
    const field = screen.getByRole("textbox", { name: /rename apples/i });
    await userEvent.clear(field);
    await userEvent.type(field, "Braeburns{Enter}");
    expect(renameMock).toHaveBeenCalledWith("a", "Braeburns");
  });

  it("abandons a rename on Escape without writing", async () => {
    renderList([item({ id: "a", text: "Apples" })]);
    await userEvent.click(
      screen.getByRole("button", { name: /rename apples/i }),
    );
    await userEvent.type(
      screen.getByRole("textbox", { name: /rename apples/i }),
      "Pears{Escape}",
    );
    expect(renameMock).not.toHaveBeenCalled();
    expect(screen.getByText("Apples")).toBeInTheDocument();
  });

  // Duo review, !294 — a rename had no validation and no feedback: an over-long or
  // blanked value called the action, which returned silently, and the row simply
  // reverted with no explanation. That is the exact "a silent no-op looks like a
  // lost item" failure this component's own docblock warns about for the Add flow,
  // so the two flows now share one validator.
  it("refuses an over-long rename visibly, and keeps the editor open", async () => {
    renderList([item({ id: "a", text: "Apples" })]);
    await userEvent.click(
      screen.getByRole("button", { name: /rename apples/i }),
    );
    const field = screen.getByRole("textbox", { name: /rename apples/i });
    await userEvent.clear(field);
    await userEvent.paste("x".repeat(SHOPPING_ITEM_TEXT_MAX_LENGTH + 1));
    await userEvent.keyboard("{Enter}");
    expect(renameMock).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toHaveTextContent(/200 characters/i);
    // Still editing: dropping back to the old text would throw away what they
    // typed as well as failing silently.
    expect(
      screen.getByRole("textbox", { name: /rename apples/i }),
    ).toBeInTheDocument();
  });

  it("refuses a blanked rename visibly rather than reverting", async () => {
    renderList([item({ id: "a", text: "Apples" })]);
    await userEvent.click(
      screen.getByRole("button", { name: /rename apples/i }),
    );
    const field = screen.getByRole("textbox", { name: /rename apples/i });
    await userEvent.clear(field);
    await userEvent.type(field, "   {Enter}");
    expect(renameMock).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toHaveTextContent(
      /type something first/i,
    );
  });

  it("clears a rename refusal once the value changes", async () => {
    renderList([item({ id: "a", text: "Apples" })]);
    await userEvent.click(
      screen.getByRole("button", { name: /rename apples/i }),
    );
    const field = screen.getByRole("textbox", { name: /rename apples/i });
    await userEvent.clear(field);
    await userEvent.type(field, "  {Enter}");
    expect(screen.getByRole("alert")).toBeInTheDocument();
    await userEvent.type(field, "Braeburns");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("abandons a refused rename on Escape, taking the message with it", async () => {
    renderList([item({ id: "a", text: "Apples" })]);
    await userEvent.click(
      screen.getByRole("button", { name: /rename apples/i }),
    );
    const field = screen.getByRole("textbox", { name: /rename apples/i });
    await userEvent.clear(field);
    await userEvent.type(field, "  {Enter}");
    expect(screen.getByRole("alert")).toBeInTheDocument();
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByText("Apples")).toBeInTheDocument();
  });

  it("names the item in every control, so a screen-reader list is usable", () => {
    renderList([item({ id: "a", text: "Apples" })]);
    // "Delete" twelve times over is what this is guarding against.
    for (const name of [
      /delete apples/i,
      /rename apples/i,
      /save for later: apples/i,
    ]) {
      expect(screen.getByRole("button", { name })).toBeInTheDocument();
    }
  });
});

describe("what this page deliberately does not offer", () => {
  it("has no estimate, breakdown, schedule or focus control", () => {
    renderList([item({ id: "a", text: "Apples" })]);
    // Queried as CONTROLS, not as text: the intro copy names all four in order to
    // say the page does not have them, so a text query would find the sentence
    // promising their absence and call it a failure.
    for (const pattern of [
      /break into steps/i,
      /snack-size/i,
      /schedule/i,
      /focus/i,
      /estimate/i,
      /minutes/i,
    ]) {
      expect(screen.queryByRole("button", { name: pattern })).toBeNull();
      expect(screen.queryByRole("link", { name: pattern })).toBeNull();
      expect(screen.queryByRole("spinbutton", { name: pattern })).toBeNull();
    }
    // The row's whole control surface, enumerated: tick, rename, save, delete and
    // the capture field's Add. Anything else on a row is a new affordance that
    // has to be argued for, and this is where it shows up.
    expect(
      screen
        .getAllByRole("button")
        .map((b) => b.getAttribute("aria-label") ?? b.textContent),
    ).toEqual([
      "Add",
      "Rename Apples",
      "Save for later: Apples",
      "Delete Apples",
    ]);
  });

  it("says so on the page, so the absence reads as deliberate", () => {
    renderList();
    expect(screen.getByText(/does not touch your streak/i)).toBeInTheDocument();
  });
});
