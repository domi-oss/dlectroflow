// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AgingSection } from "@/components/settings/aging-section";
import type { AgingSettings } from "@/lib/aging";

// Split out of settings-panel.test.tsx by #101, when the four sections that used
// to share one component became four (the section nav has always listed them
// separately).

const push = vi.fn();
const refresh = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push, refresh }),
}));

vi.mock("@/app/actions/settings", () => ({
  updateAgingSettings: vi.fn().mockResolvedValue(undefined),
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

/** Rendered OPEN: these specs are about the inputs, not the disclosure (#101). */
const renderSection = (overrides?: Partial<AgingSettings>) =>
  render(
    <AgingSection
      settings={{ ...settings, ...overrides }}
      voice="plain"
      autoSaveDelayMs={20}
      defaultExpanded
    />,
  );

describe("AgingSection auto-save", () => {
  it("renders the tier-hour inputs seeded from settings", () => {
    renderSection();
    expect(screen.getByLabelText("Aging (hours)")).toHaveValue(4);
    expect(screen.getByLabelText("Overdue (hours)")).toHaveValue(8);
    expect(screen.getByLabelText("Way overdue (hours)")).toHaveValue(12);
  });

  it("no Save button is rendered", () => {
    renderSection();
    expect(screen.queryByRole("button", { name: /save/i })).toBeNull();
  });

  it("auto-saves (debounced) when a freshness input changes", async () => {
    const user = userEvent.setup();
    renderSection();

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

  it("sends the whole group in ONE write — they share a single action", async () => {
    // The debounce is per-section, not per-field: editing two thresholds in quick
    // succession must not race two writes with each other's stale values.
    const user = userEvent.setup();
    renderSection();

    const aging = screen.getByLabelText("Aging (hours)");
    const overdue = screen.getByLabelText("Overdue (hours)");
    await user.clear(aging);
    await user.type(aging, "7");
    await user.clear(overdue);
    await user.type(overdue, "9");

    await waitFor(() =>
      expect(updateAgingSettings).toHaveBeenLastCalledWith({
        agingThresholdMinutes: 30,
        demoOverrideSeconds: null,
        agingHours: 7,
        overdueHours: 9,
        wayOverdueHours: 12,
      }),
    );
  });

  it("sends a blank demo override as null, not as 0", async () => {
    const user = userEvent.setup();
    renderSection({ demoOverrideSeconds: 10 });
    const demo = screen.getByLabelText(/demo override/i);
    await user.clear(demo);

    await waitFor(() =>
      expect(updateAgingSettings).toHaveBeenLastCalledWith(
        expect.objectContaining({ demoOverrideSeconds: null }),
      ),
    );
  });

  it("failure path: leaves the field editable and surfaces a non-blocking error", async () => {
    vi.mocked(updateAgingSettings).mockRejectedValueOnce(new Error("boom"));
    const user = userEvent.setup();
    renderSection();

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

describe("AgingSection — the disclosure (#101)", () => {
  it("rests collapsed, keeping the live demo-override warning in the band", () => {
    render(
      <AgingSection
        settings={{ ...settings, demoOverrideSeconds: 10 }}
        voice="plain"
      />,
    );
    const trigger = document.querySelector(
      '[data-section-toggle="settings-aging"]',
    )!;
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByLabelText("Aging (hours)")).not.toBeVisible();
    // "demo override: 10s" is a warning that items are aging in SECONDS. It has
    // to survive the section being closed, or the one state where the app lies
    // about time is the state with no visible explanation.
    expect(trigger.closest("[data-section-header]")).toHaveTextContent(
      "demo override: 10s",
    );
  });
});
