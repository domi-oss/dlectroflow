// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { FocusTimerSection } from "@/components/settings/focus-timer-section";
import { FOCUS_SOUND_TRACKS } from "@/lib/focus-sounds";

const refresh = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh }),
}));
vi.mock("@/app/actions/settings", () => ({
  updateFocusTimerSettings: vi.fn().mockResolvedValue(undefined),
}));
// #70 — the picker offers a category only once the merged list actually holds
// more than one track in it, so `useFocusCatalog` is the seam these specs drive.
// Default: the bundled ten, i.e. an instance with no reachable catalog, which is
// what every pre-#70 assertion in this file measures.
const useFocusCatalogMock = vi.fn();
vi.mock("@/lib/use-focus-catalog", () => ({
  useFocusCatalog: () => useFocusCatalogMock(),
}));
import { updateFocusTimerSettings } from "@/app/actions/settings";

// Fake <audio> so preview clicks don't hit jsdom's unimplemented media API.
const audioPlay = vi.fn().mockResolvedValue(undefined);
const audioPause = vi.fn();
class FakeAudio {
  src: string;
  loop = false;
  currentTime = 0;
  volume = 1;
  onended: (() => void) | null = null;
  play = audioPlay;
  pause = audioPause;
  constructor(src: string) {
    this.src = src;
  }
}

afterEach(cleanup);
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("Audio", FakeAudio as unknown as typeof Audio);
  useFocusCatalogMock.mockReturnValue(FOCUS_SOUND_TRACKS);
});

// #101 — every settings section is a disclosure now. Focus timer is the ONE the
// page opens on arrival (owner's call: most-tuned surface in the app), so these
// specs render it the way /settings does. The mechanism itself is tested in
// src/components/nav/collapsible-section.test.tsx.
const base = {
  defaultExpanded: true,
  timerStyle: null as string | null,
  minimalMode: false,
  keepAwake: true,
  alarmEnabled: true,
  sound: "off",
  category: null as string | null,
  pauseTogether: false,
  voice: "plain" as const,
};

describe("FocusTimerSection", () => {
  it("offers exactly the 4 explicit styles — no 'match voice' / 'auto' option", () => {
    render(<FocusTimerSection {...base} />);
    expect(screen.getByRole("radio", { name: /^ring$/i })).toBeInTheDocument();
    expect(
      screen.getByRole("radio", { name: /^digits$/i }),
    ).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: /^bar$/i })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: /^mug$/i })).toBeInTheDocument();
    // Exactly 4 *style* radios (the sound picker adds its own radio group).
    const styleRadios = screen
      .getAllByRole("radio")
      .filter((r) => r.getAttribute("name") === "focusTimerStyle");
    expect(styleRadios).toHaveLength(4);
    expect(screen.queryByRole("radio", { name: /match voice/i })).toBeNull();
    expect(screen.queryByRole("radio", { name: /auto/i })).toBeNull();
  });

  it("seeds the other controls from props (keep-awake on, minimal off)", () => {
    render(<FocusTimerSection {...base} />);
    expect(screen.getByLabelText(/keep screen awake/i)).toBeChecked();
    expect(screen.getByLabelText(/minimal/i)).not.toBeChecked();
  });

  it("preselects the voice default when the stored style is null (plain → ring)", () => {
    render(<FocusTimerSection {...base} />);
    expect(screen.getByRole("radio", { name: /^ring$/i })).toBeChecked();
    expect(screen.getByRole("radio", { name: /^mug$/i })).not.toBeChecked();
  });

  it("preselects the voice default when the stored style is null (playful → mug)", () => {
    render(<FocusTimerSection {...base} voice="playful" />);
    expect(screen.getByRole("radio", { name: /mug/i })).toBeChecked();
    expect(screen.getByRole("radio", { name: /^ring$/i })).not.toBeChecked();
  });

  it("preselects the stored style verbatim when one is set", () => {
    render(<FocusTimerSection {...base} timerStyle="digits" />);
    expect(screen.getByRole("radio", { name: /^digits$/i })).toBeChecked();
  });

  it("renders a decorative (aria-hidden) preview beside each of the 4 style options", () => {
    render(<FocusTimerSection {...base} />);
    for (const style of ["ring", "digits", "bar", "mug"] as const) {
      const preview = screen.getByTestId(`timer-style-preview-${style}`);
      expect(preview).toBeInTheDocument();
      expect(preview).toHaveAttribute("aria-hidden", "true");
    }
  });

  it("choosing the Mug style auto-saves the full pref set (explicit value)", async () => {
    const user = userEvent.setup();
    render(<FocusTimerSection {...base} />);
    await user.click(screen.getByRole("radio", { name: /^mug$/i }));
    await waitFor(() =>
      expect(updateFocusTimerSettings).toHaveBeenCalledWith({
        timerStyle: "mug",
        minimalMode: false,
        keepAwake: true,
        alarmEnabled: true,
        sound: "off",
        category: null,
        pauseTogether: false,
      }),
    );
  });

  it("toggling keep-awake off auto-saves", async () => {
    const user = userEvent.setup();
    render(<FocusTimerSection {...base} />);
    await user.click(screen.getByLabelText(/keep screen awake/i));
    await waitFor(() =>
      expect(updateFocusTimerSettings).toHaveBeenCalledWith(
        expect.objectContaining({ keepAwake: false }),
      ),
    );
  });

  it("lists Off + one radio per curated lo-fi track", () => {
    render(<FocusTimerSection {...base} />);
    const soundRadios = screen
      .getAllByRole("radio")
      .filter((r) => r.getAttribute("name") === "focusSound");
    // Off + FOCUS_SOUND_TRACKS.length (10).
    expect(soundRadios).toHaveLength(FOCUS_SOUND_TRACKS.length + 1);
    expect(screen.getByRole("radio", { name: /^off$/i })).toBeInTheDocument();
    expect(
      screen.getByRole("radio", { name: /aurora on mute/i }),
    ).toBeInTheDocument();
  });

  it("choosing a lo-fi track auto-saves that track's id", async () => {
    const user = userEvent.setup();
    render(<FocusTimerSection {...base} />);
    await user.click(screen.getByRole("radio", { name: /aurora on mute/i }));
    await waitFor(() =>
      expect(updateFocusTimerSettings).toHaveBeenCalledWith(
        expect.objectContaining({ sound: "lofi_calm" }),
      ),
    );
  });

  // #65 — the music↔timer pause coupling is opt-in, and its label has to spell
  // out the consequence (the timer stops), because someone reaching for the
  // player's pause button usually only means "quiet, please".
  it("offers the pause-together toggle, OFF by default, with a hint naming the consequence", () => {
    render(<FocusTimerSection {...base} />);
    const toggle = screen.getByLabelText(/pause music and timer together/i);
    expect(toggle).not.toBeChecked();
    expect(screen.getByText(/also pauses the timer/i)).toBeInTheDocument();
  });

  it("seeds the pause-together toggle from the stored preference", () => {
    render(<FocusTimerSection {...base} pauseTogether />);
    expect(
      screen.getByLabelText(/pause music and timer together/i),
    ).toBeChecked();
  });

  it("toggling pause-together auto-saves it with the rest of the pref set", async () => {
    const user = userEvent.setup();
    render(<FocusTimerSection {...base} />);
    await user.click(screen.getByLabelText(/pause music and timer together/i));
    await waitFor(() =>
      expect(updateFocusTimerSettings).toHaveBeenCalledWith(
        expect.objectContaining({ pauseTogether: true, sound: "off" }),
      ),
    );
  });

  it("preview button toggles aria-pressed and drives the preview player", async () => {
    const user = userEvent.setup();
    render(<FocusTimerSection {...base} />);
    const btn = screen.getByRole("button", {
      name: /^preview — aurora on mute/i,
    });
    expect(btn).toHaveAttribute("aria-pressed", "false");
    await user.click(btn);
    expect(audioPlay).toHaveBeenCalled();
    expect(
      screen.getByRole("button", { name: /^stop preview — aurora on mute/i }),
    ).toHaveAttribute("aria-pressed", "true");
    // Clicking again stops the preview.
    await user.click(
      screen.getByRole("button", { name: /^stop preview — aurora on mute/i }),
    );
    expect(audioPause).toHaveBeenCalled();
  });

  it("previewing a second track stops the first (one at a time)", async () => {
    const user = userEvent.setup();
    render(<FocusTimerSection {...base} />);
    await user.click(
      screen.getByRole("button", { name: /^preview — aurora on mute/i }),
    );
    await user.click(
      screen.getByRole("button", { name: /^preview — 3 am echoes/i }),
    );
    // Only the second is pressed.
    expect(
      screen.getByRole("button", { name: /^stop preview — 3 am echoes/i }),
    ).toHaveAttribute("aria-pressed", "true");
    expect(
      screen.getByRole("button", { name: /^preview — aurora on mute/i }),
    ).toHaveAttribute("aria-pressed", "false");
  });
});

/**
 * #70 — the category picker.
 *
 * The decision these specs encode, because it is the one thing about this feature
 * that is not obvious from the code: **an instance with no reachable catalog is
 * offered no categories at all** — not ten disabled ones, and not ten that each
 * play a single track.
 *
 * That is what #70 was blocked on. #43 bundles ten tracks, one per category, so a
 * category picker on a default install would be a second way of saying "this
 * track", dressed up as a playlist. Ten `aria-disabled` radios would be worse
 * again: a screen-reader user would traverse ten options that do nothing, for a
 * capability the settings page cannot grant. So the group is absent until the data
 * makes it real, which also means the markup on a default install is exactly what
 * it was before this feature existed.
 */
describe("FocusTimerSection — category playlists (#70)", () => {
  const streamed = (name: string, category: string, label: string) => ({
    id: `catalog:${name}.mp3`,
    title: name,
    category,
    categoryLabel: label,
    src: `/api/focus-catalog/audio?track=${name}.mp3`,
  });
  const GROWN = [
    ...FOCUS_SOUND_TRACKS,
    streamed("paper-cranes", "chillhop", "Chillhop"),
    streamed("second-wind", "chillhop", "Chillhop"),
    streamed("terrace-dust", "jazzhop", "Jazz hop"),
  ];

  const categoryRadios = () =>
    screen
      .getAllByRole("radio")
      .filter(
        (r) =>
          r.getAttribute("name") === "focusSound" &&
          (
            r.getAttribute("aria-label") ??
            r.closest("label")?.textContent ??
            ""
          )
            .toLowerCase()
            .includes("whole category"),
      );

  it("offers no category at all when every category holds one track", () => {
    // The default install, and the whole no-catalog decision in one assertion.
    render(<FocusTimerSection {...base} />);
    expect(categoryRadios()).toHaveLength(0);
    // Not hidden-but-present, and not disabled either: absent.
    expect(screen.queryByText(/whole category/i)).toBeNull();
    const soundRadios = screen
      .getAllByRole("radio")
      .filter((r) => r.getAttribute("name") === "focusSound");
    expect(soundRadios).toHaveLength(FOCUS_SOUND_TRACKS.length + 1);
  });

  it("offers a category once the catalog gives it more than one track", () => {
    useFocusCatalogMock.mockReturnValue(GROWN);
    render(<FocusTimerSection {...base} />);
    expect(categoryRadios()).toHaveLength(2);
    expect(
      screen.getByRole("radio", { name: /chillhop — whole category/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("radio", { name: /jazz hop — whole category/i }),
    ).toBeInTheDocument();
    // Only the two that reached the floor — the other eight still hold one track.
    expect(
      screen.queryByRole("radio", { name: /late night — whole category/i }),
    ).toBeNull();
  });

  it("names how many tracks a category holds, in the accessible name", () => {
    // A radio called "Chillhop" next to a track called "Porchlight Golden Hour ·
    // Chillhop" is ambiguous read aloud, so the count and the word "category" are
    // part of the label rather than decoration around it.
    useFocusCatalogMock.mockReturnValue(GROWN);
    render(<FocusTimerSection {...base} />);
    expect(
      screen.getByRole("radio", {
        name: /chillhop — whole category · 3 tracks/i,
      }),
    ).toBeInTheDocument();
  });

  it("does not offer a category the database could not store", () => {
    // A self-hoster's own manifest category: the tracks play, but
    // Settings_focusSoundCategory_check would reject the slug, so a radio for it
    // would silently fail to stick.
    useFocusCatalogMock.mockReturnValue([
      ...FOCUS_SOUND_TRACKS,
      streamed("wind-one", "wind-chimes", "Wind chimes"),
      streamed("wind-two", "wind-chimes", "Wind chimes"),
    ]);
    render(<FocusTimerSection {...base} />);
    expect(categoryRadios()).toHaveLength(0);
  });

  it("picking a category saves the slug and the track the session opens on", async () => {
    useFocusCatalogMock.mockReturnValue(GROWN);
    const user = userEvent.setup();
    render(<FocusTimerSection {...base} />);
    await user.click(
      screen.getByRole("radio", { name: /chillhop — whole category/i }),
    );
    await waitFor(() =>
      expect(updateFocusTimerSettings).toHaveBeenCalledWith(
        expect.objectContaining({
          sound: "lofi_chillhop",
          category: "chillhop",
        }),
      ),
    );
  });

  it("seeds the checked state from the stored category, not from the track", () => {
    useFocusCatalogMock.mockReturnValue(GROWN);
    render(
      <FocusTimerSection {...base} sound="lofi_chillhop" category="chillhop" />,
    );
    expect(
      screen.getByRole("radio", { name: /chillhop — whole category/i }),
    ).toBeChecked();
    // The individual chillhop track must NOT also read as selected — they are one
    // radio group, and two checked radios in it would be a lie about the state.
    expect(
      screen.getByRole("radio", { name: /porchlight golden hour/i }),
    ).not.toBeChecked();
  });

  it("picking an individual track clears the category", async () => {
    useFocusCatalogMock.mockReturnValue(GROWN);
    const user = userEvent.setup();
    render(
      <FocusTimerSection {...base} sound="lofi_chillhop" category="chillhop" />,
    );
    await user.click(screen.getByRole("radio", { name: /3 am echoes/i }));
    await waitFor(() =>
      expect(updateFocusTimerSettings).toHaveBeenCalledWith(
        expect.objectContaining({ sound: "lofi_late_night", category: null }),
      ),
    );
  });

  it("picking Off clears the category", async () => {
    useFocusCatalogMock.mockReturnValue(GROWN);
    const user = userEvent.setup();
    render(
      <FocusTimerSection {...base} sound="lofi_chillhop" category="chillhop" />,
    );
    await user.click(screen.getByRole("radio", { name: /^off$/i }));
    await waitFor(() =>
      expect(updateFocusTimerSettings).toHaveBeenCalledWith(
        expect.objectContaining({ sound: "off", category: null }),
      ),
    );
  });

  it("still shows a stored category that has shrunk below the offer floor", async () => {
    // The store stopped answering. The selection is still live (the player
    // honours it), so hiding the only control that could change it would leave a
    // preference nobody can see or clear.
    render(
      <FocusTimerSection {...base} sound="lofi_chillhop" category="chillhop" />,
    );
    const radio = screen.getByRole("radio", {
      name: /chillhop — whole category/i,
    });
    expect(radio).toBeChecked();
    expect(categoryRadios()).toHaveLength(1);
  });
});

describe("FocusTimerSection — the disclosure (#101)", () => {
  it("can be closed, taking its long control list out of the page", () => {
    render(<FocusTimerSection {...base} defaultExpanded={false} />);
    const trigger = document.querySelector(
      '[data-section-toggle="settings-focus-timer"]',
    )!;
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("radio", { name: /ring/i })).toBeNull();
  });
});
