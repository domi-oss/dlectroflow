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
//
// #100 — the account row now carries the handle and the provider too, because
// the header has to say WHICH account you are signed in as. Both shapes are
// fixtures here rather than one, since owner and member are two of the three
// states the header must read sensibly in (guest is `null`).
const SIGNED_IN = {
  id: "u1",
  role: "owner" as const,
  workspaceId: "owner",
  provider: "gitlab",
  handle: "gitlab_dlectronique",
};

const MEMBER = {
  id: "u2",
  role: "member" as const,
  workspaceId: "ws-u2",
  provider: "gitlab",
  handle: "dlectronique",
};

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

  it("places the toggle immediately left of the signed-in identity action", async () => {
    vi.mocked(currentUser).mockResolvedValue(SIGNED_IN);
    render(await AppLayout({ children: child }));

    const toggle = screen.getByRole("button", { name: /mode/i });
    const identity = screen.getByRole("button", { name: /^account:/i });
    // The identity control brings its own positioned wrapper (it anchors a
    // popover), so it is that wrapper — not the button — that is the cluster's
    // child, exactly like the menu trigger next to it.
    const wrapper = identity.parentElement!;
    expect(toggle.parentElement).toBe(wrapper.parentElement);
    expect(toggle.nextElementSibling).toBe(wrapper);
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

// #100 — "the header gives no indication of who you are signed in as".
//
// These specs are about the HEADER's job: resolving identity server-side and
// putting it in the bar. What the control then says is account-menu.test.tsx's.
describe("AppLayout — header identity (#100)", () => {
  /** The cluster the theme toggle, the identity control and the menu share. */
  async function headerCluster(): Promise<HTMLElement> {
    render(await AppLayout({ children: child }));
    return screen.getByRole("button", { name: /mode/i })
      .parentElement as HTMLElement;
  }

  it("shows the signed-in owner's handle in the header", async () => {
    vi.mocked(currentUser).mockResolvedValue(SIGNED_IN);
    const cluster = await headerCluster();
    expect(cluster).toHaveTextContent("gitlab_dlectronique");
  });

  it("shows a member their OWN handle, not the owner's", async () => {
    vi.mocked(currentUser).mockResolvedValue(MEMBER);
    const cluster = await headerCluster();
    expect(cluster).toHaveTextContent("dlectronique");
    expect(cluster).not.toHaveTextContent("gitlab_dlectronique");
  });

  // The third state. A guest has no account, so there is no handle to show and
  // nothing that looks like one — their header is the one that shipped.
  it("shows a guest no handle and no identity control", async () => {
    vi.mocked(currentUser).mockResolvedValue(null);
    const cluster = await headerCluster();
    expect(
      screen.queryByRole("button", { name: /^account:/i }),
    ).not.toBeInTheDocument();
    expect(cluster).toHaveTextContent("Sign in");
    expect(cluster.textContent).not.toMatch(/dlectronique/);
  });

  // The identity comes from the SERVER-RESOLVED session and nowhere else: the
  // layout is an async server component reading currentUser(), which verifies
  // the signed cookie and re-reads the row (role + status) on every request. No
  // client-supplied value can reach it, and the layout never takes a prop that
  // could carry one.
  it("reads the identity from currentUser(), once per request", async () => {
    vi.mocked(currentUser).mockResolvedValue(SIGNED_IN);
    render(await AppLayout({ children: child }));
    expect(currentUser).toHaveBeenCalledTimes(1);
  });

  // #100's constraint, made mechanical: the bar is collision-prone at 390px
  // (#72, #92, #103), so naming the account must not add an element. It replaces
  // two — "Account" and "Sign out" both moved into the popover — so the
  // signed-in cluster is now the SAME width as a guest's.
  it("adds no element to the header — three controls, signed in or not", async () => {
    vi.mocked(currentUser).mockResolvedValue(SIGNED_IN);
    expect((await headerCluster()).children).toHaveLength(3);
    cleanup();
    vi.mocked(currentUser).mockResolvedValue(null);
    expect((await headerCluster()).children).toHaveLength(3);
  });

  it("puts the identity control between the theme toggle and the menu", async () => {
    vi.mocked(currentUser).mockResolvedValue(SIGNED_IN);
    const cluster = await headerCluster();
    const toggle = screen.getByRole("button", { name: /mode/i });
    const identity = screen.getByRole("button", { name: /^account:/i });
    const menu = screen.getByTestId("app-menu");

    for (const el of [toggle, identity, menu]) {
      expect(cluster).toContainElement(el);
    }
    // Document order == left-to-right order in this LTR flex row.
    const follows = (a: Node, b: Node) =>
      Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
    expect(follows(toggle, identity)).toBe(true);
    expect(follows(identity, menu)).toBe(true);
  });

  // The header must not become a second place that shows account internals.
  // Everything a signed-in header renders comes from AccountIdentity, which
  // identity.test.ts pins to { label, provider, role } — no id, no email.
  it("puts no account id or email in the header", async () => {
    vi.mocked(currentUser).mockResolvedValue({
      ...SIGNED_IN,
      id: "cuid-secret-1234",
    });
    const cluster = await headerCluster();
    expect(cluster.innerHTML).not.toContain("cuid-secret-1234");
    expect(cluster.innerHTML).not.toContain("@");
  });
});
