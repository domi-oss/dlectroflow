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
  // #252 — the header's focus shortcut. `true` in the base fixture because the
  // column defaults true, so an existing workspace really does render with it on.
  quickAccess: true,
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
        // #252 — the FULL set, which is what this spec is for: the action leaves
        // `focusQuickAccess` alone when the key is absent, so a payload missing
        // it would make changing the timer style the one path that cannot turn
        // the header shortcut off.
        quickAccess: true,
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

/**
 * #227 — the audit half of the issue, and this section was **not** already
 * correct either.
 *
 * `set()` wrote `prefs` optimistically and `persist`'s catch reported the
 * failure without restoring it, so a refused write left five switches and a
 * radiogroup showing values the server had declined. Same defect as
 * `NotificationsSection`, same fix, same guard.
 *
 * `timerStyle` is the one worth spelling out: `null` means "never chosen", and
 * the UI shows the voice-resolved default for it. A rollback that lost the null
 * would quietly promote that default into an explicit stored choice — the write
 * this section just failed to make.
 */
describe("FocusTimerSection: when a save fails", () => {
  const minimal = () => screen.getByLabelText(/minimal \/ distraction-free/i);
  const alarm = () => screen.getByLabelText(/alarm at time's-up/i);

  it("puts the switch back where the server still has it", async () => {
    vi.mocked(updateFocusTimerSettings).mockRejectedValueOnce(
      new Error("offline"),
    );
    const user = userEvent.setup();
    render(<FocusTimerSection {...base} />);
    await user.click(minimal()); // false → true, optimistically

    expect(await screen.findByRole("alert")).toHaveTextContent(
      /couldn't save/i,
    );
    await waitFor(() => expect(minimal()).not.toBeChecked());
  });

  it("rolls back the other direction too", async () => {
    vi.mocked(updateFocusTimerSettings).mockRejectedValueOnce(
      new Error("offline"),
    );
    const user = userEvent.setup();
    render(<FocusTimerSection {...base} />);
    await user.click(alarm()); // true → false, optimistically

    await screen.findByRole("alert");
    await waitFor(() => expect(alarm()).toBeChecked());
  });

  // The stored value is null ("never chosen"), shown as the voice-resolved
  // default. Restoring it has to restore the null, not the default it renders as.
  it("does not turn a refused style pick into a stored choice", async () => {
    vi.mocked(updateFocusTimerSettings).mockRejectedValueOnce(
      new Error("offline"),
    );
    const user = userEvent.setup();
    render(<FocusTimerSection {...base} />);
    await user.click(screen.getByRole("radio", { name: /^mug$/i }));

    await screen.findByRole("alert");
    // "plain" resolves a null style to ring, so the selection returns there.
    await waitFor(() =>
      expect(screen.getByRole("radio", { name: /^ring$/i })).toBeChecked(),
    );
    expect(screen.getByRole("radio", { name: /^mug$/i })).not.toBeChecked();

    // And the next successful save must still carry the null, not "ring": the
    // user never chose a style, and a rollback that invented one for them would
    // persist a decision they did not make.
    await user.click(minimal());
    await waitFor(() =>
      expect(updateFocusTimerSettings).toHaveBeenLastCalledWith(
        expect.objectContaining({ timerStyle: null, minimalMode: true }),
      ),
    );
  });

  it("undoes only the field that failed, leaving a landed change alone", async () => {
    const user = userEvent.setup();
    render(<FocusTimerSection {...base} />);

    await user.click(minimal()); // lands
    await waitFor(() => expect(minimal()).toBeChecked());

    vi.mocked(updateFocusTimerSettings).mockRejectedValueOnce(
      new Error("offline"),
    );
    await user.click(alarm()); // refused

    await screen.findByRole("alert");
    await waitFor(() => expect(alarm()).toBeChecked());
    expect(minimal()).toBeChecked();
  });

  /**
   * #227 review — the rollback target is what the server last **confirmed**,
   * not the prop this section was first rendered with.
   *
   * Minimal mode starts off. Turning it on lands, so the database holds `true`.
   * Turning it off again is then refused, and the switch has to go back on.
   * Restoring the initial prop would leave it off — indistinguishable from no
   * rollback at all, next to a message saying the change did not save.
   */
  it("undoes to the value the last successful save stored", async () => {
    const user = userEvent.setup();
    render(<FocusTimerSection {...base} />);

    await user.click(minimal()); // off → on, lands
    await waitFor(() => expect(minimal()).toBeChecked());

    vi.mocked(updateFocusTimerSettings).mockRejectedValueOnce(
      new Error("offline"),
    );
    await user.click(minimal()); // on → off, refused

    await screen.findByRole("alert");
    await waitFor(() => expect(minimal()).toBeChecked());
  });

  it("says nothing and keeps the new value when the save works", async () => {
    const user = userEvent.setup();
    render(<FocusTimerSection {...base} />);
    await user.click(minimal());

    await waitFor(() => expect(updateFocusTimerSettings).toHaveBeenCalled());
    expect(screen.queryByRole("alert")).toBeNull();
    expect(minimal()).toBeChecked();
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

/**
 * #252 — the switch for the header's focus-timer shortcut.
 *
 * It lives with the other focus options rather than in its own section: unlike
 * `Settings.shoppingList`, which gates a whole route and earned a section for it
 * (#199), this governs one icon's presence and nothing else. Filing it under
 * "Focus timer" is where somebody looking for it would look.
 */
describe("FocusTimerSection — the header shortcut (#252)", () => {
  const toggle = () =>
    screen.getByRole("checkbox", { name: /shortcut in the header/i });

  it("seeds from the stored setting", () => {
    render(<FocusTimerSection {...base} />);
    expect(toggle()).toBeChecked();
    cleanup();
    render(<FocusTimerSection {...base} quickAccess={false} />);
    expect(toggle()).not.toBeChecked();
  });

  it("auto-saves both directions, like every other switch here", async () => {
    const user = userEvent.setup();
    render(<FocusTimerSection {...base} />);
    await user.click(toggle());
    expect(updateFocusTimerSettings).toHaveBeenLastCalledWith(
      expect.objectContaining({ quickAccess: false }),
    );
    await user.click(toggle());
    expect(updateFocusTimerSettings).toHaveBeenLastCalledWith(
      expect.objectContaining({ quickAccess: true }),
    );
  });

  // The action leaves the column alone when the key is absent (#252), so the
  // section has to send it on EVERY write — otherwise changing the timer style
  // would be the one path that cannot turn the shortcut off.
  it("sends the gate alongside an unrelated change", async () => {
    const user = userEvent.setup();
    render(<FocusTimerSection {...base} quickAccess={false} />);
    await user.click(screen.getByRole("radio", { name: /^mug$/i }));
    expect(updateFocusTimerSettings).toHaveBeenLastCalledWith(
      expect.objectContaining({ timerStyle: "mug", quickAccess: false }),
    );
  });

  // #227 — a refused write both says so and steps back. This is a toggle, not a
  // free-entry field, so it takes the rollback the three audited sections took.
  it("puts the switch back and says so when the write fails", async () => {
    vi.mocked(updateFocusTimerSettings).mockRejectedValueOnce(
      new Error("offline"),
    );
    const user = userEvent.setup();
    render(<FocusTimerSection {...base} />);
    await user.click(toggle());
    await waitFor(() => expect(toggle()).toBeChecked());
    expect(await screen.findByRole("alert")).toHaveTextContent(
      /couldn't save/i,
    );
  });

  // The hint is the only place a reader learns that turning this off does not
  // take the focus timer away — from the checkbox alone, "hide the shortcut" and
  // "disable the timer" look identical, and only one of them is what happens.
  it("says the timer itself stays in the menu", () => {
    render(<FocusTimerSection {...base} />);
    expect(screen.getByText(/still in the menu/i)).toBeInTheDocument();
  });
});
