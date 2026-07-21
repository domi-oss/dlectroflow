// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { BackToInbox } from "@/components/nav/back-to-inbox";

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

describe("BackToInbox", () => {
  it("links to /inbox", () => {
    render(<BackToInbox voice="plain" />);
    expect(screen.getByRole("link")).toHaveAttribute("href", "/inbox");
  });

  it("renders the plain voice-aware label with the ← affordance", () => {
    render(<BackToInbox voice="plain" />);
    const link = screen.getByRole("link");
    expect(link).toHaveTextContent("←");
    expect(link).toHaveTextContent("Back to inbox");
  });

  it("is voice-aware: playful voice renders the playful copy", () => {
    render(<BackToInbox voice="playful" />);
    const link = screen.getByRole("link");
    expect(link).toHaveTextContent("←");
    expect(link).toHaveTextContent("🍳 Back to inbox");
  });
});
