// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { BackLink } from "@/components/nav/back-link";

// Render <Link> as a plain <a> so the link's href/text can be asserted without a
// router context (mirrors the next/link mock in help.test.tsx / library.test.tsx).
// The rest of the props are spread through rather than picked, so the component's
// own attributes (className, #131's `data-back-link`) reach the DOM.
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
    expect(
      screen.getByRole("link").textContent?.replace(/\s+/g, " ").trim(),
    ).toBe("← Back");
  });

  it("defaults the DESTINATION to the inbox when `from` is absent", () => {
    render(<BackLink voice="plain" />);
    expect(screen.getByRole("link")).toHaveAttribute("href", "/");
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
    expect(screen.getByRole("link")).toHaveAttribute("href", "/");
  });

  it("falls back to the inbox for an inherited prototype key (no crash)", () => {
    render(<BackLink from="__proto__" voice="plain" />);
    expect(screen.getByRole("link")).toHaveAttribute("href", "/");
  });

  // #131 — the sticky <SectionNav> bar needs the same control in a compact
  // shape. A VARIANT rather than a second component, because the thing that
  // must not fork is the recipe: the origin whitelist, the fallback and the
  // label are resolved once, here, for both.
  describe("variants (#131)", () => {
    it("resolves the same destination and reads the same label in the bar", () => {
      const { rerender } = render(
        <BackLink from="help" voice="plain" variant="page" />,
      );
      const page = screen.getByRole("link");
      expect(page).toHaveAttribute("href", "/help");
      expect(page).toHaveAccessibleName("← Back");

      rerender(<BackLink from="help" voice="plain" variant="bar" />);
      const bar = screen.getByRole("link");
      expect(bar).toHaveAttribute("href", "/help");
      expect(bar).toHaveAccessibleName("← Back");
    });

    it("applies the whitelist in the bar too — no open redirect either way", () => {
      render(
        <BackLink
          from="https://evil.example.com"
          variant="bar"
          voice="plain"
        />,
      );
      expect(screen.getByRole("link")).toHaveAttribute("href", "/");
    });

    it("labels which copy it is, so the two are separable on a page carrying both", () => {
      // Both pages keep the full-width control at the top AND the compact one in
      // the bar, so tests (and only tests) need a way to name one of them.
      const { rerender } = render(<BackLink voice="plain" />);
      expect(screen.getByRole("link")).toHaveAttribute(
        "data-back-link",
        "page",
      );
      rerender(<BackLink voice="plain" variant="bar" />);
      expect(screen.getByRole("link")).toHaveAttribute("data-back-link", "bar");
    });

    it("clears the 44px touch target in the bar, and keeps a focus ring in both", () => {
      // Layout is e2e's job (jsdom has none), but the classes that produce it
      // are this component's: the bar sits on a phone screen where every control
      // in it is a tap target, and a control with no visible focus state is a
      // keyboard trap in all but name.
      const { rerender } = render(<BackLink voice="plain" variant="bar" />);
      const bar = screen.getByRole("link");
      expect(bar.className).toContain("min-h-11");
      expect(bar.className).toContain("focus-visible:ring-2");

      rerender(<BackLink voice="plain" />);
      expect(screen.getByRole("link").className).toContain(
        "focus-visible:ring-2",
      );
    });
  });
});
