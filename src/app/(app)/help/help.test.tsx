// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { sectionById, sectionLabel } from "@/lib/section-nav";
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
    expect(section).not.toBeNull();
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
    expect(section).not.toBeNull();
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
    expect(section).not.toBeNull();
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

  // #180 — Settings kept the switch and gave everything else to the player, and
  // new accounts start with sound ON. A help page that still sends someone to
  // Settings to pick a track sends them somewhere the control is not, which is
  // worse than saying nothing.
  it("documents the single Settings switch, sound-on by default, and the player (#180)", async () => {
    render(await HelpPage({ searchParams: Promise.resolve({}) }));
    const section = screen
      .getByRole("heading", { name: /The focus session/i, level: 2 })
      .closest("section");
    expect(section).not.toBeNull();
    const text = section!.textContent ?? "";
    // Sound is on unless you say otherwise — the surprise this must pre-empt.
    expect(text).toMatch(/on (?:to start with|by default)|starts on/i);
    // Where the switch is, and where everything else is.
    expect(text).toMatch(/switch/i);
    expect(text).toMatch(/from the player|in the player/i);
    // The retired instruction must be gone, not merely softened: there is no
    // track picker and no preview toggle on the Settings page any more.
    expect(text).not.toMatch(/preview toggle/i);
    expect(text).not.toMatch(/choose a track under/i);
  });

  it("routes from the focus section to the Settings page that owns the switch", async () => {
    render(await HelpPage({ searchParams: Promise.resolve({}) }));
    const section = screen
      .getByRole("heading", { name: /The focus session/i, level: 2 })
      .closest("section");
    expect(section).not.toBeNull();
    // The switch lives in Settings, so this section must link there rather than
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

    // ── The third surface of the export disclosure ──────────────────────────
    //
    // `docs/legal.md` says /privacy, the archive's own README and THIS PAGE are
    // one disclosure read in three places and that the three wordings move
    // together. Two of the three had assertions per withheld item; this one had
    // `/API key|Google connection/` — an ALTERNATION, which passes if either is
    // dropped and passed unchanged while the list went from two items to three.
    //
    // That is not a missing guard, it is a guard whose assertion could not see
    // the thing that changed, which is worse: the section looked covered. So the
    // alternation is split into one assertion per key, on the same
    // per-item axis `readme.test.ts` and `privacy/page.test.tsx` use.
    expect(text).toMatch(/Google connection/i); // GoogleAuth tokens
    expect(text).toMatch(/API key/i); // User.llmKeyEnc
    expect(text).toMatch(/calendar feed/i); // CalendarFeed.token
    expect(
      text,
      "the Help page must say the keys are the WHOLE exclusion",
    ).toMatch(/three things are left out/i);

    // The path to the feed URL, derived from the table the Settings nav actually
    // renders rather than repeated as a literal. This is the assertion that would
    // have caught the wrong path this MR shipped in its first draft — all three
    // surfaces said "Settings → Calendar", which is not a section that exists.
    const integrations = sectionLabel(
      sectionById("settings-integrations"),
      "plain",
    );
    expect(text).toContain(
      `Settings → ${integrations} → Calendar subscription`,
    );

    // And the records that ARE included, so "left out" cannot quietly widen back.
    expect(text).toMatch(/private note/i);
    expect(
      text,
      "the Help page still says TWO things are left out",
    ).not.toMatch(/two things are deliberately left out/i);
    // Deletion: the honest shape — a recoverable window, then removal by hand.
    expect(text).toMatch(/signed out/i);
    expect(text).toMatch(/type the word|type `?delete`?|typing the word/i);
    // `(app)/settings/page.tsx` filters the Account section out for a caller
    // with no account of their own, so the page must not send a guest hunting
    // for a control that is never rendered for them.
    expect(text).toMatch(/an account of your own/i);
    expect(text).toMatch(/guest/i);
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
    // on the NAMED control rather than on the href list (review on !216), which
    // `toContain("/")` could satisfy from any other link on the page.
    expect(document.querySelector('[data-back-link="bar"]')).toHaveAttribute(
      "href",
      "/",
    );
  });

  it("renders exactly one back control", async () => {
    render(await HelpPage({ searchParams: Promise.resolve({}) }));
    // The page-level copy above the <h1> is gone: the bar is `sticky top-0`, so
    // its control was already on screen alongside it rather than only below the
    // fold, and the two offered the same destination twice.
    expect(
      Array.from(document.querySelectorAll("[data-back-link]")).map((el) =>
        el.getAttribute("data-back-link"),
      ),
    ).toEqual(["bar"]);
  });

  it("is origin-aware: ?from=settings sends the '← Back' link to Settings", async () => {
    render(
      await HelpPage({ searchParams: Promise.resolve({ from: "settings" }) }),
    );
    // Label is a simple "← Back"; only the destination reflects the origin.
    const back = document.querySelector('[data-back-link="bar"]')!;
    expect(back).toHaveTextContent("← Back");
    expect(back).toHaveAttribute("href", "/settings");
  });

  // #131 — the exit lives in the sticky "Jump to…" bar, which is the only part
  // of the page's chrome still on screen once the header has scrolled away. What
  // this page owes it is the origin, or the exit quietly sends the reader
  // somewhere the link they arrived by would not have.
  it("hands the origin to the sticky bar's back control (#131)", async () => {
    render(
      await HelpPage({ searchParams: Promise.resolve({ from: "settings" }) }),
    );
    const nav = screen.getByRole("navigation", { name: "Help sections" });
    const sticky = nav.querySelector('[data-back-link="bar"]')!;
    expect(sticky).not.toBeNull();
    expect(sticky).toHaveAttribute("href", "/settings");
    expect(sticky).toHaveTextContent("← Back");
    // Exactly one. A second would mean the page-level copy crept back in — it
    // never added reach, because the bar is sticky and is on screen at the top
    // as well, so the pair only ever appeared together.
    expect(document.querySelectorAll("[data-back-link]")).toHaveLength(1);
  });

  it("defaults the sticky back control to the inbox with no origin (#131)", async () => {
    render(await HelpPage({ searchParams: Promise.resolve({}) }));
    const nav = screen.getByRole("navigation", { name: "Help sections" });
    expect(nav.querySelector('[data-back-link="bar"]')).toHaveAttribute(
      "href",
      "/",
    );
  });

  // #182 — the page the "words too close together" report was about.
  //
  // Two different things can produce that symptom and only one of them was
  // here. Pinning the RENDERED text is what tells them apart: JSX drops a
  // newline adjacent to a tag, so `press\n<kbd>/</kbd>` would render `press/`
  // with no space, and Prettier writes that shape by itself whenever a line
  // grows past 80 columns. These three assertions read the text the browser
  // actually paints, so a reflow cannot quietly weld a key to its sentence.
  //
  // The keys were also completely unstyled, which is what was really wrong. That
  // half is a base rule in globals.css, guarded by `inline-code-style.test.ts` —
  // jsdom applies no stylesheet, so it cannot be asserted from here.
  it("renders each keyboard key spaced from the words either side (#182)", async () => {
    render(await HelpPage({ searchParams: Promise.resolve({}) }));

    const keys = [...document.querySelectorAll("kbd")];
    expect(keys.map((key) => key.textContent)).toEqual([
      "/",
      "Escape",
      "delete",
    ]);

    for (const key of keys) {
      // `textContent` on the paragraph is the rendered string, with JSX's
      // whitespace rule already applied — exactly what a reader sees.
      //
      // The ancestor is asserted rather than assumed. A `<kbd>` moving out of
      // its sentence — into a `<blockquote>`, or straight into a `<section>` —
      // is a realistic edit to this page, and `closest()` returning null then
      // threw `TypeError: Cannot read properties of null`, which names neither
      // the key nor the cause. Duo review, !272.
      const sentence = key.closest("li, p");
      expect(
        sentence,
        `<kbd>${key.textContent}</kbd> is not inside a <li> or <p>, so the sentence around it cannot be read`,
      ).not.toBeNull();
      // A space on *each* side, which is the whole assertion — and it is only
      // the right assertion while every key sits mid-sentence, as all three do
      // and as the exact-set check above holds them to. A key that legitimately
      // opened or closed its sentence would have no space on one side and this
      // is the line that would have to change, so the message says so rather
      // than leaving `expected '…' to contain ' N '` to be decoded.
      expect(
        sentence?.textContent,
        `<kbd>${key.textContent}</kbd> has no space on one side of it; if the key now opens or closes its sentence, this assertion is what needs changing, not the page`,
      ).toContain(` ${key.textContent} `);
    }

    // And the specific phrasings, so a copy edit that reflows them has to
    // re-read them rather than silently losing a space.
    const text = document.body.textContent!;
    expect(text).toContain("press Enter (or / to jump to the capture bar)");
    expect(text).toContain("finished step; Escape stops it too");
    expect(text).toContain("type the word delete into");
  });
});
