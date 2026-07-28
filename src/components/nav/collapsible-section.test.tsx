// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { CollapsibleSection } from "@/components/nav/collapsible-section";
import { SECTION_ACTIVATE_EVENT } from "@/lib/section-nav";

afterEach(cleanup);

/** The trigger for a section, by the stable hook every section carries. */
const trigger = (id = "settings-voice") =>
  document.querySelector<HTMLButtonElement>(`[data-section-toggle="${id}"]`)!;

const body = () =>
  document.getElementById(trigger().getAttribute("aria-controls")!)!;

function renderSection(props?: {
  defaultExpanded?: boolean;
  summary?: string;
  extras?: React.ReactNode;
}) {
  return render(
    <CollapsibleSection
      id="settings-voice"
      voice="plain"
      defaultExpanded={props?.defaultExpanded}
      summary={props?.summary}
      headingExtras={props?.extras}
    >
      <p>the voice controls</p>
    </CollapsibleSection>,
  );
}

describe("CollapsibleSection — the disclosure (#101)", () => {
  it("rests COLLAPSED, with the body hidden by the attribute and not a class", () => {
    renderSection();
    expect(trigger()).toHaveAttribute("aria-expanded", "false");
    // `hidden` the ATTRIBUTE: the subtree leaves the a11y tree and the tab order
    // without depending on a stylesheet.
    expect(body()).toHaveAttribute("hidden");
    expect(body().className).not.toMatch(/hidden/);
    // Still mounted, so aria-controls always resolves and section state survives
    // a close/open.
    expect(body()).toHaveTextContent("the voice controls");
    // Nothing behind it is reachable to the accessibility tree.
    expect(screen.queryByText("the voice controls")).not.toBeVisible();
  });

  it("opens and closes on click, keeping aria-expanded honest", async () => {
    const user = userEvent.setup();
    renderSection();

    await user.click(trigger());
    expect(trigger()).toHaveAttribute("aria-expanded", "true");
    expect(body()).not.toHaveAttribute("hidden");

    await user.click(trigger());
    expect(trigger()).toHaveAttribute("aria-expanded", "false");
    expect(body()).toHaveAttribute("hidden");
  });

  it("can start expanded — the page's first section, without a hydration flash", () => {
    // `defaultExpanded` is plain initial state (no effect), so the server and the
    // client render the same thing on the very first pass.
    renderSection({ defaultExpanded: true });
    expect(trigger()).toHaveAttribute("aria-expanded", "true");
    expect(body()).not.toHaveAttribute("hidden");
  });

  it("keeps the h2 as the jump target: id, focus and the scroll-margin hook", () => {
    renderSection();
    const heading = document.getElementById("settings-voice")!;
    expect(heading.tagName).toBe("H2");
    expect(heading).toHaveAttribute("data-section-target");
    expect(heading).toHaveAttribute("tabindex", "-1");
    // The trigger lives INSIDE the heading (the ARIA accordion pattern), so the
    // heading's accessible name is still exactly the section's registry label.
    expect(heading).toContainElement(trigger());
    expect(screen.getByRole("heading", { name: "Voice" })).toBe(heading);
  });

  it("puts the chevron BEFORE the title, decorative, and rotates it for state", async () => {
    const user = userEvent.setup();
    renderSection();
    const chevron = trigger().querySelector("svg")!;

    // Before the title, not at the right-hand end: the standard accordion
    // affordance reads as "this opens" rather than as decoration.
    expect(trigger().firstElementChild).toBe(chevron);
    expect(
      chevron.compareDocumentPosition(screen.getByText("Voice")) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();

    // Decorative: state is carried by aria-expanded, never announced as a caret.
    expect(chevron).toHaveAttribute("aria-hidden", "true");
    expect(trigger()).toHaveAccessibleName("Voice");

    // One element, rotated — not two glyphs swapped. Motion is a CSS transition,
    // so the global prefers-reduced-motion rule in globals.css governs it.
    expect(chevron.getAttribute("class")).toMatch(/transition-transform/);
    expect(chevron.getAttribute("class")).not.toMatch(/rotate-180/);
    await user.click(trigger());
    expect(trigger().querySelector("svg")!.getAttribute("class")).toMatch(
      /rotate-180/,
    );
  });

  it("makes the whole header row the click target, 44px tall", () => {
    renderSection();
    // #73's lesson: an 11x20px hit box is not a touch target. The trigger fills
    // the row rather than being a 16px glyph.
    expect(trigger().className).toMatch(/min-h-11/);
    expect(trigger().className).toMatch(/w-full/);
  });

  it("never uses bg-accent for hover — it composites to 1.16:1 in the magenta band", () => {
    // !175: the trigger sits inside the sticky section band, which globals.css
    // paints magenta and forces `color: currentColor` on while it is current.
    // A tint of currentColor is correct in both contexts by construction.
    renderSection();
    expect(trigger().className).not.toMatch(/bg-accent/);
    expect(trigger().className).toMatch(/hover:bg-current\/10/);
  });

  it("describes a collapsed section with its summary, without renaming it", async () => {
    renderSection({ summary: "3 accounts · 1 invitation pending" });
    // Visible while collapsed — that line is the collapsed row's justification…
    expect(screen.getByText("3 accounts · 1 invitation pending")).toBeVisible();
    // …and a screen-reader user gets it as the trigger's DESCRIPTION, so the
    // accessible name stays the section name (WCAG 2.5.3, Label in Name).
    expect(trigger()).toHaveAccessibleName("Voice");
    expect(trigger()).toHaveAccessibleDescription(
      "3 accounts · 1 invitation pending",
    );
  });

  it("renders heading extras as siblings of the h2, not inside it", () => {
    renderSection({ extras: <span data-testid="badge">saved</span> });
    const badge = screen.getByTestId("badge");
    const heading = document.getElementById("settings-voice")!;
    expect(heading).not.toContainElement(badge);
    expect(heading.parentElement).toContainElement(badge);
  });

  it("announces itself as the section the reader is now working in", async () => {
    // Owner request: "clicking other section headers should highlight the section
    // title". SectionNav owns that highlight (the headings live outside its
    // tree), so the click is published as one event it listens for — reusing
    // !162's magenta current-section treatment rather than adding a second one.
    const seen: string[] = [];
    const listener = (event: Event) =>
      seen.push((event as CustomEvent<{ id: string }>).detail.id);
    window.addEventListener(SECTION_ACTIVATE_EVENT, listener);
    try {
      const user = userEvent.setup();
      renderSection();
      await user.click(trigger());
      await user.click(trigger());
      // Both directions: clicking the header means "this is what I'm on", open
      // or closed.
      expect(seen).toEqual(["settings-voice", "settings-voice"]);
    } finally {
      window.removeEventListener(SECTION_ACTIVATE_EVENT, listener);
    }
  });

  it("is keyboard operable with a visible focus ring", async () => {
    const user = userEvent.setup();
    renderSection();
    await user.tab();
    expect(trigger()).toHaveFocus();
    expect(trigger().className).toContain("focus-visible:ring-2");

    await user.keyboard("{Enter}");
    expect(trigger()).toHaveAttribute("aria-expanded", "true");
    await user.keyboard(" ");
    expect(trigger()).toHaveAttribute("aria-expanded", "false");
  });

  it("wraps its content in a <section>, so the nav's observer has one target", () => {
    renderSection();
    const heading = document.getElementById("settings-voice")!;
    const section = heading.closest("section");
    expect(section).not.toBeNull();
    // The band must be a DIRECT child of the section or the header never pins
    // (the bug #72 fixed): the section is the sticky containing block.
    expect(
      section!.querySelector(":scope > [data-section-header]"),
    ).not.toBeNull();
  });

  it("keeps the body mounted, so a half-finished edit survives a close", async () => {
    const user = userEvent.setup();
    render(
      <CollapsibleSection id="settings-voice" voice="plain">
        <input aria-label="a pending edit" defaultValue="" />
      </CollapsibleSection>,
    );
    await user.click(trigger());
    const field = screen.getByLabelText("a pending edit");
    await user.type(field, "half typed");

    // Close and reopen: `hidden` hides, it does not unmount, so nothing the
    // reader had started is thrown away.
    await user.click(trigger());
    await user.click(trigger());
    expect(screen.getByLabelText("a pending edit")).toHaveValue("half typed");
  });
});

describe("CollapsibleSection — expansion is remembered for the visit only", () => {
  it("writes nothing to storage when it opens", async () => {
    const setItem = vi.fn();
    vi.stubGlobal("localStorage", {
      getItem: () => null,
      setItem,
      removeItem: vi.fn(),
      clear: vi.fn(),
    });
    try {
      const user = userEvent.setup();
      renderSection();
      await user.click(trigger());
      // !162's precedent: default rather than restore a state the reader has
      // forgotten they left.
      expect(setItem).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
