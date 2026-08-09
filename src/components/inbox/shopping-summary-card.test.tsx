// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ShoppingSummaryCard } from "@/components/inbox/shopping-summary-card";

const { dismissMock, refreshMock } = vi.hoisted(() => ({
  dismissMock: vi.fn().mockResolvedValue(undefined),
  refreshMock: vi.fn(),
}));
vi.mock("@/app/actions/shopping", () => ({
  dismissShoppingSummary: dismissMock,
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: refreshMock }),
}));
vi.mock("next/link", () => ({
  default: ({
    children,
    href,
    ...rest
  }: {
    children: React.ReactNode;
    href: string;
  }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

beforeEach(() => vi.clearAllMocks());
afterEach(cleanup);

describe("ShoppingSummaryCard", () => {
  it("hotlinks to the list, with the count in the link's own name", () => {
    render(<ShoppingSummaryCard count={3} voice="plain" />);
    const link = screen.getByRole("link", {
      name: /3 items on your shopping list/i,
    });
    expect(link).toHaveAttribute("href", "/shopping");
  });

  it("says one item, not 1 items", () => {
    render(<ShoppingSummaryCard count={1} voice="plain" />);
    expect(
      screen.getByRole("link", { name: /1 item on your shopping list/i }),
    ).toBeInTheDocument();
  });

  it("dismisses, and says it will be back", async () => {
    render(<ShoppingSummaryCard count={2} voice="plain" />);
    // The hint is part of the contract, not decoration: without it "Not now" reads
    // as a delete, and the row is the only place the returning behaviour is
    // explained.
    expect(screen.getByText(/back when the list grows/i)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /not now/i }));
    expect(dismissMock).toHaveBeenCalledTimes(1);
  });

  // "Not now" on its own is indistinguishable from every other dismiss control in
  // a screen reader's element list, and this card sits above an inbox full of rows.
  it("names what it is dismissing", () => {
    render(<ShoppingSummaryCard count={2} voice="plain" />);
    expect(
      screen.getByRole("button", { name: /2 items on your shopping list/i }),
    ).toBeInTheDocument();
  });

  // Duo review, !295 — the hint was `hidden sm:inline`, so the one explanation of
  // what "Not now" does never rendered on the viewports this app is built for, which
  // contradicted the reasoning in the code right above it. Asserted on the CLASS as
  // well as on presence, because `getByText` finds an element that CSS is hiding.
  it("never hides the hint behind a breakpoint", () => {
    render(<ShoppingSummaryCard count={2} voice="plain" />);
    const hint = screen.getByText(/back when the list grows/i);
    expect(hint.className).not.toContain("hidden");
    expect(hint.className).not.toContain("sm:inline");
  });

  // Duo review, !295 — the pending flag from `useTransition` was discarded, so
  // nothing guarded the control while the dismiss was in flight and a fast double
  // press fired `dismissShoppingSummary()` and `router.refresh()` twice.
  //
  // The action is held open with a deferred promise rather than left to resolve on
  // its own, because the bug only exists inside that window: let the first press
  // settle and the second is a legitimate press of a control that is idle again,
  // and the test would pass against the unguarded component.
  it("fires one dismiss when the control is double-pressed", async () => {
    let settle!: () => void;
    dismissMock.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          settle = resolve;
        }),
    );
    render(<ShoppingSummaryCard count={2} voice="plain" />);
    const button = screen.getByRole("button", { name: /not now/i });

    await userEvent.click(button);
    await userEvent.click(button);

    expect(dismissMock).toHaveBeenCalledTimes(1);
    // Still true after the refused second press: the first is still in flight.
    expect(button).toHaveAttribute("aria-disabled", "true");

    await act(async () => settle());
    expect(refreshMock).toHaveBeenCalledTimes(1);
  });

  // `aria-disabled`, not `disabled` — the same call `inbox-view.tsx` makes on the
  // capture Retry CTA, and for the same reason: a `disabled` element cannot hold
  // focus, so the browser drops it to <body> the instant the press lands and a
  // keyboard user loses their place mid-interaction. The press is refused in the
  // handler instead, which is what the double-press test above proves.
  it("keeps the control focusable while the dismiss is in flight", async () => {
    let settle!: () => void;
    dismissMock.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          settle = resolve;
        }),
    );
    render(<ShoppingSummaryCard count={2} voice="plain" />);
    const button = screen.getByRole("button", { name: /not now/i });

    await userEvent.click(button);
    expect(button).not.toHaveAttribute("disabled");
    expect(button).toHaveFocus();

    await act(async () => settle());
  });

  // Duo review, !295 — the hint used to say the line comes back "when you add
  // something", which is ONE of the three writes `syncShoppingSummary` resurfaces
  // on: adding an item, un-ticking one, and pulling one back up from
  // saved-for-later. This card is the only place the codebase explains what "Not
  // now" does, so a user who un-ticks something and sees the line return had been
  // told, here, that it would not.
  //
  // Asserted for EVERY voice: a hint that is honest in `plain` and wrong in
  // `playful` is a contradiction only some users can see, which is worse than one
  // everybody can.
  it.each(["plain", "playful"] as const)(
    "promises the rule rather than one of its triggers (%s voice)",
    (voice) => {
      render(<ShoppingSummaryCard count={2} voice={voice} />);
      const hint = screen.getByText(/back when the list grows/i);
      expect(hint).toBeInTheDocument();
      expect(hint.textContent).not.toMatch(/\badd\b/i);
    },
  );

  it("speaks the playful voice (#86)", () => {
    render(<ShoppingSummaryCard count={2} voice="playful" />);
    expect(screen.getByRole("link", { name: /🛒/ })).toBeInTheDocument();
  });

  // The card is app-generated, so it must not present itself as a captured item:
  // no tick, no rename, no move-to, no delete. Those all mean something to a
  // BrainDumpItem row and nothing here.
  it("offers no row controls beyond the link and the dismissal", () => {
    render(<ShoppingSummaryCard count={2} voice="plain" />);
    expect(screen.queryByRole("checkbox")).toBeNull();
    expect(screen.getAllByRole("button")).toHaveLength(1);
    expect(screen.getAllByRole("link")).toHaveLength(1);
  });
});
