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
      /Your data/i,
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

  // #142 — the app now NAVIGATES ON ITS OWN five seconds after a step is
  // completed. A timed navigation nobody documented is experienced as the app
  // moving by itself, so this page owes the reader all four facts: that it
  // happens, how long they have, where it lands, and how to stop it. Escape is
  // asserted by name because it is the escape a screen-reader user can actually
  // reach inside five seconds (WCAG 2.2.1) and is invisible until described.
  it("documents the auto-advance countdown, where it lands, and both escapes (#142)", async () => {
    render(await HelpPage({ searchParams: Promise.resolve({}) }));
    const section = screen
      .getByRole("heading", { name: /The focus session/i, level: 2 })
      .closest("section");
    expect(section).not.toBeNull();
    const text = section!.textContent ?? "";
    // It happens at all, and the number matches AUTO_ADVANCE_SEC.
    expect(text).toMatch(/five seconds|5 seconds/i);
    // Where it lands: the next step's SETUP screen, with nothing timing yet.
    expect(text).toMatch(/start screen/i);
    expect(text).toMatch(/does not start|nothing starts|without starting/i);
    // Both escapes, by the labels on screen and by the key.
    expect(text).toMatch(/Escape/);
    expect(text).toMatch(/Stay here/i);
    expect(text).toMatch(/Go now/i);
  });

  // #142 — hyper focus mode is the one part of the auto-advance that is a
  // CHOICE, and a reader who has just been moved on by itself needs to know
  // which parts they opted into. Both halves are pinned: off by default, and
  // single-task to-dos only.
  it("documents hyper focus mode as off by default and single-task only (#142)", async () => {
    render(await HelpPage({ searchParams: Promise.resolve({}) }));
    const section = screen
      .getByRole("heading", { name: /The focus session/i, level: 2 })
      .closest("section");
    const text = section!.textContent ?? "";
    expect(text).toMatch(/hyper focus/i);
    expect(text).toMatch(/off by default/i);
    // It governs single-task chaining ONLY — see src/lib/hyper-focus.ts.
    expect(text).toMatch(/single-task/i);
  });

  // #61 — this used to read "nothing is streamed from anywhere else", which
  // stopped being true when a catalog store became configurable. It is a
  // user-facing PRIVACY claim, so both halves have to survive the correction:
  // an operator can serve more tracks, and the browser still never contacts
  // that store (the CSP keeps `default-src 'self'` with `media-src` unset —
  // src/lib/security-headers.test.ts fails on any relaxation).
  it("states the focus-music privacy posture accurately once a catalog is configured (#61)", async () => {
    render(await HelpPage({ searchParams: Promise.resolve({}) }));
    const section = screen
      .getByRole("heading", { name: /The focus session/i, level: 2 })
      .closest("section");
    const text = section!.textContent ?? "";
    // The bundled set is still the floor — a session never starts silent.
    expect(text).toMatch(/ten lo-?fi tracks|ten tracks/i);
    // Half one: more tracks can come from a store whoever runs the instance runs.
    expect(text).toMatch(
      /more tracks|the rest of the catalogue|full catalogue/i,
    );
    // Half two, and the half that must never be dropped.
    expect(text).toMatch(/browser never (contacts|talks to)/i);
    // The retired claim must be gone, not merely qualified.
    expect(text).not.toMatch(/nothing is streamed from anywhere else/i);
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

  // #129 / #153 — both shipped, and both are rights a person exercises rather
  // than features they browse for (UK GDPR Art. 15/20 and Art. 17). /help is
  // where somebody looks for "how do I get my stuff out", so the page has to
  // name the two controls and where they live.
  it("tells a member they can export and delete their own data (#129, #153)", async () => {
    render(await HelpPage({ searchParams: Promise.resolve({}) }));
    const section = screen
      .getByRole("heading", { name: /Your data/i, level: 2 })
      .closest("section");
    expect(section).not.toBeNull();
    const text = section!.textContent ?? "";
    // The controls, by the labels they actually carry in Settings → Account.
    expect(text).toMatch(/Download my data/i);
    expect(text).toMatch(/Delete my account/i);
    // Export: it is one archive, and it deliberately excludes the secrets.
    expect(text).toMatch(/\.zip/i);
    expect(text).toMatch(/API key|Google connection/i);
    // Deletion: the honest shape — a recoverable window, then removal by hand.
    expect(text).toMatch(/signed out/i);
    expect(text).toMatch(/type the word|type `?delete`?|typing the word/i);
    // The section must route to the page that owns both controls, carrying the
    // origin like every other deep link on this page.
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
    // With no `?from=`, the shared back link falls back to the inbox. Asserted
    // on the NAMED control rather than on the href list (review on !216): since
    // #131 the page renders two back controls, so `toContain("/")` would be
    // satisfied twice over and would no longer say anything about this one.
    expect(document.querySelector('[data-back-link="page"]')).toHaveAttribute(
      "href",
      "/",
    );
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
