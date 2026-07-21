// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { FocusTimerSection } from "@/components/settings/focus-timer-section";

const refresh = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh }),
}));
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
  it("offers exactly the 4 explicit styles — no 'match voice' / 'auto' option", () => {
    render(<FocusTimerSection {...base} />);
    expect(screen.getByRole("radio", { name: /^ring$/i })).toBeInTheDocument();
    expect(
      screen.getByRole("radio", { name: /^digits$/i }),
    ).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: /^bar$/i })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: /^mug$/i })).toBeInTheDocument();
    expect(screen.getAllByRole("radio")).toHaveLength(4);
    expect(screen.queryByRole("radio", { name: /match voice/i })).toBeNull();
    expect(screen.queryByRole("radio", { name: /auto/i })).toBeNull();
  });

  it("seeds the other controls from props (keep-awake on, minimal off)", () => {
    render(<FocusTimerSection {...base} />);
    expect(screen.getByLabelText(/keep screen awake/i)).toBeChecked();
    expect(screen.getByLabelText(/minimal/i)).not.toBeChecked();
  });

  it("preselects the voice default when the stored style is null (plain → ring)", () => {
    render(<FocusTimerSection {...base} />);
    expect(screen.getByRole("radio", { name: /^ring$/i })).toBeChecked();
    expect(screen.getByRole("radio", { name: /^mug$/i })).not.toBeChecked();
  });

  it("preselects the voice default when the stored style is null (playful → mug)", () => {
    render(<FocusTimerSection {...base} voice="playful" />);
    expect(screen.getByRole("radio", { name: /mug/i })).toBeChecked();
    expect(screen.getByRole("radio", { name: /^ring$/i })).not.toBeChecked();
  });

  it("preselects the stored style verbatim when one is set", () => {
    render(<FocusTimerSection {...base} timerStyle="digits" />);
    expect(screen.getByRole("radio", { name: /^digits$/i })).toBeChecked();
  });

  it("renders a decorative (aria-hidden) preview beside each of the 4 style options", () => {
    render(<FocusTimerSection {...base} />);
    for (const style of ["ring", "digits", "bar", "mug"] as const) {
      const preview = screen.getByTestId(`timer-style-preview-${style}`);
      expect(preview).toBeInTheDocument();
      expect(preview).toHaveAttribute("aria-hidden", "true");
    }
  });

  it("choosing the Mug style auto-saves the full pref set (explicit value)", async () => {
    const user = userEvent.setup();
    render(<FocusTimerSection {...base} />);
    await user.click(screen.getByRole("radio", { name: /^mug$/i }));
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
    await user.selectOptions(
      screen.getByLabelText(/focus sounds/i),
      "lofi_calm",
    );
    await waitFor(() =>
      expect(updateFocusTimerSettings).toHaveBeenCalledWith(
        expect.objectContaining({ sound: "lofi_calm" }),
      ),
    );
  });
});
