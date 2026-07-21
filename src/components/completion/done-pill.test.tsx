// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { DonePill } from "@/components/completion/done-pill";

afterEach(cleanup);

describe("DonePill", () => {
  it("renders a plain '✓ done' when no count is given", () => {
    render(<DonePill voice="plain" />);
    expect(screen.getByText(/✓\s*done/i)).toHaveTextContent("✓ done");
  });

  it("renders a step count when done + total are given", () => {
    render(<DonePill voice="plain" done={3} total={5} />);
    expect(screen.getByText(/✓\s*3\/5\s*done/i)).toBeInTheDocument();
  });

  it("colours the ✓ from --tick-color and keeps a text label (never colour-only)", () => {
    render(<DonePill voice="plain" />);
    const pill = screen.getByText(/✓\s*done/i);
    expect(pill.className).toContain("text-[color:var(--tick-color)]");
    expect(pill.className).toContain("rounded-full");
  });
});
