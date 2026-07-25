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
