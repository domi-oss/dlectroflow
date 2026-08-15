// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { render, screen, cleanup, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ThemeToggle, ThemePreferenceChoice } from "./theme-toggle";
import {
  PREFERS_DARK_QUERY,
  THEME_ATTRIBUTE,
  THEME_STORAGE_KEY,
} from "@/lib/theme";

/** Let a queued MutationObserver callback (a microtask) flush into React. */
const flush = () => act(async () => {});

// This jsdom build provides no window.localStorage (same constraint
// appearance-section.test.tsx records), and #85 made the toggle's persistence
// observable — it now writes a three-state value and only calls `onPersist` when
// the write succeeds. So stand up the repo's Map-backed stub and read it.
let store: Map<string, string>;
beforeEach(() => {
  store = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => {
      store.set(k, v);
    },
    removeItem: (k: string) => {
      store.delete(k);
    },
    clear: () => store.clear(),
  });
});

/** Pin the OS setting for one test. */
function stubOsPrefersDark(prefersDark: boolean) {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: query === PREFERS_DARK_QUERY ? prefersDark : false,
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  }));
}

const storedTheme = () => store.get(THEME_STORAGE_KEY) ?? null;
const htmlPref = () => document.documentElement.getAttribute(THEME_ATTRIBUTE);

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  document.documentElement.classList.remove("dark");
  document.documentElement.removeAttribute(THEME_ATTRIBUTE);
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

// ── #85 — the setting became three-state ─────────────────────────────────────

/**
 * The header button stays a two-state control on purpose: in a menu bar, "the
 * obvious thing" is "give me the other one", and a three-way picker there would
 * cost width the bar does not have at 360px (#252). Pressing it is therefore an
 * OVERRIDE — it writes an explicit `light`/`dark`, which is what makes the
 * manual toggle keep working now that `system` is the default.
 */
describe("ThemeToggle — writes an explicit override (#85)", () => {
  it("stores 'dark', not a boolean, when switching to dark", async () => {
    stubOsPrefersDark(false);
    render(<ThemeToggle />);
    await userEvent.click(screen.getByRole("button"));
    expect(storedTheme()).toBe("dark");
    expect(htmlPref()).toBe("dark");
    expect(document.documentElement.classList.contains("dark")).toBe(true);
  });

  it("stores 'light' when switching back", async () => {
    stubOsPrefersDark(false);
    document.documentElement.classList.add("dark");
    document.documentElement.setAttribute(THEME_ATTRIBUTE, "dark");
    render(<ThemeToggle />);
    await flush();
    await userEvent.click(screen.getByRole("button"));
    expect(storedTheme()).toBe("light");
    expect(htmlPref()).toBe("light");
    expect(document.documentElement.classList.contains("dark")).toBe(false);
  });

  // The defect the issue opens with, at the control's level: on a dark OS the
  // app comes up dark, so the button offers LIGHT rather than offering to switch
  // to a theme already on screen.
  it("comes up offering light when the OS is dark and nothing was chosen", async () => {
    stubOsPrefersDark(true);
    // What THEME_BOOTSTRAP_SCRIPT leaves behind for a first visit on a dark OS.
    document.documentElement.setAttribute(THEME_ATTRIBUTE, "system");
    document.documentElement.classList.add("dark");
    render(<ThemeToggle variant="icon" />);
    await flush();
    expect(screen.getByRole("button")).toHaveAccessibleName(
      "Switch to light mode",
    );
  });

  // Overriding a `system` preference must pin the OPPOSITE of what is on
  // screen, not the opposite of the stored preference — otherwise pressing the
  // button on a dark-OS device appears to do nothing.
  it("overriding from system pins the opposite of the RESOLVED theme", async () => {
    stubOsPrefersDark(true);
    document.documentElement.setAttribute(THEME_ATTRIBUTE, "system");
    document.documentElement.classList.add("dark");
    render(<ThemeToggle />);
    await flush();
    await userEvent.click(screen.getByRole("button"));
    expect(storedTheme()).toBe("light");
    expect(document.documentElement.classList.contains("dark")).toBe(false);
  });

  it("only reports a successful persist (private mode says nothing saved)", async () => {
    stubOsPrefersDark(false);
    vi.stubGlobal("localStorage", {
      getItem: () => null,
      setItem: () => {
        throw new Error("SecurityError");
      },
      removeItem: () => {},
      clear: () => {},
    });
    const onPersist = vi.fn();
    render(<ThemeToggle onPersist={onPersist} />);
    await userEvent.click(screen.getByRole("button"));
    // The theme still applies for this session…
    expect(document.documentElement.classList.contains("dark")).toBe(true);
    // …but nothing claims it was remembered.
    expect(onPersist).not.toHaveBeenCalled();
  });

  it("reports a successful persist", async () => {
    stubOsPrefersDark(false);
    const onPersist = vi.fn();
    render(<ThemeToggle onPersist={onPersist} />);
    await userEvent.click(screen.getByRole("button"));
    expect(onPersist).toHaveBeenCalledTimes(1);
  });
});

/**
 * The three-state control, which is where `system` is reachable. A radiogroup
 * rather than a cycling button: three mutually exclusive options is what a
 * radiogroup is for, `aria-pressed` cannot express three states, and it matches
 * the two radiogroups Settings > Appearance already renders (tick colour,
 * typeface).
 */
describe("ThemePreferenceChoice (#85)", () => {
  it("offers exactly system / light / dark, in that order", () => {
    stubOsPrefersDark(false);
    render(<ThemePreferenceChoice voice="plain" />);
    const radios = screen.getAllByRole("radio");
    expect(radios).toHaveLength(3);
    expect(radios.map((r) => (r as HTMLInputElement).value)).toEqual([
      "system",
      "light",
      "dark",
    ]);
  });

  it("is a labelled group, and every option has visible words", () => {
    stubOsPrefersDark(false);
    render(<ThemePreferenceChoice voice="plain" />);
    expect(screen.getByRole("group", { name: /theme/i })).toBeInTheDocument();
    for (const name of [/follow my system/i, /^light$/i, /^dark$/i]) {
      expect(screen.getByRole("radio", { name })).toBeInTheDocument();
    }
  });

  it("checks system when nothing has been chosen", async () => {
    stubOsPrefersDark(false);
    document.documentElement.setAttribute(THEME_ATTRIBUTE, "system");
    render(<ThemePreferenceChoice voice="plain" />);
    await flush();
    expect(
      screen.getByRole("radio", { name: /follow my system/i }),
    ).toBeChecked();
  });

  it("checks the explicit choice a returning user made", async () => {
    stubOsPrefersDark(false);
    document.documentElement.setAttribute(THEME_ATTRIBUTE, "dark");
    document.documentElement.classList.add("dark");
    render(<ThemePreferenceChoice voice="plain" />);
    await flush();
    expect(screen.getByRole("radio", { name: /^dark$/i })).toBeChecked();
  });

  // Choosing `system` on a dark device must actually go dark — the whole point.
  it("choosing system adopts the OS setting immediately", async () => {
    stubOsPrefersDark(true);
    document.documentElement.setAttribute(THEME_ATTRIBUTE, "light");
    render(<ThemePreferenceChoice voice="plain" />);
    await flush();
    await userEvent.click(screen.getByRole("radio", { name: /follow my/i }));
    expect(storedTheme()).toBe("system");
    expect(document.documentElement.classList.contains("dark")).toBe(true);
  });

  it("choosing dark overrides a light OS", async () => {
    stubOsPrefersDark(false);
    render(<ThemePreferenceChoice voice="plain" />);
    await userEvent.click(screen.getByRole("radio", { name: /^dark$/i }));
    expect(storedTheme()).toBe("dark");
    expect(document.documentElement.classList.contains("dark")).toBe(true);
  });

  it("stays in sync with the header toggle mounted alongside it", async () => {
    stubOsPrefersDark(false);
    render(
      <>
        <ThemeToggle variant="icon" />
        <ThemePreferenceChoice voice="plain" />
      </>,
    );
    await userEvent.click(screen.getByRole("button"));
    await flush();
    expect(screen.getByRole("radio", { name: /^dark$/i })).toBeChecked();
  });

  it("flags a successful save, and stays quiet when storage refuses", async () => {
    stubOsPrefersDark(false);
    const onPersist = vi.fn();
    render(<ThemePreferenceChoice voice="plain" onPersist={onPersist} />);
    await userEvent.click(screen.getByRole("radio", { name: /^dark$/i }));
    expect(onPersist).toHaveBeenCalledTimes(1);

    vi.stubGlobal("localStorage", {
      getItem: () => null,
      setItem: () => {
        throw new Error("SecurityError");
      },
      removeItem: () => {},
      clear: () => {},
    });
    await userEvent.click(screen.getByRole("radio", { name: /^light$/i }));
    expect(onPersist).toHaveBeenCalledTimes(1);
  });

  // The group carries a description, the same way the typeface radiogroup does —
  // and it is the sentence that answers the request this issue came from ("dark
  // mode automatic with time of day"), so it has to actually reach AT rather
  // than sit next to the control as unassociated prose.
  it("describes the group, so 'Follow my system' explains itself (a11y)", () => {
    stubOsPrefersDark(false);
    render(<ThemePreferenceChoice voice="plain" />);
    expect(
      screen.getByRole("group", { name: /theme/i }),
    ).toHaveAccessibleDescription(/device|system/i);
  });

  // One radiogroup per name, or a second instance would steal the first's
  // selection. Only Settings renders it today; this pins the assumption.
  it("groups its options under one radio name", () => {
    stubOsPrefersDark(false);
    render(<ThemePreferenceChoice voice="plain" />);
    const names = new Set(
      screen.getAllByRole("radio").map((r) => (r as HTMLInputElement).name),
    );
    expect(names.size).toBe(1);
  });
});
