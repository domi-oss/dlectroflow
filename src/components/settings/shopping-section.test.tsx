// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ShoppingSection } from "@/components/settings/shopping-section";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));
vi.mock("@/app/actions/settings", () => ({
  updateShoppingList: vi.fn().mockResolvedValue(undefined),
}));

import { updateShoppingList } from "@/app/actions/settings";

afterEach(cleanup);
beforeEach(() => vi.clearAllMocks());

describe("ShoppingSection", () => {
  it("auto-saves both directions", async () => {
    const user = userEvent.setup();
    render(
      <ShoppingSection shoppingList={false} voice="plain" defaultExpanded />,
    );
    const toggle = screen.getByRole("checkbox", {
      name: /show the shopping list/i,
    });
    expect(toggle).not.toBeChecked();
    await user.click(toggle);
    expect(updateShoppingList).toHaveBeenCalledWith(true);
    await user.click(toggle);
    expect(updateShoppingList).toHaveBeenCalledWith(false);
  });

  it("seeds from the stored preference", () => {
    render(<ShoppingSection shoppingList voice="plain" defaultExpanded />);
    expect(
      screen.getByRole("checkbox", { name: /show the shopping list/i }),
    ).toBeChecked();
  });

  // The switch is the only place a reader learns that turning it off is not
  // destructive. Without it, "hide the list" and "delete the list" look the same
  // from the checkbox, and one of them is unrecoverable.
  it("says turning it off does not delete the list", () => {
    render(<ShoppingSection shoppingList voice="plain" defaultExpanded />);
    expect(
      screen.getByText(/hides the list without deleting it/i),
    ).toBeInTheDocument();
  });

  // Queried as the heading, not as text: the playful hint copy also names the
  // menu entry ("Adds a 🛒 Shopping list to the menu"), so a text query matches
  // twice and would fail for a reason that has nothing to do with the voice.
  it("speaks the app voice in its heading, from the section registry", () => {
    render(<ShoppingSection shoppingList voice="playful" defaultExpanded />);
    expect(
      screen.getByRole("heading", { name: /🛒 Shopping list/ }),
    ).toBeInTheDocument();
    cleanup();
    render(<ShoppingSection shoppingList voice="plain" defaultExpanded />);
    expect(
      screen.getByRole("heading", { name: "Shopping list" }),
    ).toBeInTheDocument();
  });
});
