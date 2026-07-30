// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { CollapsibleSection } from "@/components/nav/collapsible-section";
import { announceSectionJump, SECTION_ACTIVATE_EVENT } from "@/lib/section-nav";

afterEach(() => {
  cleanup();
  window.location.hash = "";
});

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

describe("CollapsibleSection — being asked for opens it (#115)", () => {
  /**
   * jsdom implements no layout, so it has no `scrollIntoView` at all. Stubbing
   * it is what lets these tests see WHEN the landing is issued relative to the
   * expansion, which is the half of #115 that a "did it open?" assertion misses.
   */
  const landings: { id: string; hidden: boolean }[] = [];
  const scrollIntoView = vi.fn(function (this: Element) {
    // `this` is the section's own <h2> — the element the landing was aimed at.
    // Recording WHICH one, and whether its body was on the page at the time, is
    // what lets these tests see both halves of #115 without layout.
    const controls = this.querySelector("[data-section-toggle]")?.getAttribute(
      "aria-controls",
    );
    const sectionBody = controls ? document.getElementById(controls) : null;
    landings.push({
      id: this.id,
      hidden: sectionBody?.hasAttribute("hidden") ?? true,
    });
  });

  function withScrollIntoView() {
    landings.length = 0;
    scrollIntoView.mockClear();
    Element.prototype.scrollIntoView = scrollIntoView;
  }

  afterEach(() => {
    // @ts-expect-error – jsdom never had one; put the absence back.
    delete Element.prototype.scrollIntoView;
  });

  /** Change the fragment the way a browser does: set it, then announce it. */
  function setFragment(next: string) {
    act(() => {
      window.location.hash = next;
      window.dispatchEvent(new HashChangeEvent("hashchange"));
    });
  }

  /** What the nav publishes when a "Jump to…" pill is activated. */
  function jumpTo(id: string) {
    act(() => announceSectionJump(id));
  }

  it("opens when the page is loaded at its own fragment", () => {
    // The whole point of #115's second half: /settings#settings-voice used to
    // land on a title with nothing under it.
    withScrollIntoView();
    window.location.hash = "#settings-voice";
    renderSection();
    expect(trigger()).toHaveAttribute("aria-expanded", "true");
    expect(body()).not.toHaveAttribute("hidden");
  });

  it("leaves a section the fragment does not name exactly where it was", () => {
    withScrollIntoView();
    window.location.hash = "#settings-demo";
    renderSection();
    expect(trigger()).toHaveAttribute("aria-expanded", "false");
    expect(body()).toHaveAttribute("hidden");
    expect(scrollIntoView).not.toHaveBeenCalled();
  });

  it("opens on a fragment change — clicking a nav pill IS one", () => {
    withScrollIntoView();
    renderSection();
    expect(trigger()).toHaveAttribute("aria-expanded", "false");
    setFragment("#settings-voice");
    expect(trigger()).toHaveAttribute("aria-expanded", "true");
  });

  it("never toggles an already-open section shut", () => {
    withScrollIntoView();
    renderSection({ defaultExpanded: true });
    setFragment("#settings-voice");
    expect(trigger()).toHaveAttribute("aria-expanded", "true");
    jumpTo("settings-voice");
    expect(trigger()).toHaveAttribute("aria-expanded", "true");
  });

  it("opens on an explicit jump even when the fragment already named it", () => {
    // The case the fragment alone cannot see: the pill is clicked a SECOND
    // time, so `location.hash` does not change and no hashchange fires.
    withScrollIntoView();
    window.location.hash = "#settings-voice";
    renderSection();
    expect(trigger()).toHaveAttribute("aria-expanded", "true");

    // The reader closes it by hand, with the fragment still pointing here.
    act(() => trigger().click());
    expect(trigger()).toHaveAttribute("aria-expanded", "false");

    jumpTo("settings-voice");
    expect(trigger()).toHaveAttribute("aria-expanded", "true");
  });

  it("does not re-open a section the reader deliberately collapsed", () => {
    withScrollIntoView();
    window.location.hash = "#settings-voice";
    const view = renderSection();
    act(() => trigger().click());
    expect(trigger()).toHaveAttribute("aria-expanded", "false");

    // Re-renders, and history events that leave the fragment alone (the
    // scroll-spy's own churn is exactly this shape), must not undo that.
    view.rerender(
      <CollapsibleSection id="settings-voice" voice="plain">
        <p>the voice controls</p>
      </CollapsibleSection>,
    );
    act(() => {
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    expect(trigger()).toHaveAttribute("aria-expanded", "false");
    expect(body()).toHaveAttribute("hidden");
  });

  it("ignores a jump aimed at a different section", () => {
    withScrollIntoView();
    renderSection();
    jumpTo("settings-demo");
    expect(trigger()).toHaveAttribute("aria-expanded", "false");
    expect(scrollIntoView).not.toHaveBeenCalled();
  });

  it("lands on the heading only AFTER the body is on the page", () => {
    // #115's subtlety, and the reason this is not just `setExpanded(true)`:
    // expanding raises the document's scroll limit, so a landing computed
    // against the collapsed page clamps short and leaves the heading somewhere
    // down the viewport. The DOM must already be expanded when the scroll is
    // issued. (The resulting scroll POSITION is asserted in
    // e2e/smoke/section-nav.spec.ts, where there is real layout.)
    withScrollIntoView();
    window.location.hash = "#settings-voice";
    renderSection();
    expect(scrollIntoView).toHaveBeenCalled();
    expect(landings).not.toHaveLength(0);
    expect(landings.every((l) => !l.hidden)).toBe(true);
    // No `behavior` argument, deliberately: that leaves it to CSS, which is
    // `scroll-smooth` while the nav is mounted and `auto` under
    // prefers-reduced-motion (globals.css) — the same one rule the rest of the
    // app honours.
    expect(scrollIntoView).toHaveBeenCalledWith();
  });

  it("lands again when the reader asks again after closing it", () => {
    withScrollIntoView();
    window.location.hash = "#settings-voice";
    renderSection();
    const first = scrollIntoView.mock.calls.length;
    act(() => trigger().click());
    jumpTo("settings-voice");
    expect(scrollIntoView.mock.calls.length).toBeGreaterThan(first);
    expect(landings.at(-1)).toEqual({ id: "settings-voice", hidden: false });
  });

  it("does not move the page when the reader opens a section by its own header", () => {
    // Opening a section you are already looking at must not yank it to the top
    // of the viewport — only an explicit "take me there" scrolls.
    withScrollIntoView();
    renderSection();
    act(() => trigger().click());
    expect(trigger()).toHaveAttribute("aria-expanded", "true");
    expect(scrollIntoView).not.toHaveBeenCalled();
  });

  it("does not drag the page back to itself when the reader leaves for another section", () => {
    // Review finding on !205, and the nastiest shape this bug takes: a section
    // the reader has ALREADY visited still has its ask on the books, so a
    // fragment moving AWAY from it must not read as a request to come back.
    //
    // The order is what makes it a landing bug rather than a flicker. Effects
    // run in tree order, so the section LOWER on the page fires last and its
    // landing is the one that stands — jumping back UP to an earlier section
    // would leave the reader at the later one.
    withScrollIntoView();
    render(
      <>
        <CollapsibleSection id="settings-appearance" voice="plain">
          <p>A: appearance</p>
        </CollapsibleSection>
        <CollapsibleSection id="settings-demo" voice="plain">
          <p>B: demo</p>
        </CollapsibleSection>
      </>,
    );

    // A, then B — so both have been asked for at least once.
    setFragment("#settings-appearance");
    expect(landings.at(-1)?.id).toBe("settings-appearance");
    setFragment("#settings-demo");
    expect(landings.at(-1)?.id).toBe("settings-demo");

    // …and back to A. B is lower on the page, so if it answered at all it
    // would answer LAST and win.
    const atB = landings.filter((l) => l.id === "settings-demo").length;
    setFragment("#settings-appearance");
    expect(landings.at(-1)?.id).toBe("settings-appearance");
    // Nothing aimed at B in that last round AT ALL — not merely out-ordered by
    // A, which is what "the page happens to end up right" would look like.
    expect(landings.filter((l) => l.id === "settings-demo")).toHaveLength(atB);
  });

  it("a jump to another section leaves this one open, just not landed on", () => {
    // Leaving is not closing: a section the reader opened stays open behind
    // them. Only the LANDING is withdrawn.
    withScrollIntoView();
    render(
      <>
        <CollapsibleSection id="settings-appearance" voice="plain">
          <p>A: appearance</p>
        </CollapsibleSection>
        <CollapsibleSection id="settings-demo" voice="plain">
          <p>B: demo</p>
        </CollapsibleSection>
      </>,
    );
    setFragment("#settings-demo");
    setFragment("#settings-appearance");
    expect(trigger("settings-demo")).toHaveAttribute("aria-expanded", "true");
    expect(trigger("settings-appearance")).toHaveAttribute(
      "aria-expanded",
      "true",
    );
  });

  it("keeps aria-expanded honest through every one of those routes", () => {
    withScrollIntoView();
    renderSection();
    const state = () => trigger().getAttribute("aria-expanded");
    const bodyHidden = () => String(!body().hasAttribute("hidden"));

    expect(state()).toBe("false");
    expect(state()).toBe(bodyHidden());
    setFragment("#settings-voice");
    expect(state()).toBe("true");
    expect(state()).toBe(bodyHidden());
    act(() => trigger().click());
    expect(state()).toBe("false");
    expect(state()).toBe(bodyHidden());
    jumpTo("settings-voice");
    expect(state()).toBe("true");
    expect(state()).toBe(bodyHidden());
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
