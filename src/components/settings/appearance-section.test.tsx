// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AppearanceSection } from "@/components/settings/appearance-section";

const refresh = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh }) }));
vi.mock("@/app/actions/settings", () => ({
  updateAppearanceSettings: vi.fn().mockResolvedValue(undefined),
}));
import { updateAppearanceSettings } from "@/app/actions/settings";

afterEach(cleanup);
beforeEach(() => vi.clearAllMocks());

const base = { completeStrikethrough: true, completeTickColor: "green", voice: "plain" as const };

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
      }),
    );
    expect(screen.getByTestId("completion-preview")).toHaveAttribute("data-tick", "black");
  });

  it("the preview reflects strike off before the server round-trip", async () => {
    const user = userEvent.setup();
    render(<AppearanceSection {...base} />);
    await user.click(screen.getByLabelText(/strike through completed/i));
    expect(screen.getByTestId("completion-preview")).toHaveAttribute("data-complete-strike", "off");
  });

  it("the preview ✓ carries a text accessible name (status not colour-only)", () => {
    render(<AppearanceSection {...base} />);
    expect(screen.getByLabelText("done")).toHaveTextContent("✓");
  });

  it("toggling the theme flashes the shared Appearance save indicator", async () => {
    const user = userEvent.setup();
    render(<AppearanceSection {...base} />);
    // The indicator is idle (renders nothing) until a change is saved.
    expect(screen.queryByRole("status")).toBeNull();
    await user.click(screen.getByRole("button", { name: /mode/i }));
    expect(await screen.findByRole("status")).toBeInTheDocument();
  });

  it("surfaces an error alert (controls stay editable) when a save fails", async () => {
    vi.mocked(updateAppearanceSettings).mockRejectedValueOnce(new Error("save failed"));
    const user = userEvent.setup();
    render(<AppearanceSection {...base} />);
    await user.click(screen.getByLabelText(/strike through completed/i));
    // persist()'s catch → markError() → SaveIndicator renders role="alert".
    expect(await screen.findByRole("alert")).toBeInTheDocument();
    // The failed save leaves the control interactive for a retry.
    expect(screen.getByLabelText(/strike through completed/i)).toBeEnabled();
  });
});
