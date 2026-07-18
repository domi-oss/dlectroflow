// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
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
  updateFirstRunPreview: vi.fn().mockResolvedValue(undefined),
}));

import { updateAgingSettings, updateFirstRunPreview } from "@/app/actions/settings";

afterEach(cleanup);

const settings: AgingSettings & { firstRunPreview: boolean } = {
  agingThresholdMinutes: 30,
  demoOverrideSeconds: null,
  agingHours: 4,
  overdueHours: 8,
  wayOverdueHours: 12,
  firstRunPreview: false,
};

describe("SettingsPanel freshness tier hours", () => {
  it("renders three tier-hour inputs seeded from settings", () => {
    render(
      <SettingsPanel
        settings={settings}
        isOwner={false}
        breakdownModel={null}
        voice="plain"
      />,
    );

    expect(screen.getByLabelText("Aging (hours)")).toHaveValue(4);
    expect(screen.getByLabelText("Overdue (hours)")).toHaveValue(8);
    expect(screen.getByLabelText("Way overdue (hours)")).toHaveValue(12);
  });

  it("saves edited tier hours alongside existing fields", async () => {
    const user = userEvent.setup();
    render(
      <SettingsPanel
        settings={settings}
        isOwner={false}
        breakdownModel={null}
        voice="plain"
      />,
    );

    const agingInput = screen.getByLabelText("Aging (hours)");
    await user.clear(agingInput);
    await user.type(agingInput, "6");

    const overdueInput = screen.getByLabelText("Overdue (hours)");
    await user.clear(overdueInput);
    await user.type(overdueInput, "10");

    const wayOverdueInput = screen.getByLabelText("Way overdue (hours)");
    await user.clear(wayOverdueInput);
    await user.type(wayOverdueInput, "20");

    await user.click(screen.getByRole("button", { name: /save/i }));

    expect(updateAgingSettings).toHaveBeenCalledWith({
      agingThresholdMinutes: 30,
      demoOverrideSeconds: null,
      agingHours: 6,
      overdueHours: 10,
      wayOverdueHours: 20,
    });
  });
});

describe("SettingsPanel demo: first-run preview toggle", () => {
  it("auto-saves on toggle, calling updateFirstRunPreview(true) then (false)", async () => {
    const user = userEvent.setup();
    render(
      <SettingsPanel
        settings={settings}
        isOwner={false}
        breakdownModel={null}
        voice="plain"
      />,
    );

    const toggle = screen.getByRole("checkbox", { name: /first-run preview/i });
    expect(toggle).not.toBeChecked();

    await user.click(toggle);
    expect(updateFirstRunPreview).toHaveBeenCalledWith(true);

    await user.click(toggle);
    expect(updateFirstRunPreview).toHaveBeenCalledWith(false);
  });
});
