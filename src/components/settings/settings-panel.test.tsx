// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SettingsPanel } from "@/components/settings/settings-panel";
import type { AgingSettings } from "@/lib/aging";

const push = vi.fn();
const refresh = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push, refresh }),
}));

vi.mock("@/app/actions/settings", () => ({
  updateAgingSettings: vi.fn().mockResolvedValue(undefined),
  updateBreakdownModel: vi.fn().mockResolvedValue(undefined),
  updateVoice: vi.fn().mockResolvedValue(undefined),
}));

import { updateAgingSettings } from "@/app/actions/settings";

afterEach(cleanup);
beforeEach(() => vi.clearAllMocks());

const settings: AgingSettings = {
  agingThresholdMinutes: 30,
  demoOverrideSeconds: null,
  agingHours: 4,
  overdueHours: 8,
  wayOverdueHours: 12,
};

const renderPanel = (overrides?: Partial<AgingSettings>) =>
  render(
    <SettingsPanel
      settings={{ ...settings, ...overrides }}
      isOwner={false}
      breakdownModel={null}
      voice="plain"
      autoSaveDelayMs={20}
    />,
  );

describe("SettingsPanel auto-save (Phase 6)", () => {
  it("renders the tier-hour inputs seeded from settings", () => {
    renderPanel();
    expect(screen.getByLabelText("Aging (hours)")).toHaveValue(4);
    expect(screen.getByLabelText("Overdue (hours)")).toHaveValue(8);
    expect(screen.getByLabelText("Way overdue (hours)")).toHaveValue(12);
  });

  it("no Save button is rendered", () => {
    renderPanel();
    expect(screen.queryByRole("button", { name: /save/i })).toBeNull();
  });

  it("auto-saves (debounced) when a freshness input changes", async () => {
    const user = userEvent.setup();
    renderPanel();

    const agingInput = screen.getByLabelText("Aging (hours)");
    await user.clear(agingInput);
    await user.type(agingInput, "6");

    await waitFor(() =>
      expect(updateAgingSettings).toHaveBeenLastCalledWith({
        agingThresholdMinutes: 30,
        demoOverrideSeconds: null,
        agingHours: 6,
        overdueHours: 8,
        wayOverdueHours: 12,
      }),
    );
  });

  it("failure path: leaves the field editable and surfaces a non-blocking error", async () => {
    vi.mocked(updateAgingSettings).mockRejectedValueOnce(new Error("boom"));
    const user = userEvent.setup();
    renderPanel();

    const overdueInput = screen.getByLabelText("Overdue (hours)");
    await user.clear(overdueInput);
    await user.type(overdueInput, "9");

    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent(/couldn't save/i),
    );
    // Field is still editable (not disabled) after a failed write.
    expect(overdueInput).not.toBeDisabled();
    await user.type(overdueInput, "0"); // still accepts input
    expect(overdueInput).toHaveValue(90);
  });
});
