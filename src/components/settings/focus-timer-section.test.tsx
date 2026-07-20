// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { FocusTimerSection } from "@/components/settings/focus-timer-section";

const refresh = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh }) }));
vi.mock("@/app/actions/settings", () => ({
  updateFocusTimerSettings: vi.fn().mockResolvedValue(undefined),
}));
import { updateFocusTimerSettings } from "@/app/actions/settings";

afterEach(cleanup);
beforeEach(() => vi.clearAllMocks());

const base = {
  timerStyle: null as string | null,
  minimalMode: false,
  keepAwake: true,
  alarmEnabled: true,
  sound: "off",
  voice: "plain" as const,
};

describe("FocusTimerSection", () => {
  it("seeds the controls from props ('Match voice' when style is null)", () => {
    render(<FocusTimerSection {...base} />);
    expect(screen.getByLabelText(/match voice/i)).toBeChecked();
    expect(screen.getByLabelText(/keep screen awake/i)).toBeChecked();
    expect(screen.getByLabelText(/minimal/i)).not.toBeChecked();
  });

  it("choosing the Mug style auto-saves the full pref set", async () => {
    const user = userEvent.setup();
    render(<FocusTimerSection {...base} />);
    await user.click(screen.getByLabelText(/^mug/i));
    await waitFor(() =>
      expect(updateFocusTimerSettings).toHaveBeenCalledWith({
        timerStyle: "mug",
        minimalMode: false,
        keepAwake: true,
        alarmEnabled: true,
        sound: "off",
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

  it("choosing a sound auto-saves", async () => {
    const user = userEvent.setup();
    render(<FocusTimerSection {...base} />);
    await user.selectOptions(screen.getByLabelText(/focus sounds/i), "lofi_calm");
    await waitFor(() =>
      expect(updateFocusTimerSettings).toHaveBeenCalledWith(
        expect.objectContaining({ sound: "lofi_calm" }),
      ),
    );
  });
});
