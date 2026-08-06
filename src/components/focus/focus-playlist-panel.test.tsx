// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { FocusPlaylistPanel } from "@/components/focus/focus-playlist-panel";
import { FOCUS_SOUND_TRACKS, type FocusTrack } from "@/lib/focus-sounds";
import type { FocusSoundControls } from "@/lib/use-focus-sound";

afterEach(cleanup);

const streamed = (
  name: string,
  category: string,
  label: string,
): FocusTrack => ({
  id: `catalog:${name}.mp3`,
  title: name,
  category,
  categoryLabel: label,
  src: `/api/focus-catalog/audio?track=${name}.mp3`,
});

/** A catalogue big enough for two categories to clear the offering floor. */
const GROWN: FocusTrack[] = [
  ...FOCUS_SOUND_TRACKS,
  streamed("Paper Cranes", "chillhop", "Chillhop"),
  streamed("Second Wind", "chillhop", "Chillhop"),
  streamed("Terrace Dust", "jazzhop", "Jazz hop"),
];

function controls(over: Partial<FocusSoundControls> = {}): FocusSoundControls {
  const pool = over.pool ?? GROWN;
  return {
    track: pool[0],
    playing: false,
    volume: 0.5,
    hasTracks: true,
    catalog: GROWN,
    shuffle: false,
    play: vi.fn(),
    pause: vi.fn(),
    toggle: vi.fn(),
    next: vi.fn(),
    prev: vi.fn(),
    jumpTo: vi.fn(),
    toggleShuffle: vi.fn(),
    setVolume: vi.fn(),
    stop: vi.fn(),
    getTime: () => ({ currentTime: 0, duration: 0 }),
    ...over,
    pool,
  };
}

function panel(over: Partial<Parameters<typeof FocusPlaylistPanel>[0]> = {}) {
  const props = {
    controls: controls(),
    voice: "plain" as const,
    categories: [] as readonly string[],
    onCategoriesChange: vi.fn(),
    ...over,
  };
  return { ...render(<FocusPlaylistPanel {...props} />), props };
}

const disclosure = () =>
  screen.getByRole("button", { name: /playlists and tracks/i });

describe("FocusPlaylistPanel — the disclosure (#181)", () => {
  it("is collapsed by default and reveals nothing until pressed", () => {
    panel();
    expect(disclosure()).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("group", { name: /^playlists$/i })).toBeNull();
    expect(screen.queryByRole("heading", { name: /^tracks$/i })).toBeNull();
  });

  it("aria-controls names the element it actually reveals, and focus lands in it", async () => {
    const user = userEvent.setup();
    panel();
    const button = disclosure();
    await user.click(button);

    expect(button).toHaveAttribute("aria-expanded", "true");
    const id = button.getAttribute("aria-controls")!;
    const revealed = document.getElementById(id);
    expect(revealed).not.toBeNull();
    expect(revealed).toHaveTextContent(/tracks/i);
    // The panel is a capped-height scroller whose content is the whole point of
    // pressing, so focus is handed to it rather than left behind on the button.
    expect(revealed).toHaveFocus();
  });

  it("Escape closes it and hands focus back to the button", async () => {
    const user = userEvent.setup();
    panel();
    await user.click(disclosure());
    await user.keyboard("{Escape}");

    expect(disclosure()).toHaveAttribute("aria-expanded", "false");
    expect(disclosure()).toHaveFocus();
  });

  it("pressing it again closes it, leaving focus on the button rather than on <body>", async () => {
    const user = userEvent.setup();
    panel();
    await user.click(disclosure());
    await user.click(disclosure());

    expect(disclosure()).toHaveAttribute("aria-expanded", "false");
    expect(disclosure()).toHaveFocus();
    expect(screen.queryByRole("heading", { name: /^tracks$/i })).toBeNull();
  });

  it("caps its height and scrolls internally rather than pushing the timer around", async () => {
    const user = userEvent.setup();
    panel();
    await user.click(disclosure());
    const revealed = document.getElementById(
      disclosure().getAttribute("aria-controls")!,
    )!;
    expect(revealed.className).toMatch(/overflow-y-auto/);
    expect(revealed.className).toMatch(/max-h-/);
  });

  it("is keyboard operable as a plain button", async () => {
    const user = userEvent.setup();
    panel();
    await user.tab();
    expect(disclosure()).toHaveFocus();
    await user.keyboard("{Enter}");
    expect(disclosure()).toHaveAttribute("aria-expanded", "true");
  });
});

describe("FocusPlaylistPanel — the playlist tick-list (#181)", () => {
  async function open(over = {}) {
    const rendered = panel(over);
    await userEvent.setup().click(disclosure());
    return rendered;
  }

  it("puts the checkboxes in a group with its own name", async () => {
    await open();
    // The panel itself is also a named group ("Playlists and tracks"), so this
    // is anchored — the fieldset's own legend is the name being asserted.
    const group = screen.getByRole("group", { name: /^playlists$/i });
    expect(within(group).getAllByRole("checkbox").length).toBeGreaterThan(1);
  });

  it("puts the count inside each checkbox's accessible name, not merely beside it", async () => {
    await open();
    // "(3)" beside a label is invisible to a screen reader reading the label
    // alone, so the spelled-out count is what carries it.
    expect(
      screen.getByRole("checkbox", { name: /^Chillhop 3 tracks$/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("checkbox", { name: /^All tracks 13 tracks$/i }),
    ).toBeInTheDocument();
  });

  it("says '1 track' rather than '1 tracks' for a below-floor playlist that is selected", async () => {
    await open({
      controls: controls({ catalog: FOCUS_SOUND_TRACKS, pool: [] }),
      categories: ["chillhop"],
    });
    expect(
      screen.getByRole("checkbox", { name: /^Chillhop 1 track$/i }),
    ).toBeInTheDocument();
  });

  it("shows a below-floor playlist BECAUSE it is selected — the default install's state", async () => {
    // Every new row is created with ["ambient-lofi"] and the bundled catalogue
    // has one track per category, so without this the out-of-the-box panel would
    // show nothing ticked and no way to tell what is playing.
    await open({
      controls: controls({ catalog: FOCUS_SOUND_TRACKS, pool: [] }),
      categories: ["ambient-lofi"],
    });
    expect(
      screen.getByRole("checkbox", { name: /^Ambient lo-fi 1 track$/i }),
    ).toBeChecked();
  });

  it("omits the playlist group entirely when there is no playlist to pick", async () => {
    // The ten-track bundled instance with nothing selected: no category clears
    // the floor, so a group holding one permanently-ticked row would be noise.
    await open({
      controls: controls({
        catalog: FOCUS_SOUND_TRACKS,
        pool: FOCUS_SOUND_TRACKS,
      }),
      categories: [],
    });
    expect(screen.queryByRole("group", { name: /^playlists$/i })).toBeNull();
    expect(screen.getByRole("heading", { name: /^tracks$/i })).toBeVisible();
  });

  it("ticks 'All tracks' when nothing narrows the catalogue, and will not let it be unticked", async () => {
    const user = userEvent.setup();
    const { props } = await open({ categories: [] });
    const all = screen.getByRole("checkbox", { name: /^All tracks/i });
    expect(all).toBeChecked();
    // You leave the all-tracks state by ticking a playlist, so this row has no
    // off-switch of its own. aria-disabled rather than disabled: a disabled
    // control cannot hold focus, and dropping focus to <body> mid-list is the
    // rudeness the panel's focus handling exists to avoid.
    expect(all).toHaveAttribute("aria-disabled", "true");
    await user.click(all);
    expect(props.onCategoriesChange).not.toHaveBeenCalled();
    expect(screen.getByText(/tick a playlist/i)).toBeVisible();
  });

  it("ticking a playlist reports the new selection", async () => {
    const user = userEvent.setup();
    const { props } = await open({ categories: [] });
    await user.click(screen.getByRole("checkbox", { name: /^Chillhop/i }));
    expect(props.onCategoriesChange).toHaveBeenCalledWith(["chillhop"]);
  });

  it("unticking the last playlist reports the empty selection, i.e. all tracks", async () => {
    const user = userEvent.setup();
    const { props } = await open({ categories: ["chillhop"] });
    await user.click(screen.getByRole("checkbox", { name: /^Chillhop/i }));
    expect(props.onCategoriesChange).toHaveBeenCalledWith([]);
  });

  it("keeps a selected playlist the catalogue cannot currently see", async () => {
    // The store blipped, so its categories are missing from this render. Dropping
    // them on the next tick would permanently lose a selection because of a
    // temporary outage.
    const user = userEvent.setup();
    const partial = [GROWN[1], GROWN[10], GROWN[11], GROWN[2], GROWN[12]];
    const { props } = await open({
      controls: controls({ catalog: partial, pool: partial }),
      categories: ["late-night", "chillhop"],
    });
    await user.click(screen.getByRole("checkbox", { name: /^Jazz hop/i }));
    expect(props.onCategoriesChange).toHaveBeenCalledWith([
      "late-night",
      "chillhop",
      "jazzhop",
    ]);
  });

  it("ticking 'All tracks' from a narrowed selection clears it", async () => {
    const user = userEvent.setup();
    const { props } = await open({ categories: ["chillhop"] });
    const all = screen.getByRole("checkbox", { name: /^All tracks/i });
    expect(all).not.toBeChecked();
    expect(all).not.toHaveAttribute("aria-disabled", "true");
    await user.click(all);
    expect(props.onCategoriesChange).toHaveBeenCalledWith([]);
  });
});

describe("FocusPlaylistPanel — the jump list (#181)", () => {
  async function open(over = {}) {
    const rendered = panel(over);
    await userEvent.setup().click(disclosure());
    return rendered;
  }

  it("groups the pool under real category headings", async () => {
    await open({
      controls: controls({
        pool: [GROWN[1], GROWN[10], GROWN[11], GROWN[0]],
      }),
    });
    const headings = screen
      .getAllByRole("heading", { level: 3 })
      .map((h) => h.textContent);
    expect(headings).toEqual(["Chillhop", "Ambient lo-fi"]);

    const chillhop = screen.getByRole("list", { name: /chillhop/i });
    expect(within(chillhop).getAllByRole("listitem")).toHaveLength(3);
    expect(
      within(chillhop).getByRole("button", {
        name: /^Paper Cranes, Chillhop$/,
      }),
    ).toBeInTheDocument();
    const ambient = screen.getByRole("list", { name: /ambient lo-fi/i });
    expect(within(ambient).getAllByRole("listitem")).toHaveLength(1);
  });

  it("names each track unambiguously — title AND category, not the title alone", async () => {
    await open();
    expect(
      screen.getByRole("button", { name: /Aurora on Mute, Ambient lo-fi/i }),
    ).toBeInTheDocument();
  });

  it("clicking a title jumps to that track", async () => {
    const user = userEvent.setup();
    const c = controls();
    await open({ controls: c });
    await user.click(screen.getByRole("button", { name: /Paper Cranes/i }));
    expect(c.jumpTo).toHaveBeenCalledWith("catalog:Paper Cranes.mp3");
  });

  it("marks the playing track with aria-current AND the word Playing", async () => {
    await open({ controls: controls({ track: GROWN[1], playing: true }) });
    const current = screen.getByRole("button", {
      name: /Porchlight Golden Hour/i,
    });
    expect(current).toHaveAttribute("aria-current", "true");
    // Not colour alone (WCAG 1.4.1).
    expect(current).toHaveTextContent(/playing/i);
    // …and exactly one track is marked.
    expect(
      screen
        .getAllByRole("button")
        .filter((b) => b.hasAttribute("aria-current")).length,
    ).toBe(1);
  });

  it("still marks a track that is audible after its playlist was unticked", async () => {
    // The hook keeps such a track in `controls.track` while the pool no longer
    // holds it. The list must not claim something else is playing.
    await open({
      controls: controls({ pool: [GROWN[2]], track: GROWN[1], playing: true }),
    });
    expect(
      screen.queryByRole("button", { name: /Breezy Afternoon Terrace/i }),
    ).not.toHaveAttribute("aria-current");
  });

  it("renders a 166-track pool grouped, without a flat wall of titles", async () => {
    const big: FocusTrack[] = Array.from({ length: 166 }, (_, i) =>
      streamed(`Track ${i}`, `cat-${i % 8}`, `Category ${i % 8}`),
    );
    await open({ controls: controls({ pool: big, catalog: big }) });
    expect(screen.getAllByRole("heading", { level: 3 })).toHaveLength(8);
    expect(screen.getAllByRole("list")).toHaveLength(8);
  });
});
