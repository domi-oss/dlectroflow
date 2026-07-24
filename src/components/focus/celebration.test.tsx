// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, cleanup } from "@testing-library/react";
import { Celebration } from "@/components/focus/celebration";

/** Minimal matchMedia stub keyed on whether reduce-motion should match. */
function mockReduceMotion(matches: boolean) {
  window.matchMedia = vi.fn().mockReturnValue({
    matches,
    media: "(prefers-reduced-motion: reduce)",
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: () => true,
    onchange: null,
  }) as unknown as typeof window.matchMedia;
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  // @ts-expect-error – clean the stub between tests
  delete window.matchMedia;
});

describe("Celebration — respects prefers-reduced-motion", () => {
  it("renders the particle burst when motion is allowed", () => {
    mockReduceMotion(false);
    const { container } = render(<Celebration />);
    // 16 animated particle spans inside the aria-hidden burst wrapper.
    const wrapper = container.querySelector("[aria-hidden]");
    expect(wrapper).not.toBeNull();
    expect(wrapper!.querySelectorAll("span").length).toBe(16);
  });

  it("renders NO particle burst under reduce-motion (returns null)", () => {
    mockReduceMotion(true);
    const { container } = render(<Celebration />);
    expect(container).toBeEmptyDOMElement();
    expect(container.querySelectorAll("span").length).toBe(0);
  });

  // #40 Phase 3.2 — the brand gradient dopamine flash.
  it("shows the neon gradient flash when motion is allowed", () => {
    mockReduceMotion(false);
    const { container } = render(<Celebration />);
    const flash = container.querySelector('[data-testid="celebration-flash"]');
    expect(flash).not.toBeNull();
    expect(flash!.className).toContain("var(--color-brand-magenta)");
    // The flash is a <div>, so it does not inflate the 16 emoji particle count.
    const wrapper = container.querySelector("[aria-hidden]");
    expect(wrapper!.querySelectorAll("span").length).toBe(16);
  });

  it("shows NO gradient flash under reduce-motion", () => {
    mockReduceMotion(true);
    const { container } = render(<Celebration />);
    expect(
      container.querySelector('[data-testid="celebration-flash"]'),
    ).toBeNull();
  });
});
