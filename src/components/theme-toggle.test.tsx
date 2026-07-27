// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ThemeToggle } from "./theme-toggle";

/** Let a queued MutationObserver callback (a microtask) flush into React. */
const flush = () => act(async () => {});

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

  // #23 safety net: the control reports the theme that is actually applied to
  // <html>, including a dark theme already set before it mounts (the
  // pre-hydration inline script does exactly that for a returning user).
  it("reflects a dark theme that was already applied before mount", async () => {
    document.documentElement.classList.add("dark");
    render(<ThemeToggle />);
    await flush();
    expect(screen.getByRole("button")).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button")).toHaveTextContent("Light mode");
  });

  // #23 — the html class is the single source of truth, so two mounted
  // toggles (the header one and the Settings > Appearance one) can't disagree:
  // flipping the theme anywhere updates every control. Previously each copy
  // read the class once into its own state and then drifted.
  it("stays in sync when the theme changes elsewhere", async () => {
    render(<ThemeToggle />);
    const btn = screen.getByRole("button");
    expect(btn).toHaveAttribute("aria-pressed", "false");

    // Someone else (another toggle instance) flips the theme.
    await act(async () => {
      document.documentElement.classList.add("dark");
    });
    expect(btn).toHaveAttribute("aria-pressed", "true");

    await act(async () => {
      document.documentElement.classList.remove("dark");
    });
    expect(btn).toHaveAttribute("aria-pressed", "false");
  });

  // #40 Phase 3.6 — focus states must be visible.
  it("exposes a visible keyboard focus ring (a11y)", () => {
    render(<ThemeToggle />);
    expect(screen.getByRole("button").className).toContain(
      "focus-visible:ring-2",
    );
  });
});
