// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { BackLink } from "@/components/nav/back-link";

// Render <Link> as a plain <a> so the link's href/text can be asserted without a
// router context (mirrors the next/link mock in help.test.tsx / library.test.tsx).
vi.mock("next/link", () => ({
  default: ({
    children,
    href,
    className,
  }: {
    children: React.ReactNode;
    href: string;
    className?: string;
  }) => (
    <a href={href} className={className}>
      {children}
    </a>
  ),
}));

afterEach(cleanup);

describe("BackLink", () => {
  it("defaults to the inbox with the ← affordance when `from` is absent", () => {
    render(<BackLink voice="plain" />);
    const link = screen.getByRole("link");
    expect(link).toHaveAttribute("href", "/inbox");
    expect(link).toHaveTextContent("←");
    expect(link).toHaveTextContent("Back to inbox");
  });

  it("is voice-aware: playful voice renders the playful inbox copy", () => {
    render(<BackLink voice="playful" />);
    expect(screen.getByRole("link")).toHaveTextContent("🍳 Back to inbox");
  });

  it("resolves a whitelisted origin (library) to its target + label", () => {
    render(<BackLink from="library" voice="plain" />);
    const link = screen.getByRole("link");
    expect(link).toHaveAttribute("href", "/library?tab=sorted");
    expect(link).toHaveTextContent("Back to Library");
  });

  it("resolves settings and help origins", () => {
    const { rerender } = render(<BackLink from="settings" voice="plain" />);
    expect(screen.getByRole("link")).toHaveAttribute("href", "/settings");
    expect(screen.getByRole("link")).toHaveTextContent("Back to Settings");
    rerender(<BackLink from="help" voice="plain" />);
    expect(screen.getByRole("link")).toHaveAttribute("href", "/help");
    expect(screen.getByRole("link")).toHaveTextContent("Back to Help");
  });

  it("falls back to the inbox for an unknown/hostile origin (no open redirect)", () => {
    render(<BackLink from="https://evil.example.com" voice="plain" />);
    expect(screen.getByRole("link")).toHaveAttribute("href", "/inbox");
  });

  it("falls back to the inbox for an inherited prototype key (no crash)", () => {
    render(<BackLink from="__proto__" voice="plain" />);
    expect(screen.getByRole("link")).toHaveAttribute("href", "/inbox");
  });
});
