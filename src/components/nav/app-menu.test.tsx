// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AppMenu } from "@/components/nav/app-menu";

vi.mock("next/navigation", () => ({
  usePathname: () => "/inbox",
}));

afterEach(cleanup);

describe("AppMenu", () => {
  it("lists the destinations (incl. Help) and excludes Task Breakdown", async () => {
    render(<AppMenu voice="plain" />);
    await userEvent.click(screen.getByRole("button", { name: /menu/i }));
    expect(screen.getByRole("link", { name: /Inbox/ })).toHaveAttribute("href", "/inbox");
    expect(screen.getByRole("link", { name: /Focus Timer/ })).toHaveAttribute("href", "/focus");
    expect(screen.getByRole("link", { name: /Dashboard/ })).toHaveAttribute("href", "/dashboard");
    expect(screen.getByRole("link", { name: /Library/ })).toHaveAttribute("href", "/library");
    expect(screen.getByRole("link", { name: /Settings/ })).toHaveAttribute("href", "/settings");
    expect(screen.getByRole("link", { name: /Help/ })).toHaveAttribute("href", "/help");
    expect(screen.queryByText(/Task Breakdown|Break into steps/)).not.toBeInTheDocument();
  });

  it("closes the menu when Escape is pressed", async () => {
    render(<AppMenu voice="plain" />);
    const user = userEvent.setup();
    const button = screen.getByRole("button", { name: /menu/i });
    await user.click(button);
    expect(screen.getByRole("link", { name: /Inbox/ })).toBeInTheDocument();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("link", { name: /Inbox/ })).not.toBeInTheDocument();
    expect(button).toHaveAttribute("aria-expanded", "false");
  });
});
