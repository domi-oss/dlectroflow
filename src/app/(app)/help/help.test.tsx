// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import HelpPage from "./page";

// The rest of the props are spread through rather than dropped, so the
// components' own attributes (#131's `data-back-link`) reach the DOM.
vi.mock("next/link", () => ({
  default: ({
    children,
    href,
    ...rest
  }: {
    children: React.ReactNode;
    href: string;
  }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));
vi.mock("@/lib/db", () => ({
  getSettings: vi.fn().mockResolvedValue({ voice: "plain" }),
}));
vi.mock("@/lib/workspace", () => ({
  currentWorkspaceId: vi.fn().mockResolvedValue("owner"),
}));

afterEach(cleanup);

describe("HelpPage", () => {
  it("renders the getting-started guide sections", async () => {
    render(await HelpPage({ searchParams: Promise.resolve({}) }));
    expect(
      screen.getByRole("heading", { name: /Help & getting started/i }),
    ).toBeInTheDocument();
    for (const heading of [
      /Getting started/i,
      /The inbox & freshness/i,
      /Task breakdown/i,
      /The focus session/i,
      /Voice & settings/i,
      /Guests & AI limits/i,
    ]) {
      expect(
        screen.getByRole("heading", { name: heading, level: 2 }),
      ).toBeInTheDocument();
    }
  });

  // The focus session gained real depth in v0.4.0 (#27 pause/resume, #43 + #68
  // music, #66 setup screen) while this page still described none of it. These
  // assertions are deliberately about the CONTROLS a user looks for, so the page
  // can't silently drift behind the app again.
  it("documents the focus session: setup chips, pause/resume, and the music player", async () => {
    render(await HelpPage({ searchParams: Promise.resolve({}) }));
    const section = screen
      .getByRole("heading", { name: /The focus session/i, level: 2 })
      .closest("section");
    expect(section).not.toBeNull();
    const text = section!.textContent ?? "";
    // #66 — duration is chosen from chips, not typed into a field.
    expect(text).toMatch(/chips/i);
    // #27 — pausing persists rather than discarding the session.
    expect(text).toMatch(/pause/i);
    expect(text).toMatch(/resume/i);
    // #43 / #68 — the music, and that it follows the timer.
    expect(text).toMatch(/shuffle/i);
    expect(text).toMatch(/lo-?fi|music/i);
  });

  // #89 — the ring's breathing pacer has no setting and no on-screen
  // instructions (deliberately: it must not add a decision or compete with the
  // controls), so this page is the one place that names it — including that
  // reduced motion is its only off switch. #65 shipped the opt-in reverse pause
  // coupling without updating this section, which still described only the
  // original one-way behaviour.
  it("documents the breathing pacer (#89) and the two-way pause coupling (#65)", async () => {
    render(await HelpPage({ searchParams: Promise.resolve({}) }));
    const section = screen
      .getByRole("heading", { name: /The focus session/i, level: 2 })
      .closest("section");
    const text = section!.textContent ?? "";
    // The pacer: what it is, and that it is a real cadence you can follow.
    expect(text).toMatch(/breath/i);
    expect(text).toMatch(/four seconds/i);
    expect(text).toMatch(/six/i);
    // …that it spans the session rather than one screen of it…
    expect(text).toMatch(/whole session/i);
    // …and that reduced motion switches it off rather than slowing it.
    expect(text).toMatch(/reduced motion/i);
    // #65 — the player's pause button can drive the session, if asked to.
    expect(text).toMatch(/Pause music and timer together/i);
  });

  it("routes from the focus section to the Settings page that owns the track picker", async () => {
    render(await HelpPage({ searchParams: Promise.resolve({}) }));
    const section = screen
      .getByRole("heading", { name: /The focus session/i, level: 2 })
      .closest("section");
    expect(section).not.toBeNull();
    // The picker lives in Settings, so this section must link there rather than
    // naming a control the reader then has to hunt for.
    const hrefs = Array.from(section!.querySelectorAll("a")).map((a) =>
      a.getAttribute("href"),
    );
    expect(hrefs).toContain("/settings?from=help");
  });

  it("links to settings (carrying ?from=help) and defaults its back link to the inbox", async () => {
    render(await HelpPage({ searchParams: Promise.resolve({}) }));
    const hrefs = screen
      .getAllByRole("link")
      .map((a) => a.getAttribute("href"));
    // Settings deep-links carry the origin so Settings can offer "Back to Help".
    expect(hrefs).toContain("/settings?from=help");
    // With no `?from=`, the shared back link falls back to the inbox.
    expect(hrefs).toContain("/");
  });

  it("is origin-aware: ?from=settings sends the '← Back' link to Settings", async () => {
    render(
      await HelpPage({ searchParams: Promise.resolve({ from: "settings" }) }),
    );
    // Label is a simple "← Back"; only the destination reflects the origin.
    const back = document.querySelector('[data-back-link="page"]')!;
    expect(back).toHaveTextContent("← Back");
    expect(back).toHaveAttribute("href", "/settings");
  });

  // #131 — the page-level control scrolls away with the header, so the sticky
  // "Jump to…" bar carries a second copy. Both are the same component; what this
  // page owes them is the SAME origin, or the exit on a scrolled page quietly
  // sends the reader somewhere the one at the top would not have.
  it("hands the same origin to the sticky bar's back control (#131)", async () => {
    render(
      await HelpPage({ searchParams: Promise.resolve({ from: "settings" }) }),
    );
    const nav = screen.getByRole("navigation", { name: "Help sections" });
    const sticky = nav.querySelector('[data-back-link="bar"]')!;
    expect(sticky).not.toBeNull();
    expect(sticky).toHaveAttribute("href", "/settings");
    expect(sticky).toHaveTextContent("← Back");
    // Exactly two: the one at the top of the page and the one in the bar. A
    // third would mean a page-level recipe crept back in.
    expect(document.querySelectorAll("[data-back-link]")).toHaveLength(2);
  });

  it("defaults the sticky back control to the inbox with no origin (#131)", async () => {
    render(await HelpPage({ searchParams: Promise.resolve({}) }));
    const nav = screen.getByRole("navigation", { name: "Help sections" });
    expect(nav.querySelector('[data-back-link="bar"]')).toHaveAttribute(
      "href",
      "/",
    );
  });
});
