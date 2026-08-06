// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { FocusTimerSection } from "@/components/settings/focus-timer-section";

const refresh = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh }),
}));
vi.mock("@/app/actions/settings", () => ({
  updateFocusTimerSettings: vi.fn().mockResolvedValue(undefined),
}));
import { updateFocusTimerSettings } from "@/app/actions/settings";

afterEach(cleanup);
beforeEach(() => vi.clearAllMocks());

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
    // #180 — the timer style is now the ONLY radio group in this section: the
    // sound picker's went to the player, so this can assert over every radio on
    // screen rather than filtering by name.
    expect(screen.getAllByRole("radio")).toHaveLength(4);
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

  // #180 — Settings holds one switch for focus sounds and nothing else. The ten
  // track radios, the category radios and the preview buttons all moved to the
  // in-session player (#181), because "what do I want to hear" is a decision you
  // make while listening.
  it("offers ONE focus-sound control, a switch, and no track or category options", () => {
    render(<FocusTimerSection {...base} />);
    expect(screen.getByLabelText(/focus sounds/i)).toBeInTheDocument();
    // The removals, asserted rather than assumed: a radio group that quietly
    // survived here would be the second surface #180 exists to delete.
    expect(screen.queryByRole("radio", { name: /aurora on mute/i })).toBeNull();
    expect(screen.queryByRole("radio", { name: /^off$/i })).toBeNull();
    expect(screen.queryByText(/whole category/i)).toBeNull();
    expect(screen.queryByRole("button", { name: /preview/i })).toBeNull();
  });

  it("says where the playlist and track controls went", () => {
    render(<FocusTimerSection {...base} />);
    expect(screen.getByText(/from the player/i)).toBeInTheDocument();
  });

  it("reads its state from the stored switch, both ways", () => {
    render(<FocusTimerSection {...base} />);
    expect(screen.getByLabelText(/focus sounds/i)).not.toBeChecked();
    cleanup();
    render(<FocusTimerSection {...base} sound="on" />);
    expect(screen.getByLabelText(/focus sounds/i)).toBeChecked();
  });

  it("turning sound on auto-saves 'on'", async () => {
    const user = userEvent.setup();
    render(<FocusTimerSection {...base} />);
    await user.click(screen.getByLabelText(/focus sounds/i));
    await waitFor(() =>
      expect(updateFocusTimerSettings).toHaveBeenCalledWith(
        expect.objectContaining({ sound: "on" }),
      ),
    );
  });

  it("turning sound off auto-saves 'off'", async () => {
    const user = userEvent.setup();
    render(<FocusTimerSection {...base} sound="on" />);
    await user.click(screen.getByLabelText(/focus sounds/i));
    await waitFor(() =>
      expect(updateFocusTimerSettings).toHaveBeenCalledWith(
        expect.objectContaining({ sound: "off" }),
      ),
    );
  });

  // The reason `categories` is optional on the action rather than required: this
  // page has no idea what the stored selection is, so it must not send one. An
  // omitted key leaves the column alone; a `null` or `[]` here would wipe
  // somebody's playlist every time they flicked the switch.
  it("never sends a category selection — it has none to send", async () => {
    const user = userEvent.setup();
    render(<FocusTimerSection {...base} />);
    await user.click(screen.getByLabelText(/focus sounds/i));
    await waitFor(() => expect(updateFocusTimerSettings).toHaveBeenCalled());
    const [payload] = vi.mocked(updateFocusTimerSettings).mock.calls[0];
    expect(payload).not.toHaveProperty("categories");
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
