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

  /**
   * #261 — the section is HOURS throughout, and this is the assertion that says
   * so. It carried an "Aging threshold (minutes)" field beside "Aging (hours)":
   * two controls for one concept, in two units, with the same default (240 vs 4)
   * and no reconciliation — so the owner's report was *"the aging threshold is in
   * minutes, whereas the other options are hours"*, and the cause underneath it
   * was two columns rather than a formatting choice.
   *
   * The "Demo override (seconds)" field is gone with it: a THIRD unit on the same
   * five-control row, and the talk it existed for has happened.
   *
   * #260 adds a "park until" snooze here and the convention it inherits is this
   * one — whole hours, one setting per concept. `aging.ts`'s module docblock is
   * where that is written down at length.
   */
  it("is hours throughout — no minutes and no seconds control (#261)", () => {
    const { container } = renderSection();
    expect(screen.queryByLabelText(/minutes/i)).toBeNull();
    expect(screen.queryByLabelText(/seconds/i)).toBeNull();
    expect(screen.queryByLabelText(/demo override/i)).toBeNull();

    const labels = [...container.querySelectorAll("label")].map(
      (l) => l.textContent ?? "",
    );
    expect(labels).toHaveLength(3);
    for (const label of labels) expect(label).toMatch(/\(hours\)$/);
  });

  it("auto-saves (debounced) when a freshness input changes", async () => {
    const user = userEvent.setup();
    renderSection();

    const agingInput = screen.getByLabelText("Aging (hours)");
    await user.clear(agingInput);
    await user.type(agingInput, "6");

    await waitFor(() =>
      expect(updateAgingSettings).toHaveBeenLastCalledWith({
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
        agingHours: 7,
        overdueHours: 9,
        wayOverdueHours: 12,
      }),
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

  /**
   * #227 audited the four `useSaveStatus` sections for "reports the failure AND
   * rolls the control back". This one was **already correct**, and the reason is
   * a decision rather than an omission — so it is pinned here, or the next audit
   * reads the missing rollback as the bug the other three had.
   *
   * These are three free-entry number fields behind a 600 ms debounce. The value
   * on screen is the user's own in-progress typing, not a toggle's committed
   * state, so restoring the server's number would DELETE what they are still
   * editing — a considerably worse outcome than the stale-looking switch #227 is
   * about, and the failure mode the section's docblock has always named when it
   * says a failed write leaves every input editable. Reporting is the whole
   * correct answer for a field the user is holding.
   */
  it("keeps what the user typed when the save fails — deliberately no rollback", async () => {
    vi.mocked(updateAgingSettings).mockRejectedValueOnce(new Error("boom"));
    const user = userEvent.setup();
    renderSection();

    const agingInput = screen.getByLabelText("Aging (hours)");
    await user.clear(agingInput);
    await user.type(agingInput, "12");

    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent(/couldn't save/i),
    );
    // 12, not the stored 4: the failure is reported, the typing survives it.
    expect(agingInput).toHaveValue(12);
  });
});

describe("AgingSection — the disclosure (#101)", () => {
  it("rests collapsed", () => {
    render(<AgingSection settings={settings} voice="plain" />);
    const trigger = document.querySelector(
      '[data-section-toggle="settings-aging"]',
    )!;
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByLabelText("Aging (hours)")).not.toBeVisible();
    // #261 — the header used to carry "demo override: 10s" through the collapse,
    // because a workspace aging items in SECONDS needed an explanation visible
    // with the section shut. Nothing lies about time any more, so there is
    // nothing for the band to warn about.
    expect(trigger.closest("[data-section-header]")).not.toHaveTextContent(
      /demo override/i,
    );
  });
});
