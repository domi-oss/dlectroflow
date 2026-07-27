// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";

// next/link → plain <a> so we can assert the href in jsdom.
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

import { GuestIndicator } from "./guest-indicator";

const props = {
  remaining: 3,
  quota: 5,
  expiresAt: new Date(Date.now() + 3600_000).toISOString(),
};

beforeEach(() => {
  // This jsdom build doesn't provide sessionStorage (same as localStorage in
  // appearance-section.test); back it with a Map so the dismiss path works.
  const store = new Map<string, string>();
  vi.stubGlobal("sessionStorage", {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => {
      store.set(k, v);
    },
    removeItem: (k: string) => {
      store.delete(k);
    },
    clear: () => store.clear(),
  });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("GuestIndicator banner copy (#73)", () => {
  it("names the lo-fi focus music among the perks", () => {
    const { container } = render(<GuestIndicator {...props} voice="plain" />);
    expect(container.textContent).toMatch(/lo-fi/i);
  });

  it("takes the breakdown allowance from the quota prop, not a hardcoded number", () => {
    const { container } = render(
      <GuestIndicator {...props} quota={7} voice="plain" />,
    );
    expect(container.textContent).toMatch(/7 AI breakdowns/i);
    expect(container.textContent).not.toMatch(/5 AI breakdowns/i);
  });

  it("promises nothing as 'coming soon' — self-hosting and BYO key both shipped", () => {
    const { container } = render(<GuestIndicator {...props} voice="plain" />);
    expect(container.textContent).not.toMatch(/coming soon/i);
    expect(container.textContent).toMatch(/self-host/i);
    expect(container.textContent).toMatch(/own LLM key/i);
  });

  it("states which capabilities are owner-only", () => {
    const { container } = render(<GuestIndicator {...props} voice="plain" />);
    expect(container.textContent).toMatch(/owner-only/i);
    expect(container.textContent).toMatch(/google tasks/i);
  });

  it("lists the perks as a list, not one prose paragraph", () => {
    render(<GuestIndicator {...props} voice="plain" />);
    expect(screen.getAllByRole("listitem").length).toBeGreaterThanOrEqual(4);
  });

  it("keeps decorative emoji to the playful voice (plain gets none in the intro)", () => {
    const plain = render(<GuestIndicator {...props} voice="plain" />);
    expect(plain.container.textContent).not.toMatch(/👋/);
    cleanup();
    const playful = render(<GuestIndicator {...props} voice="playful" />);
    expect(playful.container.textContent).toMatch(/👋/);
  });
});

describe("GuestIndicator dark-mode contrast + target size (#73)", () => {
  // The banner shipped with no `dark:` variants at all, so amber-800 landed on
  // a near-black page at 2.44:1 — well under AA. Pair it the way the aging
  // tiers already do elsewhere (see inbox-view / status-pill).
  it("pairs the expanded banner's amber with an AA-tuned dark variant", () => {
    const { container } = render(<GuestIndicator {...props} voice="plain" />);
    const banner = container.firstElementChild as HTMLElement;
    expect(banner.className).toContain("dark:bg-amber-950/20");
    expect(banner.className).toContain("dark:text-amber-300");
  });

  it("pairs the collapsed pill's amber with an AA-tuned dark variant", () => {
    render(<GuestIndicator {...props} voice="plain" />);
    fireEvent.click(screen.getByRole("button", { name: /dismiss/i }));
    // The pill's accessible name comes from its own text (the `title` is
    // ignored once a button has content), so match on the quota text.
    const pill = screen.getByRole("button", { name: /breakdowns/i });
    expect(pill.className).toContain("dark:text-amber-300");
  });

  it("gives the dismiss control a WCAG 2.2 target size (44px)", () => {
    render(<GuestIndicator {...props} voice="plain" />);
    const dismiss = screen.getByRole("button", { name: /dismiss/i });
    expect(dismiss.className).toContain("h-11");
    expect(dismiss.className).toContain("w-11");
  });
});

describe("GuestIndicator onboarding help banner (#11)", () => {
  it("links guests to the in-app /help docs (plain voice)", () => {
    render(<GuestIndicator {...props} voice="plain" />);
    const link = screen.getByRole("link", { name: /help/i });
    expect(link).toHaveAttribute("href", "/help");
  });

  it("uses the playful CTA copy when the voice is playful", () => {
    render(<GuestIndicator {...props} voice="playful" />);
    expect(screen.getByRole("link", { name: /help/i })).toHaveTextContent("🆘");
  });

  it("collapses on dismiss — banner + help link hidden, compact pill remains", () => {
    render(<GuestIndicator {...props} voice="plain" />);
    fireEvent.click(screen.getByRole("button", { name: /dismiss/i }));
    expect(screen.queryByRole("link", { name: /help/i })).toBeNull();
    // The collapsed pill still surfaces the guest quota.
    expect(screen.getByText(/Guest/)).toBeInTheDocument();
  });
});
