// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  render,
  screen,
  cleanup,
  act,
  fireEvent,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SectionNav } from "@/components/nav/section-nav";
import { SectionHeading } from "@/components/nav/section-heading";
import {
  HELP_SECTIONS,
  SECTION_ACTIVATE_EVENT,
  sectionLabel,
} from "@/lib/section-nav";
import type { Voice } from "@/lib/strings";

// ── IntersectionObserver stub ────────────────────────────────────────────────
// jsdom ships none. Capture the instances the nav creates so a test can drive
// "this section is now in the tracking band" by hand.
type IOEntryish = { target: Element; isIntersecting: boolean };
class FakeIntersectionObserver {
  static instances: FakeIntersectionObserver[] = [];
  readonly targets = new Set<Element>();
  constructor(
    private readonly cb: IntersectionObserverCallback,
    readonly options?: IntersectionObserverInit,
  ) {
    FakeIntersectionObserver.instances.push(this);
  }
  observe(el: Element) {
    this.targets.add(el);
  }
  unobserve(el: Element) {
    this.targets.delete(el);
  }
  disconnect() {
    this.targets.clear();
  }
  takeRecords() {
    return [];
  }
  fire(entries: IOEntryish[]) {
    act(() => {
      this.cb(
        entries as unknown as IntersectionObserverEntry[],
        this as unknown as IntersectionObserver,
      );
    });
  }
}

/** Install a `matchMedia` stub whose `matches` is driven by `wide`. */
function mockViewport(wide: boolean) {
  window.matchMedia = vi.fn().mockImplementation((media: string) => ({
    matches: wide,
    media,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => true,
    onchange: null,
  })) as unknown as typeof window.matchMedia;
}

/** The Help page in miniature: the real nav over the real headings. */
function Page({
  voice = "plain" as Voice,
  sections = HELP_SECTIONS as readonly (typeof HELP_SECTIONS)[number][],
  /** Headings on the page. Defaults to `sections`, but can be held constant to
   *  reproduce the split case: a heading still in the DOM for a section the nav
   *  no longer lists. */
  headings = sections,
}: {
  voice?: Voice;
  sections?: readonly (typeof HELP_SECTIONS)[number][];
  headings?: readonly (typeof HELP_SECTIONS)[number][];
}) {
  return (
    <>
      <SectionNav sections={sections} voice={voice} label="Help sections" />
      {headings.map((s) => (
        <section key={s.id}>
          <SectionHeading id={s.id} voice={voice} />
          <p>body of {s.id}</p>
        </section>
      ))}
    </>
  );
}

const list = () =>
  document.getElementById(toggle().getAttribute("aria-controls")!)!;
const toggle = () => screen.getByRole("button", { name: /jump to/i });

beforeEach(() => {
  FakeIntersectionObserver.instances = [];
  vi.stubGlobal("IntersectionObserver", FakeIntersectionObserver);
  mockViewport(true);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  // @ts-expect-error – drop the per-test stub
  delete window.matchMedia;
  document.documentElement.removeAttribute("style");
  document.documentElement.className = "";
});

describe("SectionNav (#72)", () => {
  it("is a named landmark, so screen readers can find it among the page's navs", () => {
    render(<Page />);
    expect(
      screen.getByRole("navigation", { name: "Help sections" }),
    ).toBeInTheDocument();
  });

  it("renders exactly one entry per section, and every target id really exists", () => {
    render(<Page />);
    const nav = screen.getByRole("navigation", { name: "Help sections" });
    const links = Array.from(nav.querySelectorAll("a"));
    expect(links).toHaveLength(HELP_SECTIONS.length);

    for (const section of HELP_SECTIONS) {
      const label = sectionLabel(section, "plain");
      const link = screen.getByRole("link", { name: label });
      expect(link).toHaveAttribute("href", `#${section.id}`);
      // Drift guard: the anchor must land on a real heading, not nothing.
      const target = document.getElementById(section.id);
      expect(target, `no target for #${section.id}`).not.toBeNull();
      expect(target!.tagName).toBe("H2");
      expect(target).toHaveTextContent(label);
    }
  });

  it("exposes collapse state: aria-expanded on a button that owns the list", async () => {
    render(<Page />);
    const btn = toggle();
    expect(btn).toHaveAttribute("aria-expanded", "false");
    expect(btn).toHaveAttribute("aria-controls", list().id);
    expect(list()).toHaveClass("hidden");

    await userEvent.click(btn);
    expect(btn).toHaveAttribute("aria-expanded", "true");
    expect(list()).not.toHaveClass("hidden");

    await userEvent.click(btn);
    expect(btn).toHaveAttribute("aria-expanded", "false");
    expect(list()).toHaveClass("hidden");
  });

  it("rests COLLAPSED at every viewport — the compact row is the default", () => {
    // Owner call: the resting state of both pages is the one-line bar, wide
    // screens included. It also means server and client agree on first paint.
    for (const wide of [true, false]) {
      mockViewport(wide);
      const view = render(<Page />);
      expect(toggle()).toHaveAttribute("aria-expanded", "false");
      view.unmount();
    }
  });

  it("marks the current section with aria-current plus a non-colour cue", () => {
    render(<Page />);
    const io = FakeIntersectionObserver.instances.at(-1)!;
    const target = document.getElementById("help-task-breakdown")!;
    const observed = target.closest("section")!;
    expect(io.targets.has(observed)).toBe(true);

    io.fire([{ target: observed, isIntersecting: true }]);

    const link = screen.getByRole("link", { name: "Task breakdown" });
    expect(link).toHaveAttribute("aria-current", "true");
    // Not colour alone: the current entry also grows a marker element.
    expect(link.querySelector("[data-current-marker]")).not.toBeNull();
    // …and nothing else claims to be current.
    expect(document.querySelectorAll("a[aria-current]")).toHaveLength(1);
  });

  it("hands the current section to its own heading band, for the sticky header", () => {
    render(<Page />);
    const io = FakeIntersectionObserver.instances.at(-1)!;
    // The BAND is what sticks and what globals.css styles, so that is what gets
    // marked — not the h2 inside it.
    const band = (id: string) =>
      document.getElementById(id)!.closest("[data-section-header]")!;
    const breakdown = band("help-task-breakdown");
    const inbox = band("help-inbox-freshness");

    io.fire([{ target: inbox.closest("section")!, isIntersecting: true }]);
    expect(inbox).toHaveAttribute("data-current");
    // Exactly one heading is ever marked — globals.css keys the pinned magenta
    // header off this attribute, so two would mean two highlighted headers.
    expect(document.querySelectorAll("[data-current]")).toHaveLength(1);

    io.fire([
      { target: inbox.closest("section")!, isIntersecting: false },
      { target: breakdown.closest("section")!, isIntersecting: true },
    ]);
    expect(inbox).not.toHaveAttribute("data-current");
    expect(breakdown).toHaveAttribute("data-current");
    expect(document.querySelectorAll("[data-current]")).toHaveLength(1);
  });

  it("cleans the heading marker up when the nav unmounts", () => {
    const view = render(<Page />);
    const io = FakeIntersectionObserver.instances.at(-1)!;
    const heading = document.getElementById("help-task-breakdown")!;
    const band = heading.closest("[data-section-header]")!;
    io.fire([{ target: heading.closest("section")!, isIntersecting: true }]);
    expect(band).toHaveAttribute("data-current");
    view.unmount();
    expect(band).not.toHaveAttribute("data-current");
  });

  it("never marks a band the nav no longer lists (the split case)", () => {
    // Review finding on !162: the band marker used the raw `current` id while
    // the pill used the resolved section, so a heading still in the DOM for a
    // dropped section could pin itself magenta with no pill lit — two "you are
    // here" cues disagreeing. Here the headings stay put and only the nav's
    // list shrinks.
    const all = [...HELP_SECTIONS];
    const { rerender } = render(<Page sections={all} />);
    const io = FakeIntersectionObserver.instances.at(-1)!;
    const heading = document.getElementById("help-guests-ai-limits")!;
    const band = heading.closest("[data-section-header]")!;
    io.fire([{ target: heading.closest("section")!, isIntersecting: true }]);
    expect(band).toHaveAttribute("data-current");

    rerender(<Page sections={all.slice(0, -1)} headings={all} />);

    // The heading is still on the page…
    expect(document.getElementById("help-guests-ai-limits")).not.toBeNull();
    // …but nothing claims to be current, on either layer.
    expect(document.querySelectorAll("[data-current]")).toHaveLength(0);
    expect(document.querySelectorAll("a[aria-current]")).toHaveLength(0);
  });

  it("picks the topmost section when several are in the tracking band", () => {
    render(<Page />);
    const io = FakeIntersectionObserver.instances.at(-1)!;
    const first = document
      .getElementById("help-getting-started")!
      .closest("section")!;
    const second = document
      .getElementById("help-inbox-freshness")!
      .closest("section")!;

    io.fire([
      { target: second, isIntersecting: true },
      { target: first, isIntersecting: true },
    ]);
    expect(
      screen.getByRole("link", { name: "Getting started" }),
    ).toHaveAttribute("aria-current", "true");

    io.fire([{ target: first, isIntersecting: false }]);
    expect(
      screen.getByRole("link", { name: "The inbox & freshness" }),
    ).toHaveAttribute("aria-current", "true");
  });

  // ── #101: an EXPLICIT choice outranks the scroll-spy ──────────────────────
  //
  // Two callers name a section outright: a nav jump, and (new in #101) a click on
  // a collapsible section's own header. "Topmost section in the tracking band
  // wins" is the right answer for scrolling and the wrong answer for both of
  // those — the section you just asked for is frequently NOT the topmost one on
  // screen, and near the bottom of the page the end-of-page rule would hand the
  // highlight to the last section instead.
  describe("explicitly activated sections (#101)", () => {
    /** Put a section's rect on or off screen for `stillOnScreen`. */
    function stubRect(id: string, top: number, bottom: number) {
      const section = document.getElementById(id)!.closest("section")!;
      vi.spyOn(section, "getBoundingClientRect").mockReturnValue({
        top,
        bottom,
        left: 0,
        right: 0,
        width: 100,
        height: bottom - top,
        x: 0,
        y: top,
        toJSON: () => ({}),
      } as DOMRect);
      return section;
    }

    /** What a header click publishes (see announceSectionActive). */
    function activate(id: string) {
      act(() => {
        window.dispatchEvent(
          new CustomEvent(SECTION_ACTIVATE_EVENT, { detail: { id } }),
        );
      });
    }

    it("highlights the section whose header was clicked", () => {
      render(<Page />);
      activate("help-task-breakdown");

      // Reuses !162's cues wholesale: the pill, its non-colour marker dot and
      // the pinned magenta band on that section's own heading.
      const link = screen.getByRole("link", { name: "Task breakdown" });
      expect(link).toHaveAttribute("aria-current", "true");
      expect(link.querySelector("[data-current-marker]")).not.toBeNull();
      expect(
        document
          .getElementById("help-task-breakdown")!
          .closest("[data-section-header]"),
      ).toHaveAttribute("data-current");
      expect(document.querySelectorAll("[data-current]")).toHaveLength(1);
    });

    it("is not stolen by the topmost section in the band", () => {
      // Clicking a header lower down the page expands it and moves everything
      // below — which fires the observer, whose topmost-wins verdict is some
      // section ABOVE the one just clicked.
      render(<Page />);
      const io = FakeIntersectionObserver.instances.at(-1)!;
      const clicked = stubRect("help-task-breakdown", 300, 600);
      const above = stubRect("help-getting-started", 0, 300);
      activate("help-task-breakdown");

      io.fire([
        { target: above, isIntersecting: true },
        { target: clicked, isIntersecting: true },
      ]);

      expect(
        screen.getByRole("link", { name: "Task breakdown" }),
      ).toHaveAttribute("aria-current", "true");
      expect(document.querySelectorAll("a[aria-current]")).toHaveLength(1);
    });

    it("hands control back to the spy once that section is scrolled away", () => {
      render(<Page />);
      const io = FakeIntersectionObserver.instances.at(-1)!;
      const clicked = stubRect("help-task-breakdown", 300, 600);
      const above = stubRect("help-getting-started", 0, 300);
      activate("help-task-breakdown");
      io.fire([{ target: clicked, isIntersecting: true }]);
      expect(
        screen.getByRole("link", { name: "Task breakdown" }),
      ).toHaveAttribute("aria-current", "true");

      // Scrolled clean past it (rect now entirely above the viewport).
      vi.spyOn(clicked, "getBoundingClientRect").mockReturnValue({
        top: -400,
        bottom: -100,
        height: 300,
        left: 0,
        right: 0,
        width: 100,
        x: 0,
        y: -400,
        toJSON: () => ({}),
      } as DOMRect);
      io.fire([
        { target: clicked, isIntersecting: false },
        { target: above, isIntersecting: true },
      ]);

      // The override released itself — no sticky highlight left behind.
      expect(
        screen.getByRole("link", { name: "Getting started" }),
      ).toHaveAttribute("aria-current", "true");
    });

    it("releases a section that has left the PAGE, rather than freezing", () => {
      // A save calls router.refresh(), and Settings renders a different section
      // set for owner vs guest — so the section a reader named can disappear
      // before the scroll reaches it. Holding the highlight for it would freeze
      // the spy for the rest of the visit.
      render(<Page />);
      const io = FakeIntersectionObserver.instances.at(-1)!;
      const first = document
        .getElementById("help-getting-started")!
        .closest("section")!;
      activate("help-a-section-that-is-not-here");

      io.fire([{ target: first, isIntersecting: true }]);

      expect(
        screen.getByRole("link", { name: "Getting started" }),
      ).toHaveAttribute("aria-current", "true");
    });

    it("is not stolen by the end-of-page rule either", () => {
      // The end-of-page rule exists because the LAST section can never reach the
      // top of the viewport. Applied to an explicit choice it hands the highlight
      // to the wrong section for anything near the bottom — which is exactly
      // where #101's reorder put Integrations and Demo.
      render(<Page />);
      const io = FakeIntersectionObserver.instances.at(-1)!;
      Object.defineProperty(document.documentElement, "scrollHeight", {
        value: 2000,
        configurable: true,
      });
      Object.defineProperty(window, "scrollY", {
        value: 2000 - window.innerHeight,
        configurable: true,
      });
      const clicked = stubRect("help-voice-settings", 200, 500);
      activate("help-voice-settings");

      io.fire([{ target: clicked, isIntersecting: true }]);

      expect(
        screen.getByRole("link", { name: "Voice & settings" }),
      ).toHaveAttribute("aria-current", "true");
    });

    it("still lets a nav jump name a section the page cannot scroll to the top", () => {
      // Same rule, reached the other way: the jump handler names its target, so
      // jumping to the second-to-last section lights THAT one rather than the
      // last one the end-of-page rule would pick.
      render(<Page />);
      const io = FakeIntersectionObserver.instances.at(-1)!;
      Object.defineProperty(document.documentElement, "scrollHeight", {
        value: 2000,
        configurable: true,
      });
      Object.defineProperty(window, "scrollY", {
        value: 2000 - window.innerHeight,
        configurable: true,
      });
      const target = stubRect("help-voice-settings", 200, 500);

      fireEvent.click(screen.getByRole("link", { name: "Voice & settings" }), {
        button: 0,
      });
      io.fire([{ target, isIntersecting: true }]);

      expect(
        screen.getByRole("link", { name: "Voice & settings" }),
      ).toHaveAttribute("aria-current", "true");
    });
  });

  it("on a narrow viewport, picking a section closes the list and focuses the heading", async () => {
    mockViewport(false);
    render(<Page />);
    await userEvent.click(toggle());
    expect(toggle()).toHaveAttribute("aria-expanded", "true");

    await userEvent.click(screen.getByRole("link", { name: "Task breakdown" }));

    // The list gets out of the way again — it is a sticky bar on a small screen.
    expect(toggle()).toHaveAttribute("aria-expanded", "false");
    // …and focus is on the heading, never dropped on the collapsed list.
    expect(document.activeElement).toBe(
      document.getElementById("help-task-breakdown"),
    );
  });

  it("on a wide viewport the map stays open after you jump", async () => {
    render(<Page />);
    await userEvent.click(toggle());
    await userEvent.click(screen.getByRole("link", { name: "Task breakdown" }));
    expect(toggle()).toHaveAttribute("aria-expanded", "true");
    expect(document.activeElement).toBe(
      document.getElementById("help-task-breakdown"),
    );
  });

  it("publishes its live height so a jump target clears the sticky bar", () => {
    const view = render(<Page />);
    expect(
      document.documentElement.style.getPropertyValue("--section-nav-h"),
    ).toMatch(/px$/);
    view.unmount();
    expect(
      document.documentElement.style.getPropertyValue("--section-nav-h"),
    ).toBe("");
  });

  it("opts the document into smooth scrolling only while it is mounted", () => {
    const view = render(<Page />);
    // prefers-reduced-motion is honoured by the global rule in globals.css,
    // which forces scroll-behavior:auto — so opting in is safe here.
    expect(document.documentElement).toHaveClass("scroll-smooth");
    view.unmount();
    expect(document.documentElement).not.toHaveClass("scroll-smooth");
  });

  it("survives the section list shrinking while `current` still points into it", () => {
    // Real path (!162 review): the Settings page renders a DIFFERENT section
    // set depending on owner/google status, and several settings saves call
    // router.refresh(). When the new props arrive, the component re-renders
    // with the shorter list BEFORE the effect can rebuild the observer, so
    // `current` still names a section that is no longer there.
    const all = [...HELP_SECTIONS];
    const { rerender } = render(<Page sections={all} />);
    const io = FakeIntersectionObserver.instances.at(-1)!;
    const lastSection = document
      .getElementById("help-guests-ai-limits")!
      .closest("section")!;
    io.fire([{ target: lastSection, isIntersecting: true }]);
    expect(
      screen.getByRole("link", { name: "Guests & AI limits" }),
    ).toHaveAttribute("aria-current", "true");

    // Drop the section that is currently marked.
    expect(() => rerender(<Page sections={all.slice(0, -1)} />)).not.toThrow();

    // Nothing claims to be current: we no longer know where the reader is, and
    // guessing would put aria-current on the wrong entry. The observer sets it
    // again on the next scroll.
    expect(document.querySelectorAll("a[aria-current]")).toHaveLength(0);
  });

  it("tracks the section, not just the heading, so short headings don't flicker", () => {
    render(<Page />);
    const io = FakeIntersectionObserver.instances.at(-1)!;
    for (const el of io.targets) expect(el.tagName).toBe("SECTION");
    expect(io.targets.size).toBe(HELP_SECTIONS.length);
  });
});

describe("SectionHeading (#72)", () => {
  it("gives every jump target the scroll-margin hook and programmatic focus", () => {
    render(<Page />);
    for (const section of HELP_SECTIONS) {
      const h = document.getElementById(section.id)!;
      expect(h).toHaveAttribute("data-section-target");
      expect(h).toHaveAttribute("tabindex", "-1");
    }
  });

  it("renders the same text the nav shows, in the requested voice", () => {
    render(<Page voice="playful" />);
    // Help copy is voice-neutral by design; the settings registry is not
    // (covered in src/components/settings/section-headings.test.tsx).
    expect(document.getElementById("help-getting-started")).toHaveTextContent(
      "Getting started",
    );
  });
});
