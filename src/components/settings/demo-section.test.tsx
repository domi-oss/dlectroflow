// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { DemoSection } from "@/components/settings/demo-section";

// Split out of settings-panel.test.tsx by #101.

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));
vi.mock("@/app/actions/settings", () => ({
  updateFirstRunPreview: vi.fn().mockResolvedValue(undefined),
}));

import { updateFirstRunPreview } from "@/app/actions/settings";

afterEach(cleanup);
beforeEach(() => vi.clearAllMocks());

describe("DemoSection: first-run preview toggle", () => {
  it("auto-saves on toggle, calling updateFirstRunPreview(true) then (false)", async () => {
    const user = userEvent.setup();
    render(
      <DemoSection firstRunPreview={false} voice="plain" defaultExpanded />,
    );

    const toggle = screen.getByRole("checkbox", { name: /first-run preview/i });
    expect(toggle).not.toBeChecked();

    await user.click(toggle);
    expect(updateFirstRunPreview).toHaveBeenCalledWith(true);

    await user.click(toggle);
    expect(updateFirstRunPreview).toHaveBeenCalledWith(false);
  });

  it("seeds from the stored preference", () => {
    render(<DemoSection firstRunPreview voice="plain" defaultExpanded />);
    expect(
      screen.getByRole("checkbox", { name: /first-run preview/i }),
    ).toBeChecked();
  });

  it("says the preview is non-destructive, where the checkbox is", () => {
    // It shows the app as a brand-new user sees it, which looks exactly like
    // "my data is gone". The reassurance has to be next to the control.
    render(
      <DemoSection firstRunPreview={false} voice="plain" defaultExpanded />,
    );
    expect(screen.getByText(/non-destructive/i)).toBeVisible();
  });

  it("rests collapsed like every other section (#101)", () => {
    render(<DemoSection firstRunPreview={false} voice="plain" />);
    expect(
      document.querySelector('[data-section-toggle="settings-demo"]'),
    ).toHaveAttribute("aria-expanded", "false");
    expect(
      screen.queryByRole("checkbox", { name: /first-run preview/i }),
    ).toBeNull();
  });
});
