// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ThemeToggle } from "./theme-toggle";

afterEach(() => {
  cleanup();
  document.documentElement.classList.remove("dark");
  try {
    localStorage.clear();
  } catch {
    /* jsdom */
  }
});

describe("ThemeToggle", () => {
  it("toggles the dark class + aria-pressed on click", async () => {
    render(<ThemeToggle />);
    const btn = screen.getByRole("button");
    expect(btn).toHaveAttribute("aria-pressed", "false");

    await userEvent.click(btn);
    expect(document.documentElement.classList.contains("dark")).toBe(true);
    expect(btn).toHaveAttribute("aria-pressed", "true");
  });

  // #40 Phase 3.6 — focus states must be visible.
  it("exposes a visible keyboard focus ring (a11y)", () => {
    render(<ThemeToggle />);
    expect(screen.getByRole("button").className).toContain(
      "focus-visible:ring-2",
    );
  });
});
