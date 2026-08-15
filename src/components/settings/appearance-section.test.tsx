// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AppearanceSection } from "@/components/settings/appearance-section";

const refresh = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh }),
}));
vi.mock("@/app/actions/settings", () => ({
  updateAppearanceSettings: vi.fn().mockResolvedValue(undefined),
}));
import { updateAppearanceSettings } from "@/app/actions/settings";

afterEach(cleanup);
beforeEach(() => {
  vi.clearAllMocks();
  // This jsdom build doesn't provide window.localStorage; the ThemeToggle
  // persists the theme there and only flashes the shared save indicator on a
  // successful write. Provide a Map-backed stub (same idiom as
  // roundup-card.test.tsx) so the theme-toggle path is exercised.
  const store = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => {
      store.set(k, v);
    },
    removeItem: (k: string) => {
      store.delete(k);
    },
    clear: () => store.clear(),
  });
});

// #101 — every settings section is a disclosure now, so the specs below open it
// first. The disclosure MECHANISM is tested once, in
// src/components/nav/collapsible-section.test.tsx; that this section is one of
// them is asserted at the bottom of this file.
const base = {
  completeStrikethrough: true,
  completeTickColor: "green",
  typeface: "figtree",
  voice: "plain" as const,
  defaultExpanded: true,
};

describe("AppearanceSection", () => {
  it("seeds the strike toggle + tick-colour radios from props", () => {
    render(<AppearanceSection {...base} />);
    expect(screen.getByLabelText(/strike through completed/i)).toBeChecked();
    expect(screen.getByLabelText("Green")).toBeChecked();
    expect(screen.getByLabelText("Black")).not.toBeChecked();
  });

  it("turning strike off auto-saves the full pref set", async () => {
    const user = userEvent.setup();
    render(<AppearanceSection {...base} />);
    await user.click(screen.getByLabelText(/strike through completed/i));
    await waitFor(() =>
      expect(updateAppearanceSettings).toHaveBeenCalledWith({
        completeStrikethrough: false,
        completeTickColor: "green",
        typeface: "figtree",
      }),
    );
  });

  it("choosing Black auto-saves + repaints the live preview via root data attrs", async () => {
    const user = userEvent.setup();
    render(<AppearanceSection {...base} />);
    await user.click(screen.getByLabelText("Black"));
    await waitFor(() =>
      expect(updateAppearanceSettings).toHaveBeenCalledWith({
        completeStrikethrough: true,
        completeTickColor: "black",
        typeface: "figtree",
      }),
    );
    expect(screen.getByTestId("completion-preview")).toHaveAttribute(
      "data-tick",
      "black",
    );
  });

  it("the preview reflects strike off before the server round-trip", async () => {
    const user = userEvent.setup();
    render(<AppearanceSection {...base} />);
    await user.click(screen.getByLabelText(/strike through completed/i));
    expect(screen.getByTestId("completion-preview")).toHaveAttribute(
      "data-complete-strike",
      "off",
    );
  });

  it("the preview ✓ carries a text accessible name (status not colour-only)", () => {
    render(<AppearanceSection {...base} />);
    expect(screen.getByLabelText("done")).toHaveTextContent("✓");
  });

  it("seeds the typeface radios from props (figtree checked)", () => {
    render(<AppearanceSection {...base} />);
    expect(screen.getByLabelText(/figtree/i)).toBeChecked();
    expect(screen.getByLabelText("OpenDyslexic")).not.toBeChecked();
  });

  it("choosing OpenDyslexic auto-saves + repaints the live preview via data-font", async () => {
    const user = userEvent.setup();
    render(<AppearanceSection {...base} />);
    await user.click(screen.getByLabelText("OpenDyslexic"));
    await waitFor(() =>
      expect(updateAppearanceSettings).toHaveBeenCalledWith({
        completeStrikethrough: true,
        completeTickColor: "green",
        typeface: "opendyslexic",
      }),
    );
    expect(screen.getByTestId("typeface-preview")).toHaveAttribute(
      "data-font",
      "opendyslexic",
    );
  });

  it("the typeface picker is a labelled radiogroup (fieldset + legend)", () => {
    render(<AppearanceSection {...base} />);
    // Native <fieldset> exposes role="group"; its <legend> names it.
    expect(
      screen.getByRole("group", { name: /typeface/i }),
    ).toBeInTheDocument();
  });

  it("names OpenDyslexic/Atkinson as dyslexia/low-vision aids", () => {
    render(<AppearanceSection {...base} />);
    expect(
      screen.getByText(/dyslexi|low-vision/i, { selector: "p" }),
    ).toBeInTheDocument();
  });

  // #103 — the header went icon-only; this row deliberately did NOT, and the
  // words are still here. #85 turned the row into a three-state radiogroup
  // (`system` became the default and the two-state toggle could not express
  // it), so the words are now the three option labels rather than one button's
  // text — and, as before, they are the accessible names, un-overridden.
  it("keeps the theme control's visible words", () => {
    render(<AppearanceSection {...base} />);
    const group = screen.getByRole("group", { name: /theme/i });
    expect(group).toBeInTheDocument();
    for (const name of [/follow my system/i, /^light$/i, /^dark$/i]) {
      const radio = screen.getByRole("radio", { name });
      expect(radio).toBeInTheDocument();
      expect(radio).not.toHaveAttribute("aria-label");
    }
  });

  // #85 — `system` is the default, so it is what the group comes up on for
  // anyone who has not chosen. A section that opened on "Light" would be
  // claiming a choice the user never made.
  it("comes up on Follow my system when nothing has been chosen", () => {
    render(<AppearanceSection {...base} />);
    expect(
      screen.getByRole("radio", { name: /follow my system/i }),
    ).toBeChecked();
  });

  it("choosing a theme flashes the shared Appearance save indicator", async () => {
    const user = userEvent.setup();
    render(<AppearanceSection {...base} />);
    // The indicator is idle (renders nothing) until a change is saved.
    expect(screen.queryByRole("status")).toBeNull();
    await user.click(screen.getByRole("radio", { name: /^dark$/i }));
    expect(await screen.findByRole("status")).toBeInTheDocument();
  });

  it("surfaces an error alert (controls stay editable) when a save fails", async () => {
    vi.mocked(updateAppearanceSettings).mockRejectedValueOnce(
      new Error("save failed"),
    );
    const user = userEvent.setup();
    render(<AppearanceSection {...base} />);
    await user.click(screen.getByLabelText(/strike through completed/i));
    // persist()'s catch → markError() → SaveIndicator renders role="alert".
    expect(await screen.findByRole("alert")).toBeInTheDocument();
    // The failed save leaves the control interactive for a retry.
    expect(screen.getByLabelText(/strike through completed/i)).toBeEnabled();
  });
});

/**
 * #227 — the audit half of the issue, and this section was **not** already
 * correct.
 *
 * It had the reporting (`persist`'s catch → `markError()`) and not the rollback,
 * exactly like `NotificationsSection`: a refused write left the checkbox and the
 * radios showing the value the server had declined, with "couldn't save" beside
 * them. Here it also drives two LIVE PREVIEWS off that value, so the completion
 * sample and the typeface sample went on demonstrating a choice the database had
 * refused — the lie rendered twice more, larger.
 *
 * The rollback restores only the field this attempt changed, only where the
 * value it wrote is still showing. See `revert-optimistic.ts`.
 */
describe("AppearanceSection: when a save fails", () => {
  const strike = () => screen.getByLabelText(/strike through completed/i);

  it("puts the strike checkbox back where the server still has it", async () => {
    vi.mocked(updateAppearanceSettings).mockRejectedValueOnce(
      new Error("offline"),
    );
    const user = userEvent.setup();
    render(<AppearanceSection {...base} />);
    await user.click(strike()); // true → false, optimistically

    await screen.findByRole("alert");
    await waitFor(() => expect(strike()).toBeChecked());
  });

  it("puts the tick-colour radio back, and the preview with it", async () => {
    vi.mocked(updateAppearanceSettings).mockRejectedValueOnce(
      new Error("offline"),
    );
    const user = userEvent.setup();
    render(<AppearanceSection {...base} />);
    await user.click(screen.getByLabelText("Black"));

    await screen.findByRole("alert");
    await waitFor(() => expect(screen.getByLabelText("Green")).toBeChecked());
    expect(screen.getByLabelText("Black")).not.toBeChecked();
    // The preview reads its attributes off the same state, so a rollback that
    // missed it would leave the sample demonstrating the refused choice.
    expect(screen.getByTestId("completion-preview")).toHaveAttribute(
      "data-tick",
      "green",
    );
  });

  it("puts the typeface back, and stops the sample showing the refused face", async () => {
    vi.mocked(updateAppearanceSettings).mockRejectedValueOnce(
      new Error("offline"),
    );
    const user = userEvent.setup();
    render(<AppearanceSection {...base} />);
    await user.click(screen.getByLabelText(/atkinson/i));

    await screen.findByRole("alert");
    await waitFor(() =>
      expect(screen.getByLabelText(/figtree/i)).toBeChecked(),
    );
    expect(screen.getByTestId("typeface-preview")).toHaveAttribute(
      "data-font",
      "figtree",
    );
  });

  it("undoes only the field that failed, leaving a landed change alone", async () => {
    const user = userEvent.setup();
    render(<AppearanceSection {...base} />);

    await user.click(screen.getByLabelText("Black")); // lands
    await waitFor(() => expect(screen.getByLabelText("Black")).toBeChecked());

    vi.mocked(updateAppearanceSettings).mockRejectedValueOnce(
      new Error("offline"),
    );
    await user.click(strike()); // refused

    await screen.findByRole("alert");
    await waitFor(() => expect(strike()).toBeChecked());
    expect(screen.getByLabelText("Black")).toBeChecked();
  });

  /**
   * #227 review — the rollback target is what the server last **confirmed**,
   * not the prop this section was first rendered with.
   *
   * Black lands, so the database holds `black`. Picking Green back is then
   * refused, and the radio has to return to Black. Restoring the initial prop
   * would leave Green selected — the very choice the server declined — and the
   * preview would go on demonstrating it.
   */
  it("undoes to the value the last successful save stored", async () => {
    const user = userEvent.setup();
    render(<AppearanceSection {...base} />);

    await user.click(screen.getByLabelText("Black")); // lands
    await waitFor(() => expect(screen.getByLabelText("Black")).toBeChecked());

    vi.mocked(updateAppearanceSettings).mockRejectedValueOnce(
      new Error("offline"),
    );
    await user.click(screen.getByLabelText("Green")); // refused

    await screen.findByRole("alert");
    await waitFor(() => expect(screen.getByLabelText("Black")).toBeChecked());
    expect(screen.getByTestId("completion-preview")).toHaveAttribute(
      "data-tick",
      "black",
    );
  });

  it("says nothing and keeps the new value when the save works", async () => {
    const user = userEvent.setup();
    render(<AppearanceSection {...base} />);
    await user.click(strike());

    await waitFor(() => expect(updateAppearanceSettings).toHaveBeenCalled());
    expect(screen.queryByRole("alert")).toBeNull();
    expect(strike()).not.toBeChecked();
  });
});

describe("AppearanceSection — the disclosure (#101)", () => {
  const trigger = () =>
    document.querySelector('[data-section-toggle="settings-appearance"]')!;

  it("rests collapsed, and its controls leave the page with it", () => {
    render(<AppearanceSection {...base} defaultExpanded={false} />);
    expect(trigger()).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByLabelText("Green")).not.toBeVisible();
  });

  it("reports a save that lands after the section was closed again", async () => {
    // The save indicator is a sibling of the h2 in the heading band, not part of
    // the body — so closing a section mid-save does not hide the outcome.
    const user = userEvent.setup();
    render(<AppearanceSection {...base} />);
    await user.click(screen.getByLabelText("Black"));
    await user.click(trigger()); // close it while the write is in flight
    await waitFor(() =>
      expect(document.querySelector("[data-save-status]")).not.toBeNull(),
    );
    expect(trigger().closest("[data-section-header]")).toContainElement(
      document.querySelector("[data-save-status]"),
    );
  });
});
