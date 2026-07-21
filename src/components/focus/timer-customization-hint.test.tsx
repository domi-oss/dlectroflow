// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { TimerCustomizationHint } from "@/components/focus/timer-customization-hint";

vi.mock("next/link", () => ({
  default: ({
    children,
    href,
    onClick,
  }: {
    children: React.ReactNode;
    href: string;
    onClick?: () => void;
  }) => (
    <a href={href} onClick={onClick}>
      {children}
    </a>
  ),
}));

afterEach(cleanup);

describe("TimerCustomizationHint", () => {
  it("shows the customization copy and links to /settings", () => {
    render(<TimerCustomizationHint voice="plain" onDismiss={() => {}} />);
    expect(screen.getByText(/make this timer yours/i)).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: /open settings/i }),
    ).toHaveAttribute("href", "/settings");
  });

  it("the ✕ button dismisses (has a text accessible name)", async () => {
    const user = userEvent.setup();
    const onDismiss = vi.fn();
    render(<TimerCustomizationHint voice="plain" onDismiss={onDismiss} />);
    await user.click(screen.getByRole("button", { name: /dismiss/i }));
    expect(onDismiss).toHaveBeenCalled();
  });

  it("tapping through to settings also dismisses (one-time)", async () => {
    const user = userEvent.setup();
    const onDismiss = vi.fn();
    render(<TimerCustomizationHint voice="plain" onDismiss={onDismiss} />);
    await user.click(screen.getByRole("link", { name: /open settings/i }));
    expect(onDismiss).toHaveBeenCalled();
  });
});
