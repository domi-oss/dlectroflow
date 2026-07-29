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

// #103 — the emoji went out with !141's move to lucide: 🌙/☀️ render
// differently on every platform and the VS16 variation selector makes their
// advance width unpredictable, which is what made the header button so wide.
describe("ThemeToggle — lucide glyphs, both variants (#103)", () => {
  for (const variant of ["text", "icon"] as const) {
    it(`${variant} variant draws an svg icon, not emoji`, () => {
      const { container } = render(<ThemeToggle variant={variant} />);
      const svg = container.querySelector("button > svg");
      expect(svg).not.toBeNull();
      // Decorative: the accessible name must come from the label/aria-label,
      // never from the glyph.
      expect(svg).toHaveAttribute("aria-hidden", "true");
      expect(container.textContent ?? "").not.toMatch(/🌙|☀/);
    });
  }
});

// #103 — the header's icon-only variant. Dropping the visible words drops the
// button's accessible name with them, so the name has to be supplied
// explicitly, and the hit target has to be squared up: a bare icon is nowhere
// near the 44px the text button got from its padding.
describe("ThemeToggle — icon variant (header) (#103)", () => {
  it("renders no visible words", () => {
    render(<ThemeToggle variant="icon" />);
    expect(screen.getByRole("button").textContent).toBe("");
  });

  it("is named for the ACTION it performs, in light mode", () => {
    render(<ThemeToggle variant="icon" />);
    const btn = screen.getByRole("button", { name: "Switch to dark mode" });
    // Pointer users get the same string on hover as AT users hear.
    expect(btn).toHaveAttribute("title", "Switch to dark mode");
    expect(btn).toHaveAttribute("aria-pressed", "false");
  });

  it("is named for the ACTION it performs, in dark mode", async () => {
    document.documentElement.classList.add("dark");
    render(<ThemeToggle variant="icon" />);
    await flush();
    const btn = screen.getByRole("button", { name: "Switch to light mode" });
    expect(btn).toHaveAttribute("title", "Switch to light mode");
    expect(btn).toHaveAttribute("aria-pressed", "true");
  });

  // The accessible name still matches the /(dark|light) mode/i queries the
  // header + Appearance specs are written against, so going icon-only doesn't
  // cost us the existing coverage.
  it("keeps matching an accessible-name query for the theme it offers", () => {
    render(<ThemeToggle variant="icon" />);
    expect(
      screen.getByRole("button", { name: /dark mode/i }),
    ).toBeInTheDocument();
  });

  it("carries a ≥44px square hit target (WCAG 2.5.5)", () => {
    render(<ThemeToggle variant="icon" />);
    const className = screen.getByRole("button").className;
    // The shared `touchTarget` from @/lib/utils — min-h-11/min-w-11 = 2.75rem =
    // 44px, the same helper the inbox icon buttons use. Both axes, because a
    // 20px icon with no padding is neither tall nor wide enough on its own.
    expect(className).toContain("min-h-11");
    expect(className).toContain("min-w-11");
  });

  it("keeps the visible keyboard focus ring (a11y)", () => {
    render(<ThemeToggle variant="icon" />);
    expect(screen.getByRole("button").className).toContain(
      "focus-visible:ring-2",
    );
  });

  // Same single source of truth as the text variant: behaviour is untouched,
  // only the presentation changed.
  it("still writes the theme to <html> and re-labels itself", async () => {
    render(<ThemeToggle variant="icon" />);
    const btn = screen.getByRole("button");
    await userEvent.click(btn);
    expect(document.documentElement.classList.contains("dark")).toBe(true);
    expect(btn).toHaveAttribute("aria-pressed", "true");
    expect(btn).toHaveAttribute("aria-label", "Switch to light mode");
    expect(btn).toHaveAttribute("title", "Switch to light mode");
  });

  it("stays in sync with a text variant mounted alongside it", async () => {
    render(
      <>
        <ThemeToggle variant="icon" />
        <ThemeToggle variant="text" />
      </>,
    );
    const [icon, text] = screen.getAllByRole("button");
    await userEvent.click(icon);
    expect(text).toHaveAttribute("aria-pressed", "true");
    expect(text).toHaveTextContent("Light mode");
    expect(icon).toHaveAttribute("aria-label", "Switch to light mode");
  });
});

// #103 — Settings > Appearance keeps its words: a bare icon in a settings row
// would be worse than the label it replaced. That is also the DEFAULT, so no
// call site silently loses its label.
describe("ThemeToggle — text variant (Settings > Appearance) (#103)", () => {
  it("keeps the visible label, and needs no aria-label to override it", () => {
    render(<ThemeToggle variant="text" />);
    const btn = screen.getByRole("button", { name: /dark mode/i });
    expect(btn).toHaveTextContent("Dark mode");
    // A redundant aria-label here would break WCAG 2.5.3 (Label in Name) for
    // voice-control users, who say what they see.
    expect(btn).not.toHaveAttribute("aria-label");
  });

  it("is what you get when no variant is passed", () => {
    render(<ThemeToggle />);
    expect(screen.getByRole("button")).toHaveTextContent("Dark mode");
  });
});
