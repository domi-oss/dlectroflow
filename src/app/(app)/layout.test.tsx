// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import AppLayout from "./layout";
import { isOwnerRequest } from "@/lib/workspace";

// next/link → plain <a> (same idiom as help.test.tsx) so the header's links
// resolve under vitest (no Next compiler).
vi.mock("next/link", () => ({
  default: ({
    children,
    href,
  }: {
    children: React.ReactNode;
    href: string;
  }) => <a href={href}>{children}</a>,
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
  isOwnerRequest: vi.fn(),
  currentWorkspaceId: vi.fn().mockResolvedValue("owner"),
}));

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
    vi.mocked(isOwnerRequest).mockResolvedValue(false);
    render(await AppLayout({ children: child }));

    const toggle = screen.getByRole("button", { name: /mode/i });
    expect(toggle.closest("header")).not.toBeNull();
  });

  it("places the toggle immediately left of the guest 'Owner sign in' action", async () => {
    vi.mocked(isOwnerRequest).mockResolvedValue(false);
    render(await AppLayout({ children: child }));

    const toggle = screen.getByRole("button", { name: /mode/i });
    const signIn = screen.getByRole("link", { name: /owner sign in/i });

    // Both are direct children of the same header right-cluster …
    expect(toggle.parentElement).toBe(signIn.parentElement);
    // … and the toggle is the sign-in action's immediate previous sibling,
    // i.e. it renders immediately to its left in the LTR flex row.
    expect(toggle.nextElementSibling).toBe(signIn);
  });

  it("places the toggle immediately left of the owner 'Sign out' action", async () => {
    vi.mocked(isOwnerRequest).mockResolvedValue(true);
    render(await AppLayout({ children: child }));

    const toggle = screen.getByRole("button", { name: /mode/i });
    const signOut = screen.getByRole("button", { name: /sign out/i });
    // Sign out is a POST-only <form> button; the form is the cluster child.
    const signOutForm = signOut.closest("form");
    expect(signOutForm).not.toBeNull();
    expect(toggle.parentElement).toBe(signOutForm!.parentElement);
    expect(toggle.nextElementSibling).toBe(signOutForm);
  });

  it("keeps the toggle keyboard-operable with a visible focus ring", async () => {
    vi.mocked(isOwnerRequest).mockResolvedValue(false);
    render(await AppLayout({ children: child }));

    const toggle = screen.getByRole("button", { name: /mode/i });
    // Real <button> → tabbable; focus-visible ring class present (a11y, #40).
    expect(toggle.tagName).toBe("BUTTON");
    expect(toggle).not.toHaveAttribute("tabindex", "-1");
    expect(toggle.className).toContain("focus-visible:ring-2");
    expect(toggle).toHaveAttribute("aria-pressed");
  });
});
