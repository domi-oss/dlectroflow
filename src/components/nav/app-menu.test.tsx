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

  // #199 — the shopping-list entry is behind Settings.shoppingList, and the
  // default is OFF. The prop is optional and defaults to false so a caller that
  // predates it fails CLOSED: forgetting to pass it hides a feature rather than
  // revealing one nobody asked for.
  it("omits the shopping list by default", async () => {
    render(<AppMenu voice="plain" />);
    await userEvent.click(screen.getByRole("button", { name: /menu/i }));
    expect(
      screen.queryByRole("link", { name: /Shopping list/ }),
    ).not.toBeInTheDocument();
  });

  it("omits the shopping list when the toggle is off", async () => {
    render(<AppMenu voice="plain" shoppingList={false} />);
    await userEvent.click(screen.getByRole("button", { name: /menu/i }));
    expect(
      screen.queryByRole("link", { name: /Shopping list/ }),
    ).not.toBeInTheDocument();
  });

  it("adds the shopping list after Library when the toggle is on", async () => {
    render(<AppMenu voice="plain" shoppingList />);
    await userEvent.click(screen.getByRole("button", { name: /menu/i }));
    expect(screen.getByRole("link", { name: /Shopping list/ })).toHaveAttribute(
      "href",
      "/shopping",
    );
    // Placed with the other content destinations rather than at the end: Settings
    // and Help close the menu, and an entry after them reads as administration.
    expect(screen.getAllByRole("link").map((el) => el.textContent)).toEqual([
      "Inbox",
      "Focus Timer",
      "Library",
      "Shopping list",
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

/**
 * #117 — WCAG 2.4.11 Focus Appearance, which is AA in WCAG 2.2 and which **axe
 * does not implement**. The repo's contrast gate, guest-surface scans and axe
 * baseline all passed on the broken version, so this is not a belt-and-braces
 * duplicate of an e2e assertion — it is the only run-time check that exists.
 *
 * `a11y-class-hygiene.test.ts` enforces the same thing on the source string. This
 * asserts it on the DOM node a keyboard user actually lands on, which is the part
 * a refactor (moving the classes onto a wrapper, say) could silently break.
 */
describe("AppMenu — menu entries have a real focus indicator (#117)", () => {
  it("gives every entry an indicator that is not solely a background swap", async () => {
    render(<AppMenu voice="plain" />);
    await userEvent.click(screen.getByRole("button", { name: /menu/i }));
    const entries = screen.getAllByRole("link");
    expect(entries.length).toBeGreaterThan(0);
    for (const entry of entries) {
      // The old style was `outline-none` + `focus-visible:bg-muted` and nothing
      // else — --muted against --background is 1.07:1 in light, 1.17:1 in dark.
      expect(entry.className).toContain("focus-visible:inset-ring-2");
      expect(entry.className).toContain("focus-visible:inset-ring-ring");
    }
  });

  it("keeps the background swap as well, so the hover affordance is unchanged", async () => {
    render(<AppMenu voice="plain" />);
    await userEvent.click(screen.getByRole("button", { name: /menu/i }));
    const entry = screen.getByRole("link", { name: /Inbox/ });
    expect(entry.className).toContain("hover:bg-muted");
    expect(entry.className).toContain("focus-visible:bg-muted");
  });
});
