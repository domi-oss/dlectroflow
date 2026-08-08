// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
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
    expect(
      screen.getByText(/back when you add something/i),
    ).toBeInTheDocument();
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
