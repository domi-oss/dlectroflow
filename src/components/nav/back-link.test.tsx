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
  // The visible label is a single, destination-agnostic "← Back" for EVERY
  // origin (only the destination href varies).
  it("always reads '← Back' — no per-origin label, and never the destination name", () => {
    render(<BackLink voice="plain" />);
    const link = screen.getByRole("link");
    expect(link).toHaveTextContent("←");
    expect(link.textContent?.replace(/\s+/g, " ").trim()).toBe("← Back");
    expect(link).not.toHaveTextContent(/inbox|Library|Settings|Help/i);
  });

  it("keeps the '← Back' label in playful voice too (label no longer varies)", () => {
    render(<BackLink from="library" voice="playful" />);
    expect(screen.getByRole("link").textContent?.replace(/\s+/g, " ").trim()).toBe("← Back");
  });

  it("defaults the DESTINATION to the inbox when `from` is absent", () => {
    render(<BackLink voice="plain" />);
    expect(screen.getByRole("link")).toHaveAttribute("href", "/inbox");
  });

  it("resolves whitelisted origins to their DESTINATION (label stays '← Back')", () => {
    const { rerender } = render(<BackLink from="library" voice="plain" />);
    let link = screen.getByRole("link");
    expect(link).toHaveAttribute("href", "/library?tab=sorted");
    expect(link).toHaveTextContent("← Back");

    rerender(<BackLink from="settings" voice="plain" />);
    link = screen.getByRole("link");
    expect(link).toHaveAttribute("href", "/settings");
    expect(link).toHaveTextContent("← Back");

    rerender(<BackLink from="help" voice="plain" />);
    link = screen.getByRole("link");
    expect(link).toHaveAttribute("href", "/help");
    expect(link).toHaveTextContent("← Back");
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
