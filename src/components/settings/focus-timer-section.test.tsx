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
});

const base = {
  timerStyle: null as string | null,
  minimalMode: false,
  keepAwake: true,
  alarmEnabled: true,
  sound: "off",
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
