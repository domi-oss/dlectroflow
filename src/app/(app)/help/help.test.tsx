// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { HELP_SECTIONS } from "@/lib/section-nav";
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
      /Where things end up/i,
      /Shopping list/i,
      /Voice & settings/i,
      /Your data/i,
      /Guests & AI limits/i,
    ]) {
      expect(
        screen.getByRole("heading", { name: heading, level: 2 }),
      ).toBeInTheDocument();
    }
  });

  // The inbox is a board you can rearrange, and this page described none of that:
  // it listed the four review choices and stopped, so "put this back in Needs
  // review" had no documented route.
  //
  // Both paths are named on purpose, and that is an accessibility point rather
  // than a completeness one. The drag is a pointer gesture; `MoveToMenu` is its
  // non-pointer equivalent, which is what carries WCAG 2.1.1 and 2.5.7 for this
  // interaction (`inbox-view.tsx:4262-4264` states exactly that). Documenting the
  // drag alone would describe the app to the subset of users who can perform it.
  // `Move to` is the control's real accessible name (`move-to-menu.tsx:140`) —
  // #253 removed the older nested "Move to…" ▾ entry, so the ellipsis form would
  // send a reader looking for something no longer on screen.
  it("documents moving items between lists, by drag AND by the Move to control", async () => {
    render(await HelpPage({ searchParams: Promise.resolve({}) }));
    const section = screen
      .getByRole("heading", { name: /The inbox & freshness/i, level: 2 })
      .closest("section");
    expect(section).not.toBeNull();
    const text = section!.textContent ?? "";
    expect(text).toMatch(/drag/i);
    expect(text).toMatch(/Move to/);
    // The non-pointer path must be presented as equivalent, not as a fallback for
    // when the drag fails — it is the same dispatcher underneath.
    expect(text).toMatch(/without dragging|keyboard|same/i);
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

  // The pacer is RING-STYLE ONLY, and this page used to describe it as
  // unconditional ("From the moment you start, the ring is also a slow breathing
  // pacer … there is nothing to switch on"). It is not: `timer-visual.tsx` reaches
  // the breathing markup only in its `ring` branch — `digits`, `bar` and `mug`
  // each return before it — so three of the four timer styles never breathe.
  //
  // `resolveTimerStyle(null, voice)` is what makes that reachable rather than
  // theoretical: an account that has never opened Timer style resolves to `mug`
  // on the playful voice and only `ring` on plain, so for a whole voice the
  // documented default behaviour was the one thing that could not happen. And a
  // plain-voice reader who simply picks Bar is told their session breathes for its
  // whole length with nothing to switch on.
  it("names the Ring timer style as the breathing pacer's precondition", async () => {
    render(await HelpPage({ searchParams: Promise.resolve({}) }));
    const section = screen
      .getByRole("heading", { name: /The focus session/i, level: 2 })
      .closest("section");
    const text = section!.textContent ?? "";
    // The style is named, and named as the thing that turns the pacer on.
    expect(text).toMatch(/Ring/);
    expect(text).toMatch(/Timer style/i);
    // And the reader is told the other styles do not have it, because "the ring
    // breathes" alone reads as a description of every session.
    expect(text).toMatch(
      /other (?:three )?timer styles do not breathe|only the Ring/i,
    );
    // The retired unconditional phrasing must be gone, not merely softened.
    expect(text).not.toMatch(/there is nothing to switch on/i);
  });

  // The app menu carries seven destinations; this page documented three of them
  // (Inbox, Focus, Settings) and never named Library or Activity — even though its
  // own getting-started list promises the reader they will "earn points toward
  // your streak", which is a payoff with no stated address.
  //
  // Asserted on the MENU labels (`nav.everything` → `Library`, `nav.dashboard` →
  // `Activity`), not on the route paths: `/dashboard` renders the word "Activity"
  // and a reader hunting for "Dashboard" finds nothing.
  it("names the Library and Activity destinations, by their menu labels", async () => {
    render(await HelpPage({ searchParams: Promise.resolve({}) }));
    const section = screen
      .getByRole("heading", { name: /Where things end up/i, level: 2 })
      .closest("section");
    expect(section).not.toBeNull();
    const text = section!.textContent ?? "";
    expect(text).toMatch(/Library/);
    expect(text).toMatch(/Activity/);
    // Library's four tabs are the reason the section exists: "where did my
    // finished work go" is the question, and `Done` is the tab that answers it.
    expect(text).toMatch(/Done/);
    expect(text).toMatch(/Saved for later/i);
    // Activity is where the points and the streak the loop promises actually live.
    expect(text).toMatch(/streak/i);
    expect(text).toMatch(/badge/i);
    // Duo review, !356 — the round-up's settings are SPLIT and this section used to
    // claim they "are on that page rather than in Settings", full stop. Two
    // different things: `workdayEndTime` / `roundupEmailEnabled` live on the
    // Activity page, while `notifyRoundup` — whether it also raises a DESKTOP
    // notification — is Settings → Notifications, whose own hint says "the in-app
    // recap still shows either way". Saying Settings has nothing to do with the
    // round-up sends a reader hunting in the wrong place for the toggle they want.
    expect(text).toMatch(/desktop notification/i);
    expect(text).toMatch(/Notifications/);
    const hrefs = Array.from(section!.querySelectorAll("a")).map((a) =>
      a.getAttribute("href"),
    );
    expect(hrefs).toContain("/library");
    expect(hrefs).toContain("/dashboard");
  });

  // #199 — shopping-list mode is `Settings.shoppingList`, `@default(false)`, and
  // `/shopping` answers `notFound()` while it is off. This page had never heard of
  // it, which is the worse of the two failures the brief distinguishes: a gated
  // feature described without its switch is misleading, but one omitted entirely
  // is undiscoverable, and the switch is the only thing that reveals it.
  it("documents shopping-list mode as off until switched on (#199)", async () => {
    render(await HelpPage({ searchParams: Promise.resolve({}) }));
    const section = screen
      .getByRole("heading", { name: /Shopping list/i, level: 2 })
      .closest("section");
    expect(section).not.toBeNull();
    const text = section!.textContent ?? "";
    // The switch, by the label it actually carries in Settings.
    expect(text).toMatch(/Show the shopping list/i);
    // That it is off until you do that — the whole point of documenting it.
    expect(text).toMatch(/off (?:by default|until|to start)/i);
    // What the mode is FOR, in the terms its own intro uses: not tasks.
    expect(text).toMatch(/no estimates|not tasks|does not touch your streak/i);
    // And the reassurance the Settings hint gives, because a feature switch reads
    // as destructive: turning it off hides the list rather than deleting it.
    expect(text).toMatch(/without deleting|does not delete|hides the list/i);
    // Duo review, !356 — `Saved for later` names TWO unrelated things: a Library
    // tab holding `BrainDumpItem`s, and this list's own `ShoppingItem.savedForLater`
    // (a separate model entirely, `schema.prisma`'s `ShoppingItem`). This section
    // asserts the shopping list is "not a kind of task", so borrowing the tab's name
    // without saying they are separate implies shopping items enter the task
    // pipeline. The page has to disown that, since it cannot rename the app's label.
    expect(text).toMatch(/its own|separate|nothing to do with/i);
    expect(text).toMatch(/Library/);
    const hrefs = Array.from(section!.querySelectorAll("a")).map((a) =>
      a.getAttribute("href"),
    );
    expect(hrefs).toContain("/settings?from=help");
  });

  // "Voice & settings" named three of Settings' eleven sections. The two that
  // matter most to a reader who came to /help for help are both absent:
  //
  //  - #40's Typeface radios, which is where Atkinson Hyperlegible and
  //    OpenDyslexic live. Someone who cannot comfortably read the app is exactly
  //    who opens the help page, and it offered them nothing.
  //  - the real name of the reminders section (`Notifications`) and the fact that
  //    every toggle in it is inert without the browser's permission — a user can
  //    tick all three, be told nothing, and receive nothing.
  it("documents the typeface a11y setting and the Notifications permission gate", async () => {
    render(await HelpPage({ searchParams: Promise.resolve({}) }));
    const section = screen
      .getByRole("heading", { name: /Voice & settings/i, level: 2 })
      .closest("section");
    const text = section!.textContent ?? "";
    // The section that owns the typefaces, and the two aids by name — the names
    // are what someone who needs them is searching for.
    expect(text).toMatch(/Appearance/);
    // #85 made the theme THREE-state (`system` / `light` / `dark`) defaulting to
    // `system`, so "light and dark mode" is no longer the whole setting and no
    // longer describes what a first visit does. Named by its real label, and the
    // default is stated, because "follows your device" is the behaviour a reader
    // meets before they ever open Settings.
    expect(text).toMatch(/Follow my system/);
    expect(text).toMatch(/by default|to start with|already/i);
    expect(text).toMatch(/Atkinson Hyperlegible/);
    expect(text).toMatch(/OpenDyslexic/);
    // Reminders: the section's real heading, not the word "reminders" alone.
    expect(text).toMatch(/Notifications/);
    // …and the precondition, which is the reachable failure here.
    expect(text).toMatch(/permission/i);
  });

  // Two integrations exist and neither was mentioned: per-user Google Tasks
  // scheduling, and a calendar-subscription URL that is a BEARER CAPABILITY —
  // anyone holding it reads the feed without signing in. The page documents
  // export and deletion as data rights; a link that hands out step titles and
  // times to whoever has the URL belongs in the same breath.
  it("documents the Google and calendar-feed integrations, and the URL's risk", async () => {
    render(await HelpPage({ searchParams: Promise.resolve({}) }));
    const section = screen
      .getByRole("heading", { name: /Voice & settings/i, level: 2 })
      .closest("section");
    const text = section!.textContent ?? "";
    expect(text).toMatch(/Integrations/);
    expect(text).toMatch(/Google Tasks/);
    expect(text).toMatch(/calendar feed|calendar subscription/i);
    // The caveat `calendar-feed.tsx` puts on screen, carried here rather than
    // left to be met only after the URL has been copied somewhere.
    expect(text).toMatch(/without signing in|like a password/i);
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
    expect(text).toMatch(/API key|Google connection/i);
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

  // The page's title block used to be a `<header>`, which made it a SECOND
  // `banner` landmark on every visit.
  //
  // `<header>` only stops mapping to `banner` when it is a descendant of
  // `article`, `aside`, `main`, `nav` or `section`. This one sat in the page's
  // outer `<div>`, and `(app)/layout.tsx:151` wraps `{children}` in a plain
  // `<div>` rather than a `<main>` — so there was no sectioning ancestor anywhere
  // above it and it resolved to `banner`, alongside the shell's own header at
  // `layout.tsx:83`. Two banners is a duplicate-landmark failure, and it makes
  // "go to the banner" ambiguous for a screen-reader user on this page only.
  //
  // /help was the ONLY `(app)` page doing this, so it is fixed here rather than
  // swept: `legal-page.tsx` has a `<header>` too and is already correct, because
  // its own `<main>` (:110) encloses it. A `<div>` loses nothing — the `h1` is
  // what carries the page's name either way.
  //
  // The missing `<main>` in the shell is a separate, wider gap (no `(app)` route
  // has one, while `/login`, `/privacy` and `/terms` all do) and is reported
  // rather than changed here, since it is one sweep across ten routes.
  it("contributes no second banner landmark (the app shell owns the banner)", async () => {
    render(await HelpPage({ searchParams: Promise.resolve({}) }));
    expect(screen.queryAllByRole("banner")).toHaveLength(0);
    // The title itself is untouched — this is about the wrapper, not the heading.
    expect(
      screen.getByRole("heading", {
        name: /Help & getting started/i,
        level: 1,
      }),
    ).toBeInTheDocument();
  });

  // A content page's headings have to descend without gaps: h1, then h2 per
  // section, nothing below. The nine h2s come from HELP_SECTIONS via
  // <SectionHeading>, so this also pins that none of them has quietly become an
  // h3 — and that the page has exactly one h1 to be the document's name.
  it("keeps heading levels contiguous: one h1, then only h2s", async () => {
    render(await HelpPage({ searchParams: Promise.resolve({}) }));
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
    expect(screen.getAllByRole("heading", { level: 2 })).toHaveLength(
      HELP_SECTIONS.length,
    );
    for (const level of [3, 4, 5, 6]) {
      expect(screen.queryAllByRole("heading", { level })).toHaveLength(0);
    }
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
