// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { EmojiPicker } from "@/components/breakdown/emoji-picker";

afterEach(cleanup);

describe("EmojiPicker", () => {
  it("shows the current emoji and opens a grid on click", async () => {
    const user = userEvent.setup();
    render(<EmojiPicker value="🌱" onSelect={vi.fn()} />);
    const trigger = screen.getByRole("button", { name: /choose emoji/i });
    expect(trigger).toHaveTextContent("🌱");
    expect(screen.queryByRole("listbox")).toBeNull();
    await user.click(trigger);
    expect(screen.getByRole("listbox")).toBeInTheDocument();
  });

  it("selecting an emoji calls onSelect and closes the grid", async () => {
    const onSelect = vi.fn();
    const user = userEvent.setup();
    render(<EmojiPicker value="🌱" onSelect={onSelect} />);
    await user.click(screen.getByRole("button", { name: /choose emoji/i }));
    const options = screen.getAllByRole("option");
    expect(options.length).toBeGreaterThan(10);
    await user.click(options[0]);
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect.mock.calls[0][0]).toBeTruthy();
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  /**
   * #238 (Duo review of `!365`) — becoming disabled must CLOSE the picker, not
   * merely stop drawing it.
   *
   * The first cut withheld the grid with `{open && !disabled && …}`, which is a
   * rendering condition and leaves `open` alone. Two things follow, and the
   * second is worse than the defect #238 exists to fix:
   *
   *   - the grid springs back the instant the hold lifts, with no user action,
   *     exactly as the rest of the row is handed back;
   *   - `aria-expanded` reports `true` the whole time nothing is rendered,
   *     which is a screen reader being told something the DOM contradicts.
   *
   * Asserted DURING the hold, not only after it. A spec that checked the end
   * state alone passes for the entire window in which this is happening.
   */
  it("closes when it becomes disabled, and says so while it is held", async () => {
    const user = userEvent.setup();
    const { rerender } = render(
      <EmojiPicker value="🌱" onSelect={vi.fn()} disabled={false} />,
    );
    const trigger = () => screen.getByRole("button", { name: /choose emoji/i });
    await user.click(trigger());
    expect(screen.getByRole("listbox")).toBeInTheDocument();
    expect(trigger()).toHaveAttribute("aria-expanded", "true");

    rerender(<EmojiPicker value="🌱" onSelect={vi.fn()} disabled />);

    expect(screen.queryByRole("listbox")).toBeNull();
    expect(trigger()).toHaveAttribute("aria-expanded", "false");
    expect(trigger()).toBeDisabled();
  });

  it("stays closed when the hold lifts, rather than springing back open", async () => {
    const user = userEvent.setup();
    const { rerender } = render(
      <EmojiPicker value="🌱" onSelect={vi.fn()} disabled={false} />,
    );
    await user.click(screen.getByRole("button", { name: /choose emoji/i }));
    expect(screen.getByRole("listbox")).toBeInTheDocument();

    rerender(<EmojiPicker value="🌱" onSelect={vi.fn()} disabled />);
    rerender(<EmojiPicker value="🌱" onSelect={vi.fn()} disabled={false} />);

    // The user pressed nothing. A popover appearing on its own is a change of
    // context they did not ask for (WCAG 3.2.2), and it lands at the exact
    // moment they are getting the row back.
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(
      screen.getByRole("button", { name: /choose emoji/i }),
    ).toHaveAttribute("aria-expanded", "false");
  });

  it("still opens normally once the hold has lifted", async () => {
    const user = userEvent.setup();
    const { rerender } = render(
      <EmojiPicker value="🌱" onSelect={vi.fn()} disabled />,
    );
    rerender(<EmojiPicker value="🌱" onSelect={vi.fn()} disabled={false} />);

    // The control on the two specs above: they would both pass against a picker
    // that could never open again.
    await user.click(screen.getByRole("button", { name: /choose emoji/i }));
    expect(screen.getByRole("listbox")).toBeInTheDocument();
  });
});
