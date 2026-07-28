// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { FocusSoundPlayer } from "@/components/focus/focus-sound-player";
import type { FocusSoundControls } from "@/lib/use-focus-sound";

afterEach(cleanup);

function controls(over: Partial<FocusSoundControls> = {}): FocusSoundControls {
  return {
    track: {
      id: "lofi_calm",
      title: "Aurora on Mute",
      category: "ambient-lofi",
      categoryLabel: "Ambient lo-fi",
      src: "/audio/lofi/aurora-on-mute.mp3",
    },
    playing: false,
    volume: 0.5,
    hasTracks: true,
    shuffle: false,
    play: vi.fn(),
    pause: vi.fn(),
    toggle: vi.fn(),
    next: vi.fn(),
    prev: vi.fn(),
    toggleShuffle: vi.fn(),
    setVolume: vi.fn(),
    stop: vi.fn(),
    getTime: () => ({ currentTime: 0, duration: 0 }),
    ...over,
  };
}

describe("FocusSoundPlayer", () => {
  it("renders the now-playing track title + category as text (not colour-only)", () => {
    render(<FocusSoundPlayer controls={controls()} voice="plain" />);
    expect(screen.getByText("Aurora on Mute")).toBeInTheDocument();
    expect(screen.getByText("Ambient lo-fi")).toBeInTheDocument();
    expect(
      screen.getByRole("region", { name: /focus sound/i }),
    ).toBeInTheDocument();
  });

  it("play/pause button reflects state and calls toggle (keyboard-usable)", async () => {
    const user = userEvent.setup();
    const c = controls({ playing: false });
    const { rerender } = render(
      <FocusSoundPlayer controls={c} voice="plain" />,
    );
    const playBtn = screen.getByRole("button", { name: /play focus sound/i });
    expect(playBtn).toHaveAttribute("aria-pressed", "false");
    await user.click(playBtn);
    expect(c.toggle).toHaveBeenCalled();

    rerender(
      <FocusSoundPlayer controls={controls({ playing: true })} voice="plain" />,
    );
    const pauseBtn = screen.getByRole("button", { name: /pause focus sound/i });
    expect(pauseBtn).toHaveAttribute("aria-pressed", "true");
  });

  it("prev / next buttons call the controls", async () => {
    const user = userEvent.setup();
    const c = controls();
    render(<FocusSoundPlayer controls={c} voice="plain" />);
    await user.click(screen.getByRole("button", { name: /previous track/i }));
    await user.click(screen.getByRole("button", { name: /next track/i }));
    expect(c.prev).toHaveBeenCalled();
    expect(c.next).toHaveBeenCalled();
  });

  it("volume is behind a labeled speaker button; the slider pops out (closed by default) and forwards changes", async () => {
    const user = userEvent.setup();
    const c = controls({ volume: 0.5 });
    render(<FocusSoundPlayer controls={c} voice="plain" />);
    const volBtn = screen.getByRole("button", { name: /^volume$/i });
    expect(volBtn).toHaveAttribute("aria-expanded", "false");
    // Duo a11y fix: "dialog", not "true" (≡ "menu") — the popover is a
    // focus-capturing slider group, so AT must not promise menu-key navigation.
    expect(volBtn).toHaveAttribute("aria-haspopup", "dialog");
    // No slider until the popover is opened.
    expect(screen.queryByRole("slider")).not.toBeInTheDocument();
    await user.click(volBtn);
    expect(volBtn).toHaveAttribute("aria-expanded", "true");
    const slider = screen.getByRole("slider", { name: /volume level/i });
    expect(slider).toHaveValue("0.5");
    fireEvent.change(slider, { target: { value: "0.2" } });
    expect(c.setVolume).toHaveBeenCalledWith(0.2);
  });

  it("Escape closes the volume popover", async () => {
    const user = userEvent.setup();
    render(<FocusSoundPlayer controls={controls()} voice="plain" />);
    await user.click(screen.getByRole("button", { name: /^volume$/i }));
    expect(screen.getByRole("slider")).toBeInTheDocument();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("slider")).not.toBeInTheDocument();
  });

  it("shows a playback progress bar reflecting currentTime / duration (display only)", () => {
    const c = controls({ getTime: () => ({ currentTime: 30, duration: 120 }) });
    render(<FocusSoundPlayer controls={c} voice="plain" />);
    const bar = screen.getByRole("progressbar", { name: /playback progress/i });
    expect(bar).toHaveAttribute("aria-valuenow", "25");
    expect(bar).toHaveAttribute("aria-valuemin", "0");
    expect(bar).toHaveAttribute("aria-valuemax", "100");
    // Progress is display-only — not a slider/seek control.
    expect(bar).not.toHaveAttribute("tabindex");
  });

  it("is width-capped + centered so it aligns with the timer button row", () => {
    render(<FocusSoundPlayer controls={controls()} voice="plain" />);
    const region = screen.getByRole("region", { name: /focus sound/i });
    expect(region.className).toMatch(/max-w-md/);
    expect(region.className).toMatch(/mx-auto/);
  });

  // #68 — shuffle is a toggle button, so it reports its state with aria-pressed
  // (not a swapped label/icon like play↔pause) and repeats that state as text,
  // never colour alone.
  it("shuffle is an aria-pressed toggle with a decorative glyph and a text label", async () => {
    const user = userEvent.setup();
    const c = controls({ shuffle: false });
    render(<FocusSoundPlayer controls={c} voice="plain" />);
    const btn = screen.getByRole("button", { name: /shuffle tracks/i });
    expect(btn).toHaveAttribute("aria-pressed", "false");
    expect(btn.querySelector("svg")).toHaveAttribute("aria-hidden", "true");
    await user.click(btn);
    expect(c.toggleShuffle).toHaveBeenCalled();
  });

  it("shuffle-on is announced by aria-pressed AND shown as text (not colour-only)", () => {
    render(
      <FocusSoundPlayer controls={controls({ shuffle: true })} voice="plain" />,
    );
    expect(
      screen.getByRole("button", { name: /shuffle tracks/i }),
    ).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByText(/now playing · shuffled/i)).toBeInTheDocument();
  });

  it("does not claim shuffle in the now-playing line when it is off", () => {
    render(<FocusSoundPlayer controls={controls()} voice="plain" />);
    expect(screen.getByText("Now playing")).toBeInTheDocument();
    expect(screen.queryByText(/shuffled/i)).not.toBeInTheDocument();
  });

  // #65 — when the workspace opted into the pause coupling, the timer hands the
  // player a session-level toggle. The button then pauses BOTH, so its
  // accessible name must say so: "Pause focus sound" would under-promise what
  // pressing it costs.
  describe("#65 — coupled transport (onPauseTogether)", () => {
    it("routes the transport press to the session instead of the audio, and relabels it", async () => {
      const user = userEvent.setup();
      const c = controls({ playing: true });
      const onPauseTogether = vi.fn();
      render(
        <FocusSoundPlayer
          controls={c}
          voice="plain"
          onPauseTogether={onPauseTogether}
        />,
      );
      const btn = screen.getByRole("button", {
        name: /^pause music and timer$/i,
      });
      expect(btn).toHaveAttribute("aria-pressed", "true");
      expect(
        screen.queryByRole("button", { name: /pause focus sound/i }),
      ).not.toBeInTheDocument();
      await user.click(btn);
      expect(onPauseTogether).toHaveBeenCalledTimes(1);
      expect(c.toggle).not.toHaveBeenCalled();
    });

    it("offers to resume both when playback is stopped", () => {
      render(
        <FocusSoundPlayer
          controls={controls({ playing: false })}
          voice="plain"
          onPauseTogether={vi.fn()}
        />,
      );
      const btn = screen.getByRole("button", {
        name: /^resume music and timer$/i,
      });
      expect(btn).toHaveAttribute("aria-pressed", "false");
    });

    it("disables itself while the session round-trip is in flight (no double-fire)", async () => {
      const user = userEvent.setup();
      const onPauseTogether = vi.fn();
      render(
        <FocusSoundPlayer
          controls={controls({ playing: true })}
          voice="plain"
          onPauseTogether={onPauseTogether}
          pauseTogetherPending
        />,
      );
      const btn = screen.getByRole("button", {
        name: /^pause music and timer$/i,
      });
      expect(btn).toBeDisabled();
      await user.click(btn);
      expect(onPauseTogether).not.toHaveBeenCalled();
    });

    it("couples ONLY the transport — skip, shuffle and volume still touch the audio alone", async () => {
      const user = userEvent.setup();
      const c = controls();
      const onPauseTogether = vi.fn();
      render(
        <FocusSoundPlayer
          controls={c}
          voice="plain"
          onPauseTogether={onPauseTogether}
        />,
      );
      await user.click(screen.getByRole("button", { name: /next track/i }));
      await user.click(screen.getByRole("button", { name: /previous track/i }));
      await user.click(screen.getByRole("button", { name: /shuffle tracks/i }));
      await user.click(screen.getByRole("button", { name: /^volume$/i }));
      fireEvent.change(screen.getByRole("slider"), { target: { value: "0" } });
      expect(c.next).toHaveBeenCalled();
      expect(c.prev).toHaveBeenCalled();
      expect(c.toggleShuffle).toHaveBeenCalled();
      expect(c.setVolume).toHaveBeenCalledWith(0);
      expect(onPauseTogether).not.toHaveBeenCalled();
    });

    it("keeps the audio-only labels + behaviour when the prop is absent (default)", async () => {
      const user = userEvent.setup();
      const c = controls({ playing: true });
      render(<FocusSoundPlayer controls={c} voice="plain" />);
      const btn = screen.getByRole("button", { name: /^pause focus sound$/i });
      expect(btn).toBeEnabled();
      await user.click(btn);
      expect(c.toggle).toHaveBeenCalled();
    });
  });

  it("every control button meets the ≥44px touch target", () => {
    render(<FocusSoundPlayer controls={controls()} voice="plain" />);
    for (const name of [
      /previous track/i,
      /play focus sound/i,
      /next track/i,
      /shuffle tracks/i,
      /^volume$/i,
    ]) {
      const btn = screen.getByRole("button", { name });
      expect(btn.className).toMatch(/min-h-\[44px\]/);
      expect(btn.className).toMatch(/min-w-\[44px\]/);
    }
  });

  it("renders nothing when there is no track / no library", () => {
    const { container } = render(
      <FocusSoundPlayer
        controls={controls({ hasTracks: false, track: null })}
        voice="plain"
      />,
    );
    expect(container).toBeEmptyDOMElement();
  });
});
