// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MultiStepDropPrompt } from "./multi-step-drop-prompt";

afterEach(cleanup);

function setup() {
  const onBreakNow = vi.fn();
  const onSaveLater = vi.fn();
  const onCancel = vi.fn();
  render(
    <MultiStepDropPrompt
      itemText="plan the trip"
      voice="plain"
      onBreakNow={onBreakNow}
      onSaveLater={onSaveLater}
      onCancel={onCancel}
    />,
  );
  return { onBreakNow, onSaveLater, onCancel };
}

describe("MultiStepDropPrompt", () => {
  it("calls onBreakNow when 'Break into steps now' is chosen", async () => {
    const { onBreakNow } = setup();
    await userEvent.click(screen.getByRole("button", { name: "Break into steps now" }));
    expect(onBreakNow).toHaveBeenCalledTimes(1);
  });

  it("calls onSaveLater when 'Save for later' is chosen", async () => {
    const { onSaveLater } = setup();
    await userEvent.click(screen.getByRole("button", { name: "Save for later" }));
    expect(onSaveLater).toHaveBeenCalledTimes(1);
  });

  it("calls onCancel on Escape", async () => {
    const { onCancel } = setup();
    await userEvent.keyboard("{Escape}");
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("is an aria-modal dialog that focuses the primary action on mount", () => {
    setup();
    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(screen.getByRole("button", { name: "Break into steps now" })).toHaveFocus();
  });

  it("renders all actions as type=button so it can't submit an enclosing form", () => {
    setup();
    for (const button of screen.getAllByRole("button")) {
      expect(button).toHaveAttribute("type", "button");
    }
  });
});
