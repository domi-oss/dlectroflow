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
});
