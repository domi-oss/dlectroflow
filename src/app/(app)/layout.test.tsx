// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import type { ReactNode } from "react";
import AppLayout from "./layout";
import { currentUser } from "@/lib/workspace";
import { getSettings } from "@/lib/db";

// next/link → plain <a> (same idiom as help.test.tsx) so the header's links
// resolve under vitest (no Next compiler).
//
// #252 — the rest of the props are spread through, not dropped. The quick-access
// links carry their accessible name on the anchor itself (`aria-label`/`title`),
// so a mock that forwarded only `href` and `children` would render two unnamed
// links and every name-based query here would fail for a reason that has nothing
// to do with the component (#160's class of trap).
vi.mock("next/link", () => ({
  default: ({
    children,
    href,
    ...rest
  }: {
    children: ReactNode;
    href: string;
  }) => (
    <a href={href} {...rest}>
      {children}
    </a>
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
  getSettings: vi.fn(),
}));

/**
 * The Settings row the header reads, as a function of the two #252 gates.
 *
 * Set per test rather than baked into the module factory, because both gates are
 * now things the header BRANCHES on — a fixed factory value could only ever
 * exercise one arm, and the arm it exercised would be invisible at the call
 * site. Every field the layout actually reads is present: a factory mock that
 * silently omits one is #160, and the symptom is a nav test that passes
 * suspiciously easily.
 */
function settingsWith(
  gates: { shoppingList?: boolean; focusQuickAccess?: boolean } = {},
) {
  vi.mocked(getSettings).mockResolvedValue({
    voice: "plain",
    completeStrikethrough: true,
    completeTickColor: "green",
    typeface: "figtree",
    notifyDailyReview: false,
    dailyReviewNudgeTime: "18:00",
    shoppingList: false,
    focusQuickAccess: false,
    ...gates,
    // The layout reads only the fields above; the row is far wider, and casting
    // is how every other test here stays about the header rather than about the
    // schema.
  } as unknown as Awaited<ReturnType<typeof getSettings>>);
}

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
  // #252 — null, i.e. every account the day the migration lands. The header
  // must be unchanged for them.
  displayName: null as string | null,
};

const MEMBER = {
  id: "u2",
  role: "member" as const,
  workspaceId: "ws-u2",
  provider: "gitlab",
  handle: "dlectronique",
  displayName: null as string | null,
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

// `vi.clearAllMocks()` clears CALLS, not implementations, so the resolved value
// is re-seeded here rather than once at module scope — otherwise a test that
// flipped a gate would silently set it for every test after it.
beforeEach(() => settingsWith());

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

  // #100's constraint, still mechanical and still true of #100's own change:
  // naming the account adds no element, because it replaced two ("Account" and
  // "Sign out" both moved into the popover), so a signed-in cluster is the same
  // width as a guest's.
  //
  // #252 amended what the number is a function of. It is now the two quick-access
  // gates and nothing else — identity state still does not move it. Asserted with
  // both gates OFF so the claim stays "identity costs nothing", which is what
  // #100 was about; the gates' own arithmetic is the block below.
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
    // The id is checked against the MARKUP (it could hide in an attribute);
    // "no email" is checked against the rendered TEXT, because Tailwind v4's
    // container-query variants put a literal `@` in class names and asserting
    // on innerHTML would start failing the day one is used here — a false
    // positive on a security assertion is worse than no assertion.
    expect(cluster.innerHTML).not.toContain("cuid-secret-1234");
    expect(cluster.textContent).not.toContain("@");
  });
});

// #252 — "the nav shows a provider handle and hides shopping and focus".
//
// Two halves, and they fail in opposite directions. The name half is about an
// account that has NOT set one still rendering exactly as it did (the migration
// leaves every existing row null, so that is not the edge case — it is the
// default). The quick-access half is about two icons appearing only when their
// gate says so, and about them costing nothing: both gates are already in the
// `settings` row the layout reads for the voice.
describe("AppLayout — header quick access (#252)", () => {
  const FOCUS = /^Focus Timer$/;
  const SHOPPING = /^Shopping list$/;

  async function headerCluster(): Promise<HTMLElement> {
    render(await AppLayout({ children: child }));
    return screen.getByRole("button", { name: /mode/i })
      .parentElement as HTMLElement;
  }

  it("puts a focus-timer shortcut in the bar when the setting is on", async () => {
    vi.mocked(currentUser).mockResolvedValue(SIGNED_IN);
    settingsWith({ focusQuickAccess: true });
    const cluster = await headerCluster();
    const link = screen.getByRole("link", { name: FOCUS });
    expect(link).toHaveAttribute("href", "/focus");
    expect(cluster).toContainElement(link);
  });

  it("leaves it out when the setting is off", async () => {
    vi.mocked(currentUser).mockResolvedValue(SIGNED_IN);
    settingsWith({ focusQuickAccess: false });
    await headerCluster();
    expect(screen.queryByRole("link", { name: FOCUS })).toBeNull();
  });

  it("puts a trolley in the bar when shopping-list mode is on", async () => {
    vi.mocked(currentUser).mockResolvedValue(SIGNED_IN);
    settingsWith({ shoppingList: true });
    const cluster = await headerCluster();
    const link = screen.getByRole("link", { name: SHOPPING });
    expect(link).toHaveAttribute("href", "/shopping");
    expect(cluster).toContainElement(link);
  });

  it("leaves the trolley out when shopping-list mode is off", async () => {
    vi.mocked(currentUser).mockResolvedValue(SIGNED_IN);
    settingsWith({ shoppingList: false });
    await headerCluster();
    expect(screen.queryByRole("link", { name: SHOPPING })).toBeNull();
  });

  // A guest has no account but does have a workspace and a Settings row, so the
  // gates mean the same thing for them. Nothing here is account-scoped.
  it("gives a guest the same shortcuts their workspace asked for", async () => {
    vi.mocked(currentUser).mockResolvedValue(null);
    settingsWith({ shoppingList: true, focusQuickAccess: true });
    await headerCluster();
    expect(screen.getByRole("link", { name: FOCUS })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: SHOPPING })).toBeInTheDocument();
  });

  // Left-to-right: the two destinations, the theme toggle, the account, the
  // menu. Destinations lead because they are what you came to press; the theme
  // toggle keeps its #100 position immediately left of the identity action, and
  // the menu stays last.
  it("orders the cluster: focus, shopping, theme, account, menu", async () => {
    vi.mocked(currentUser).mockResolvedValue(SIGNED_IN);
    settingsWith({ shoppingList: true, focusQuickAccess: true });
    const cluster = await headerCluster();
    const identity = screen.getByRole("button", { name: /^account:/i });
    expect(
      [...cluster.children].map(
        (el) =>
          el.getAttribute("aria-label") ??
          (el.contains(identity) ? "account" : el.getAttribute("data-testid")),
      ),
    ).toEqual([
      "Focus Timer",
      "Shopping list",
      "Switch to dark mode",
      "account",
      "app-menu",
    ]);
  });

  // The width arithmetic the issue set, made mechanical. Five is the ceiling and
  // three is the floor; the MEASURED consequence at 360px is
  // e2e/smoke/header-quick-access.spec.ts, because a class name is not a layout.
  it("holds at most five controls, and three when both gates are off", async () => {
    vi.mocked(currentUser).mockResolvedValue(SIGNED_IN);
    settingsWith({ shoppingList: true, focusQuickAccess: true });
    expect((await headerCluster()).children).toHaveLength(5);
    cleanup();
    settingsWith({ shoppingList: false, focusQuickAccess: false });
    expect((await headerCluster()).children).toHaveLength(3);
  });

  // The issue's "no new network call" constraint. `getSettings` was already
  // being read for the voice, and both gates are columns on that same row, so
  // the shortcuts are free.
  it("reads Settings once, and adds no second query", async () => {
    vi.mocked(currentUser).mockResolvedValue(SIGNED_IN);
    settingsWith({ shoppingList: true, focusQuickAccess: true });
    await headerCluster();
    expect(getSettings).toHaveBeenCalledTimes(1);
    expect(currentUser).toHaveBeenCalledTimes(1);
  });
});

describe("AppLayout — header shows a chosen name (#252)", () => {
  async function headerCluster(): Promise<HTMLElement> {
    render(await AppLayout({ children: child }));
    return screen.getByRole("button", { name: /mode/i })
      .parentElement as HTMLElement;
  }

  it("greets the owner by the name they chose, not by the provider handle", async () => {
    vi.mocked(currentUser).mockResolvedValue({
      ...SIGNED_IN,
      displayName: "Domi",
    });
    const cluster = await headerCluster();
    expect(cluster).toHaveTextContent("Domi");
    expect(cluster).not.toHaveTextContent("gitlab_dlectronique");
    // WCAG 2.5.3 — the visible words are contained in the accessible name, so
    // voice control can address what it can see.
    expect(
      screen.getByRole("button", { name: "Account: Domi" }),
    ).toBeInTheDocument();
  });

  // The default state of every account on the day this ships.
  it("is unchanged for an account that never set one", async () => {
    vi.mocked(currentUser).mockResolvedValue(SIGNED_IN);
    const cluster = await headerCluster();
    expect(cluster).toHaveTextContent("gitlab_dlectronique");
    expect(
      screen.getByRole("button", { name: "Account: gitlab_dlectronique" }),
    ).toBeInTheDocument();
  });

  it("shows a member their own chosen name, never the owner's", async () => {
    vi.mocked(currentUser).mockResolvedValue({
      ...MEMBER,
      displayName: "Sam",
    });
    const cluster = await headerCluster();
    expect(cluster).toHaveTextContent("Sam");
    expect(cluster.textContent).not.toMatch(/dlectronique/);
  });
});
