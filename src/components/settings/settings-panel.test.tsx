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
  updateFirstRunPreview: vi.fn().mockResolvedValue(undefined),
}));

import {
  updateAgingSettings,
  updateBreakdownModel,
  updateFirstRunPreview,
} from "@/app/actions/settings";

afterEach(cleanup);
beforeEach(() => vi.clearAllMocks());

const settings: AgingSettings & { firstRunPreview: boolean } = {
  agingThresholdMinutes: 30,
  demoOverrideSeconds: null,
  agingHours: 4,
  overdueHours: 8,
  wayOverdueHours: 12,
  firstRunPreview: false,
};

// The anthropic three-tier choice list, as `modelChoicesForProvider()` (#59)
// returns it for the default provider. Passed explicitly since the picker is
// now server-resolved and handed to the panel as a prop.
const MODEL_CHOICES = [
  { id: "claude-haiku-4-5", label: "Haiku 4.5 — fastest, cheapest" },
  { id: "claude-sonnet-4-6", label: "Sonnet 4.6 — balanced (default)" },
  { id: "claude-opus-4-8", label: "Opus 4.8 — deepest reasoning, slower" },
];

const renderPanel = (overrides?: Partial<AgingSettings>) =>
  render(
    <SettingsPanel
      settings={{ ...settings, ...overrides }}
      isOwner={false}
      breakdownModel={null}
      modelChoices={MODEL_CHOICES}
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

describe("SettingsPanel breakdown model — owner (interactive, #6)", () => {
  it("renders the model radios enabled, with the owner's stored model checked", () => {
    render(
      <SettingsPanel
        settings={settings}
        isOwner
        breakdownModel="claude-opus-4-8"
        modelChoices={MODEL_CHOICES}
        voice="plain"
      />,
    );
    const opus = screen.getByLabelText(/Opus/);
    expect(opus).toBeChecked();
    expect(opus).toBeEnabled();
    const haiku = screen.getByLabelText(/Haiku/);
    expect(haiku).not.toBeChecked();
    expect(haiku).toBeEnabled();
    // No "owner-only" gray-out messaging for the owner.
    expect(screen.queryByText(/owner-only/i)).toBeNull();
  });

  it("selecting a model persists it via updateBreakdownModel", async () => {
    const user = userEvent.setup();
    render(
      <SettingsPanel
        settings={settings}
        isOwner
        breakdownModel="claude-sonnet-4-6"
        modelChoices={MODEL_CHOICES}
        voice="plain"
      />,
    );
    await user.click(screen.getByLabelText(/Haiku/));
    expect(updateBreakdownModel).toHaveBeenCalledWith("claude-haiku-4-5");
  });
});

describe("SettingsPanel breakdown model — no choice (openai-compatible, #59)", () => {
  it("shows a read-only 'Using model' line instead of a picker when modelChoices is null", () => {
    render(
      <SettingsPanel
        settings={settings}
        isOwner
        breakdownModel={null}
        modelChoices={null}
        activeModelName="llama3.1:8b"
        voice="plain"
      />,
    );
    expect(
      screen.queryByRole("radiogroup", { name: /breakdown model/i }),
    ).toBeNull();
    expect(screen.getByText(/using model/i)).toHaveTextContent(
      "Using model: llama3.1:8b",
    );
    // The anthropic-only decoy must not leak into a provider with no choice.
    expect(screen.queryByText(/Fable/)).toBeNull();
  });

  it("falls back to 'unknown' if no active model name was resolved server-side", () => {
    render(
      <SettingsPanel
        settings={settings}
        isOwner={false}
        breakdownModel={null}
        modelChoices={null}
        voice="plain"
      />,
    );
    expect(screen.getByText(/using model/i)).toHaveTextContent(
      "Using model: unknown",
    );
  });
});

describe("SettingsPanel breakdown model — guest (read-only, #11)", () => {
  it("shows the picker so guests see what the app offers, but disabled + owner-only", () => {
    render(
      <SettingsPanel
        settings={settings}
        isOwner={false}
        breakdownModel={null}
        modelChoices={MODEL_CHOICES}
        voice="plain"
      />,
    );
    // The section is present (visible to guests).
    expect(
      screen.getByRole("radiogroup", { name: /breakdown model/i }),
    ).toBeInTheDocument();
    // Every real model option is announced but disabled (not colour-only:
    // there is an explicit "owner-only" text label too).
    for (const name of [/Haiku/, /Sonnet/, /Opus/]) {
      expect(screen.getByLabelText(name)).toBeDisabled();
    }
    expect(screen.getAllByText(/owner-only/i).length).toBeGreaterThan(0);
  });

  it("never leaks the owner's chosen model — nothing is pre-selected for guests", () => {
    // Even if a value is handed to the component, a guest must not see it
    // reflected as the selected option.
    render(
      <SettingsPanel
        settings={settings}
        isOwner={false}
        breakdownModel="claude-opus-4-8"
        modelChoices={MODEL_CHOICES}
        voice="plain"
      />,
    );
    expect(screen.getByLabelText(/Opus/)).not.toBeChecked();
    expect(screen.getByLabelText(/Haiku/)).not.toBeChecked();
    expect(screen.getByLabelText(/Sonnet/)).not.toBeChecked();
  });

  it("cannot mutate the owner-only model (disabled → no write)", async () => {
    const user = userEvent.setup();
    render(
      <SettingsPanel
        settings={settings}
        isOwner={false}
        breakdownModel={null}
        modelChoices={MODEL_CHOICES}
        voice="plain"
      />,
    );
    await user.click(screen.getByLabelText(/Sonnet/));
    expect(updateBreakdownModel).not.toHaveBeenCalled();
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
        modelChoices={MODEL_CHOICES}
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
