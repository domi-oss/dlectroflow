// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import HelpPage from "./page";

vi.mock("next/link", () => ({
  default: ({
    children,
    href,
  }: {
    children: React.ReactNode;
    href: string;
  }) => <a href={href}>{children}</a>,
}));
vi.mock("@/lib/db", () => ({
  getSettings: vi.fn().mockResolvedValue({ voice: "plain" }),
}));
vi.mock("@/lib/workspace", () => ({
  currentWorkspaceId: vi.fn().mockResolvedValue("owner"),
}));

afterEach(cleanup);

describe("HelpPage", () => {
  it("renders the getting-started guide sections", async () => {
    render(await HelpPage({ searchParams: Promise.resolve({}) }));
    expect(
      screen.getByRole("heading", { name: /Help & getting started/i }),
    ).toBeInTheDocument();
    for (const heading of [
      /Getting started/i,
      /The inbox & freshness/i,
      /Task breakdown/i,
      /Voice & settings/i,
      /Guests & AI limits/i,
    ]) {
      expect(
        screen.getByRole("heading", { name: heading, level: 2 }),
      ).toBeInTheDocument();
    }
  });

  it("links to settings (carrying ?from=help) and defaults its back link to the inbox", async () => {
    render(await HelpPage({ searchParams: Promise.resolve({}) }));
    const hrefs = screen
      .getAllByRole("link")
      .map((a) => a.getAttribute("href"));
    // Settings deep-links carry the origin so Settings can offer "Back to Help".
    expect(hrefs).toContain("/settings?from=help");
    // With no `?from=`, the shared back link falls back to the inbox.
    expect(hrefs).toContain("/");
  });

  it("is origin-aware: ?from=settings sends the '← Back' link to Settings", async () => {
    render(
      await HelpPage({ searchParams: Promise.resolve({ from: "settings" }) }),
    );
    // Label is a simple "← Back"; only the destination reflects the origin.
    const back = screen.getByRole("link", { name: /back/i });
    expect(back).toHaveTextContent("← Back");
    expect(back).toHaveAttribute("href", "/settings");
  });
});
