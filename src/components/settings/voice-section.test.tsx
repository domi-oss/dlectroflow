// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { VoiceSection } from "@/components/settings/voice-section";

// Split out of settings-panel.test.tsx by #101.

const refresh = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh }),
}));
vi.mock("@/app/actions/settings", () => ({
  updateVoice: vi.fn().mockResolvedValue(undefined),
}));

import { updateVoice } from "@/app/actions/settings";

afterEach(cleanup);
beforeEach(() => vi.clearAllMocks());

describe("VoiceSection", () => {
  it("is a labelled group of two choices, with the stored one selected", () => {
    render(<VoiceSection voice="playful" defaultExpanded />);
    expect(
      screen.getByRole("group", { name: /voice preference/i }),
    ).toBeInTheDocument();
    // Selection is shown by weight and fill, and both buttons are always
    // readable — the choice is two words, not a colour.
    expect(screen.getByRole("button", { name: "Playful" }).className).toMatch(
      /bg-primary/,
    );
    expect(screen.getByRole("button", { name: "Plain" }).className).not.toMatch(
      /bg-primary/,
    );
  });

  it("persists the pick and reflects it before the server answers", async () => {
    const user = userEvent.setup();
    render(<VoiceSection voice="plain" defaultExpanded />);

    await user.click(screen.getByRole("button", { name: "Playful" }));
    expect(updateVoice).toHaveBeenCalledWith("playful");
    // Optimistic: the whole page's copy re-renders from the server after
    // router.refresh(), and without this the toggle would show the old choice
    // for the length of that round trip.
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Playful" }).className).toMatch(
        /bg-primary/,
      ),
    );
    await waitFor(() => expect(refresh).toHaveBeenCalled());
  });

  it("rests collapsed like every other section (#101)", () => {
    render(<VoiceSection voice="plain" />);
    expect(
      document.querySelector('[data-section-toggle="settings-voice"]'),
    ).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("group")).toBeNull();
  });
});
