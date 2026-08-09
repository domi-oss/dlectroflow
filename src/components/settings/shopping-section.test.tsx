// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
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

/**
 * Duo review round 5, !294 — **a switch that lies about where it is.**
 *
 * `toggle()` set `enabled` optimistically and awaited the write with no `catch`.
 * A rejected `updateShoppingList` therefore left the checkbox showing the value
 * the user chose while `Settings.shoppingList` still held the old one — and this
 * is not a taste setting: it gates the `/shopping` route and the menu entry, both
 * server-rendered. The page went on contradicting itself until a full reload.
 *
 * Two halves, and the second is the one that is easy to skip: **say so, and put
 * the control back.** Surfacing alone would leave an error message beside a
 * checkbox that still reads "on", which is a worse lie than the silent one
 * because it invites the user to trust the checkbox over the message.
 *
 * The feedback is `useSaveStatus` / `SaveIndicator`, the auto-save vocabulary
 * `AppearanceSection`, `NotificationsSection`, `FocusTimerSection` and
 * `AgingSection` already share — deliberately NOT the shopping list page's own
 * failure notice, which quotes "the words at stake" and offers a Retry. A
 * settings section that reported a failed auto-save in a second shape would be
 * exactly the divergence the round-4 fix avoided on the other page.
 */
describe("when the toggle's write fails", () => {
  const failing = () =>
    vi.mocked(updateShoppingList).mockRejectedValueOnce(new Error("offline"));

  it("says the save failed rather than looking like it worked", async () => {
    failing();
    const user = userEvent.setup();
    render(
      <ShoppingSection shoppingList={false} voice="plain" defaultExpanded />,
    );
    await user.click(
      screen.getByRole("checkbox", { name: /show the shopping list/i }),
    );

    expect(await screen.findByRole("alert")).toHaveTextContent(
      /couldn't save/i,
    );
  });

  // The half that matters most: this switch decides whether a whole route and a
  // menu entry exist, so a checkbox left on the value the server rejected is the
  // UI disagreeing with the feature gate.
  it("puts the checkbox back where the server still has it", async () => {
    failing();
    const user = userEvent.setup();
    render(
      <ShoppingSection shoppingList={false} voice="plain" defaultExpanded />,
    );
    const toggle = screen.getByRole("checkbox", {
      name: /show the shopping list/i,
    });
    await user.click(toggle);

    await waitFor(() => expect(toggle).not.toBeChecked());
  });

  it("rolls back the other direction too", async () => {
    failing();
    const user = userEvent.setup();
    render(<ShoppingSection shoppingList voice="plain" defaultExpanded />);
    const toggle = screen.getByRole("checkbox", {
      name: /show the shopping list/i,
    });
    await user.click(toggle);

    await waitFor(() => expect(toggle).toBeChecked());
    expect(await screen.findByRole("alert")).toBeInTheDocument();
  });

  // The control has to stay usable: a failed auto-save the user cannot retry by
  // simply pressing again would be a dead switch with an explanation next to it.
  it("clears the message and keeps the new value once a later save lands", async () => {
    failing();
    const user = userEvent.setup();
    render(
      <ShoppingSection shoppingList={false} voice="plain" defaultExpanded />,
    );
    const toggle = screen.getByRole("checkbox", {
      name: /show the shopping list/i,
    });
    await user.click(toggle);
    await screen.findByRole("alert");

    await user.click(toggle);

    await waitFor(() => expect(toggle).toBeChecked());
    expect(screen.queryByRole("alert")).toBeNull();
    expect(updateShoppingList).toHaveBeenLastCalledWith(true);
  });

  it("says nothing at all when the save works", async () => {
    const user = userEvent.setup();
    render(
      <ShoppingSection shoppingList={false} voice="plain" defaultExpanded />,
    );
    await user.click(
      screen.getByRole("checkbox", { name: /show the shopping list/i }),
    );
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
