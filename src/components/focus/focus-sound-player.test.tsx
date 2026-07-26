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
    play: vi.fn(),
    pause: vi.fn(),
    toggle: vi.fn(),
    next: vi.fn(),
    prev: vi.fn(),
    setVolume: vi.fn(),
    stop: vi.fn(),
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
    const { rerender } = render(<FocusSoundPlayer controls={c} voice="plain" />);
    const playBtn = screen.getByRole("button", { name: /play focus sound/i });
    expect(playBtn).toHaveAttribute("aria-pressed", "false");
    await user.click(playBtn);
    expect(c.toggle).toHaveBeenCalled();

    rerender(<FocusSoundPlayer controls={controls({ playing: true })} voice="plain" />);
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

  it("volume slider is labeled and forwards changes", () => {
    const c = controls({ volume: 0.5 });
    render(<FocusSoundPlayer controls={c} voice="plain" />);
    const slider = screen.getByRole("slider", { name: /volume/i });
    expect(slider).toHaveValue("0.5");
    // React tracks range changes via the change event.
    fireEvent.change(slider, { target: { value: "0.2" } });
    expect(c.setVolume).toHaveBeenCalledWith(0.2);
  });

  it("every control button meets the ≥44px touch target", () => {
    render(<FocusSoundPlayer controls={controls()} voice="plain" />);
    for (const name of [/previous track/i, /play focus sound/i, /next track/i]) {
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
