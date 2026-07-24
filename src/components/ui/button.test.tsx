// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { Button } from "@/components/ui/button";

afterEach(cleanup);

describe("Button", () => {
  it("brand variant: carries the gradient background-image + a bold, large label (AA contrast rationale)", () => {
    render(<Button variant="brand">Go</Button>);
    const btn = screen.getByRole("button", { name: /go/i });
    // gradient fill from Task 0.2's --gradient-brand custom property
    expect(btn.className).toContain("[background-image:var(--gradient-brand)]");
    // label must be bold + ≥18.6px so the gradient's lighter end still clears
    // WCAG AA (large-text 3:1 threshold, not the 4.5:1 normal-text one)
    expect(btn.className).toContain("font-bold");
    expect(btn.className).toContain("text-xl");
  });
});
