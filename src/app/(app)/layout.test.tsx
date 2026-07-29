// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import type { ReactNode } from "react";
import AppLayout from "./layout";
import { currentUser } from "@/lib/workspace";

// next/link → plain <a> (same idiom as help.test.tsx) so the header's links
// resolve under vitest (no Next compiler).
vi.mock("next/link", () => ({
  default: ({ children, href }: { children: ReactNode; href: string }) => (
    <a href={href}>{children}</a>
  ),
}));

vi.mock("next/headers", () => ({
  headers: vi.fn().mockResolvedValue(new Headers()),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    workspace: {
      findUnique: vi
        .fn()
        .mockResolvedValue({ expiresAt: new Date("2099-01-01") }),
    },
  },
  getSettings: vi.fn().mockResolvedValue({
    voice: "plain",
    completeStrikethrough: true,
    completeTickColor: "green",
    typeface: "figtree",
    notifyDailyReview: false,
    dailyReviewNudgeTime: "18:00",
  }),
}));

vi.mock("@/lib/workspace", () => ({
  currentUser: vi.fn(),
  currentWorkspaceId: vi.fn().mockResolvedValue("owner"),
}));

// #35 Phase A — the header's auth affordance moved into its own component so
// it is unit-testable (src/components/nav/auth-actions.test.tsx). These specs
// stay about PLACEMENT within the header, so the real component renders.
const SIGNED_IN = { id: "u1", role: "owner" as const, workspaceId: "owner" };

vi.mock("@/lib/guest-quota", () => ({
  clientIpHash: vi.fn().mockReturnValue("hash"),
  guestQuotaConfig: vi.fn().mockReturnValue({ quota: 5 }),
  peekGuestAllowance: vi.fn().mockResolvedValue({ remaining: 5 }),
}));

// Peripheral shell children are stubbed so the test stays on toggle PLACEMENT
// and off their client-only side effects (sessionStorage / service worker /
// router). The ThemeToggle itself is intentionally NOT mocked — we assert the
// real component's position in the header.
vi.mock("@/components/guest/guest-indicator", () => ({
  GuestIndicator: () => <div data-testid="guest-indicator" />,
}));
vi.mock("@/components/dashboard/review-nudge", () => ({
  ReviewNudge: () => null,
}));
vi.mock("@/components/nav/app-menu", () => ({
  AppMenu: () => <div data-testid="app-menu" />,
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  document.documentElement.classList.remove("dark");
});

const child = <div>child</div>;

describe("AppLayout — header theme toggle (#49)", () => {
  it("renders the theme toggle inside the app header", async () => {
    vi.mocked(currentUser).mockResolvedValue(null);
    render(await AppLayout({ children: child }));

    const toggle = screen.getByRole("button", { name: /mode/i });
    expect(toggle.closest("header")).not.toBeNull();
  });

  it("places the toggle immediately left of the guest 'Sign in' action", async () => {
    vi.mocked(currentUser).mockResolvedValue(null);
    render(await AppLayout({ children: child }));

    const toggle = screen.getByRole("button", { name: /mode/i });
    const signIn = screen.getByRole("link", { name: /sign in/i });

    // Both are direct children of the same header right-cluster …
    expect(toggle.parentElement).toBe(signIn.parentElement);
    // … and the toggle is the sign-in action's immediate previous sibling,
    // i.e. it renders immediately to its left in the LTR flex row.
    expect(toggle.nextElementSibling).toBe(signIn);
  });

  it("places the toggle immediately left of the signed-in 'Account' action", async () => {
    vi.mocked(currentUser).mockResolvedValue(SIGNED_IN);
    render(await AppLayout({ children: child }));

    const toggle = screen.getByRole("button", { name: /mode/i });
    const account = screen.getByRole("link", { name: /account/i });
    expect(toggle.parentElement).toBe(account.parentElement);
    expect(toggle.nextElementSibling).toBe(account);
  });

  it("keeps sign out in the same header cluster, after Account", async () => {
    vi.mocked(currentUser).mockResolvedValue(SIGNED_IN);
    render(await AppLayout({ children: child }));

    const toggle = screen.getByRole("button", { name: /mode/i });
    const account = screen.getByRole("link", { name: /account/i });
    // Sign out is a POST-only <form> button; the form is the cluster child.
    const signOutForm = screen
      .getByRole("button", { name: /sign out/i })
      .closest("form");
    expect(signOutForm).not.toBeNull();
    expect(toggle.parentElement).toBe(signOutForm!.parentElement);
    expect(account.nextElementSibling).toBe(signOutForm);
  });

  it("shows a guest no sign-out control", async () => {
    vi.mocked(currentUser).mockResolvedValue(null);
    render(await AppLayout({ children: child }));
    expect(
      screen.queryByRole("button", { name: /sign out/i }),
    ).not.toBeInTheDocument();
  });

  it("keeps the toggle keyboard-operable with a visible focus ring", async () => {
    vi.mocked(currentUser).mockResolvedValue(null);
    render(await AppLayout({ children: child }));

    const toggle = screen.getByRole("button", { name: /mode/i });
    // Real <button> → tabbable; focus-visible ring class present (a11y, #40).
    expect(toggle.tagName).toBe("BUTTON");
    expect(toggle).not.toHaveAttribute("tabindex", "-1");
    expect(toggle.className).toContain("focus-visible:ring-2");
    expect(toggle).toHaveAttribute("aria-pressed");
  });

  // #103 — the header takes the icon-only variant: in a menu bar the words are
  // dead weight and widen the button enough to crowd the bar at 390px. The
  // variant is a prop, so this asserts the header actually asks for it.
  it("takes the icon-only variant, with the name carried by aria-label", async () => {
    vi.mocked(currentUser).mockResolvedValue(null);
    render(await AppLayout({ children: child }));

    const toggle = screen.getByRole("button", { name: "Switch to dark mode" });
    expect(toggle.textContent).toBe("");
    expect(toggle.querySelector("svg")).not.toBeNull();
    expect(toggle).toHaveAttribute("title", "Switch to dark mode");
    // ≥44px both ways, so an icon button is no harder to hit than the old text
    // one (WCAG 2.5.5).
    expect(toggle.className).toContain("min-h-11");
    expect(toggle.className).toContain("min-w-11");
  });
});
