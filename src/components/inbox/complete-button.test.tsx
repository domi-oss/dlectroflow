// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { CompleteButton } from "@/components/inbox/complete-button";

afterEach(cleanup);

describe("CompleteButton", () => {
  it("renders the voice-resolved label and fires onClick", () => {
    const onClick = vi.fn();
    render(<CompleteButton voice="plain" onClick={onClick} />);
    const btn = screen.getByRole("button", { name: /complete/i });
    fireEvent.click(btn);
    expect(onClick).toHaveBeenCalledOnce();
  });

  it("a11y: has a ≥44px touch target (min-h-11 / min-w-11)", () => {
    render(<CompleteButton voice="plain" onClick={vi.fn()} />);
    const btn = screen.getByRole("button", { name: /complete/i });
    expect(btn.className).toContain("min-h-11");
    expect(btn.className).toContain("min-w-11");
  });
});
