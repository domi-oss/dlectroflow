// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AppMenu } from "@/components/nav/app-menu";

// Mutable so a test can simulate a client-side navigation (see the
// close-on-route-change test); reset to "/" after each test.
let pathname = "/";
vi.mock("next/navigation", () => ({
  usePathname: () => pathname,
}));

afterEach(() => {
  cleanup();
  pathname = "/";
});

describe("AppMenu", () => {
  it("lists the destinations (incl. Help) and excludes Task Breakdown", async () => {
    render(<AppMenu voice="plain" />);
    await userEvent.click(screen.getByRole("button", { name: /menu/i }));
    expect(screen.getByRole("link", { name: /Inbox/ })).toHaveAttribute(
      "href",
      "/",
    );
    expect(screen.getByRole("link", { name: /Focus Timer/ })).toHaveAttribute(
      "href",
      "/focus",
    );
    // Dashboard was renamed to "Activity" (label only — the /dashboard route is unchanged).
    expect(screen.getByRole("link", { name: /Activity/ })).toHaveAttribute(
      "href",
      "/dashboard",
    );
    expect(screen.getByRole("link", { name: /Library/ })).toHaveAttribute(
      "href",
      "/library",
    );
    expect(screen.getByRole("link", { name: /Settings/ })).toHaveAttribute(
      "href",
      "/settings",
    );
    expect(screen.getByRole("link", { name: /Help/ })).toHaveAttribute(
      "href",
      "/help",
    );
    expect(
      screen.queryByText(/Task Breakdown|Break into steps/),
    ).not.toBeInTheDocument();
  });

  it("orders Library before Activity in the menu", async () => {
    render(<AppMenu voice="plain" />);
    await userEvent.click(screen.getByRole("button", { name: /menu/i }));
    const labels = screen.getAllByRole("link").map((el) => el.textContent);
    expect(labels).toEqual([
      "Inbox",
      "Focus Timer",
      "Library",
      "Activity",
      "Settings",
      "Help",
    ]);
  });

  // #23 safety net: the menu must close itself on navigation (it used to be an
  // effect syncing state off `pathname`; it is now derived from it). Without
  // this the popover would stay open over the page you just navigated to.
  it("closes the menu when the route changes", async () => {
    const { rerender } = render(<AppMenu voice="plain" />);
    const button = screen.getByRole("button", { name: /menu/i });
    await userEvent.click(button);
    expect(screen.getByRole("link", { name: /Inbox/ })).toBeInTheDocument();
    expect(button).toHaveAttribute("aria-expanded", "true");

    pathname = "/focus";
    rerender(<AppMenu voice="plain" />);

    expect(
      screen.queryByRole("link", { name: /Inbox/ }),
    ).not.toBeInTheDocument();
    expect(button).toHaveAttribute("aria-expanded", "false");
  });

  // Re-opening after a navigation must still work (the derived-open rewrite
  // keys the open state on the pathname it was opened at).
  it("can be reopened on the new route after a navigation", async () => {
    const { rerender } = render(<AppMenu voice="plain" />);
    const button = screen.getByRole("button", { name: /menu/i });
    await userEvent.click(button);
    pathname = "/library";
    rerender(<AppMenu voice="plain" />);
    expect(button).toHaveAttribute("aria-expanded", "false");

    await userEvent.click(button);
    expect(button).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("link", { name: /Inbox/ })).toBeInTheDocument();
  });

  it("closes the menu when Escape is pressed", async () => {
    render(<AppMenu voice="plain" />);
    const user = userEvent.setup();
    const button = screen.getByRole("button", { name: /menu/i });
    await user.click(button);
    expect(screen.getByRole("link", { name: /Inbox/ })).toBeInTheDocument();
    await user.keyboard("{Escape}");
    expect(
      screen.queryByRole("link", { name: /Inbox/ }),
    ).not.toBeInTheDocument();
    expect(button).toHaveAttribute("aria-expanded", "false");
  });
});
