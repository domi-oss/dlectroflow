// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { BreakdownModelSection } from "@/components/settings/breakdown-model-section";

// Split out of settings-panel.test.tsx by #101.

const refresh = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh }),
}));
vi.mock("@/app/actions/settings", () => ({
  updateBreakdownModel: vi.fn().mockResolvedValue(undefined),
}));

import { updateBreakdownModel } from "@/app/actions/settings";

afterEach(cleanup);
beforeEach(() => vi.clearAllMocks());

// The anthropic three-tier choice list, as `modelChoicesForProvider()` (#59)
// returns it for the default provider. Passed explicitly since the picker is
// server-resolved and handed to the section as a prop.
const MODEL_CHOICES = [
  { id: "claude-haiku-4-5", label: "Haiku 4.5 — fastest, cheapest" },
  { id: "claude-sonnet-4-6", label: "Sonnet 4.6 — balanced (default)" },
  { id: "claude-opus-4-8", label: "Opus 4.8 — deepest reasoning, slower" },
];

describe("BreakdownModelSection — owner (interactive, #6)", () => {
  it("renders the model radios enabled, with the owner's stored model checked", () => {
    render(
      <BreakdownModelSection
        isOwner
        breakdownModel="claude-opus-4-8"
        modelChoices={MODEL_CHOICES}
        voice="plain"
        defaultExpanded
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
      <BreakdownModelSection
        isOwner
        breakdownModel="claude-sonnet-4-6"
        modelChoices={MODEL_CHOICES}
        voice="plain"
        defaultExpanded
      />,
    );
    await user.click(screen.getByLabelText(/Haiku/));
    expect(updateBreakdownModel).toHaveBeenCalledWith("claude-haiku-4-5");
  });
});

describe("BreakdownModelSection — no choice (openai-compatible, #59)", () => {
  it("shows a read-only 'Using model' line instead of a picker when modelChoices is null", () => {
    render(
      <BreakdownModelSection
        isOwner
        breakdownModel={null}
        modelChoices={null}
        activeModelName="llama3.1:8b"
        voice="plain"
        defaultExpanded
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
      <BreakdownModelSection
        isOwner={false}
        breakdownModel={null}
        modelChoices={null}
        voice="plain"
        defaultExpanded
      />,
    );
    expect(screen.getByText(/using model/i)).toHaveTextContent(
      "Using model: unknown",
    );
  });
});

describe("BreakdownModelSection — guest (read-only, #11)", () => {
  const renderGuest = (breakdownModel: string | null = null) =>
    render(
      <BreakdownModelSection
        isOwner={false}
        breakdownModel={breakdownModel}
        modelChoices={MODEL_CHOICES}
        voice="plain"
        defaultExpanded
      />,
    );

  it("shows the picker so guests see what the app offers, but disabled + owner-only", () => {
    renderGuest();
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
    renderGuest("claude-opus-4-8");
    expect(screen.getByLabelText(/Opus/)).not.toBeChecked();
    expect(screen.getByLabelText(/Haiku/)).not.toBeChecked();
    expect(screen.getByLabelText(/Sonnet/)).not.toBeChecked();
  });

  it("cannot mutate the owner-only model (disabled → no write)", async () => {
    const user = userEvent.setup();
    renderGuest();
    await user.click(screen.getByLabelText(/Sonnet/));
    expect(updateBreakdownModel).not.toHaveBeenCalled();
  });

  it("keeps the owner-only badge readable while the section is CLOSED (#101)", () => {
    // The badge lives in the heading band, so the "you cannot act on this" read
    // survives the collapsed state a guest first meets the section in.
    render(
      <BreakdownModelSection
        isOwner={false}
        breakdownModel={null}
        modelChoices={MODEL_CHOICES}
        voice="plain"
      />,
    );
    const trigger = document.querySelector(
      '[data-section-toggle="settings-breakdown-model"]',
    )!;
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    expect(trigger.closest("[data-section-header]")).toHaveTextContent(
      /owner-only/i,
    );
    expect(
      screen.queryByRole("radiogroup", { name: /breakdown model/i }),
    ).toBeNull();
  });
});

describe("BreakdownModelSection decoy line (#72 follow-up)", () => {
  it("renders the SAME decoy line on every render of the same props", () => {
    // It used to roll Math.random() during render, so the server and the client
    // disagreed and React discarded the hydrated tree — which reset <html>'s
    // class list and silently dropped dark mode on /settings. The line is now
    // rolled server-side and handed in as a prop.
    const line = "a fixed decoy line";
    const first = render(
      <BreakdownModelSection
        isOwner={false}
        breakdownModel={null}
        modelChoices={MODEL_CHOICES}
        voice="plain"
        fable={line}
        defaultExpanded
      />,
    );
    expect(screen.getByText(new RegExp(line))).toBeInTheDocument();
    first.unmount();

    // Same props, fresh render — identical output, no dice roll.
    render(
      <BreakdownModelSection
        isOwner={false}
        breakdownModel={null}
        modelChoices={MODEL_CHOICES}
        voice="plain"
        fable={line}
        defaultExpanded
      />,
    );
    expect(screen.getByText(new RegExp(line))).toBeInTheDocument();
  });
});
