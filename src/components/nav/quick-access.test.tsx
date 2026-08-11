// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import type { ReactNode } from "react";
import { QuickAccess } from "@/components/nav/quick-access";

// next/link → plain <a>, the idiom layout.test.tsx and help.test.tsx use: there
// is no Next compiler under vitest.
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

afterEach(cleanup);

const FOCUS = /^Focus Timer$/;
const SHOPPING = /^Shopping list$/;

describe("QuickAccess — what it renders (#252)", () => {
  it("offers both destinations when both gates are on", () => {
    render(<QuickAccess voice="plain" shoppingList focusQuickAccess />);
    expect(screen.getByRole("link", { name: FOCUS })).toHaveAttribute(
      "href",
      "/focus",
    );
    expect(screen.getByRole("link", { name: SHOPPING })).toHaveAttribute(
      "href",
      "/shopping",
    );
  });

  // #199's gate, reused rather than reinvented: hiding the icon is presentation
  // only — /shopping itself is `notFound()`ed and every shopping server action
  // re-checks — but a shortcut to a route that 404s is worse than no shortcut.
  it("hides the trolley when shopping-list mode is off", () => {
    render(<QuickAccess voice="plain" shoppingList={false} focusQuickAccess />);
    expect(screen.queryByRole("link", { name: SHOPPING })).toBeNull();
    expect(screen.getByRole("link", { name: FOCUS })).toBeInTheDocument();
  });

  it("hides the timer when the focus quick-access setting is off", () => {
    render(<QuickAccess voice="plain" shoppingList focusQuickAccess={false} />);
    expect(screen.queryByRole("link", { name: FOCUS })).toBeNull();
    expect(screen.getByRole("link", { name: SHOPPING })).toBeInTheDocument();
  });

  it("renders nothing at all when both are off", () => {
    const { container } = render(
      <QuickAccess
        voice="plain"
        shoppingList={false}
        focusQuickAccess={false}
      />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  // Fail closed, like AppMenu's `shoppingList = false`: a call site that
  // predates a prop, or forgets one, must hide a feature rather than advertise
  // one nobody asked for. The focus icon defaults ON in the DATABASE, which is a
  // different decision made in a different place — the column's default. A
  // component defaulting it on would mean a caller that forgot the prop
  // advertises it regardless of what the workspace stored.
  it("fails closed when a caller supplies neither gate", () => {
    const { container } = render(<QuickAccess voice="plain" />);
    expect(container).toBeEmptyDOMElement();
  });
});

describe("QuickAccess — accessibility (#252)", () => {
  it("names both controls, on hover as well as for AT", () => {
    render(<QuickAccess voice="plain" shoppingList focusQuickAccess />);
    for (const [name, title] of [
      [FOCUS, "Focus Timer"],
      [SHOPPING, "Shopping list"],
    ] as const) {
      const link = screen.getByRole("link", { name });
      expect(link).toHaveAttribute("aria-label", title);
      expect(link).toHaveAttribute("title", title);
    }
  });

  // The glyph must never BE the accessible name — the theme toggle's rule
  // (#103), and the reason both icons are aria-hidden.
  it("renders a decorative glyph and no visible text", () => {
    render(<QuickAccess voice="plain" shoppingList focusQuickAccess />);
    for (const name of [FOCUS, SHOPPING]) {
      const link = screen.getByRole("link", { name });
      expect(link.textContent).toBe("");
      const svg = link.querySelector("svg");
      expect(svg).not.toBeNull();
      expect(svg).toHaveAttribute("aria-hidden", "true");
      expect(svg?.getAttribute("class")).toContain("h-5");
      expect(svg?.getAttribute("class")).toContain("w-5");
    }
  });

  // WCAG 2.5.5. `min-h-11`/`min-w-11` is only a class name in jsdom — the
  // measured box is e2e/smoke/header-quick-access.spec.ts's job — but a control
  // that never asks for the size cannot get it, and this is the cheap half.
  it("asks for the 44px minimum target and a visible focus indicator", () => {
    render(<QuickAccess voice="plain" shoppingList focusQuickAccess />);
    for (const name of [FOCUS, SHOPPING]) {
      const link = screen.getByRole("link", { name });
      expect(link.className).toContain("min-h-11");
      expect(link.className).toContain("min-w-11");
      expect(link.className).toContain("focus-visible:ring-2");
    }
  });

  // #252's styling requirement, asserted rather than eyeballed: these read as
  // siblings of the dark-mode toggle because they are built from the SAME class
  // string, not from a copy of it that can drift (#117's lesson).
  it("is built from the same control surface as the theme toggle", () => {
    render(<QuickAccess voice="plain" shoppingList focusQuickAccess />);
    for (const name of [FOCUS, SHOPPING]) {
      const cls = screen.getByRole("link", { name }).className;
      for (const token of [
        "hover:bg-accent",
        "hover:border-primary/40",
        "rounded-md",
        "border",
        "transition-colors",
      ]) {
        expect(cls, `${String(name)} is missing ${token}`).toContain(token);
      }
    }
  });
});

describe("QuickAccess — voice (#252)", () => {
  // The playful voice decorates the MENU rows with emoji. It must not decorate
  // these, because the string is the accessible name and a screen reader reads
  // an emoji out loud — "shopping cart Shopping list".
  it("keeps emoji out of the accessible name in the playful voice", () => {
    render(<QuickAccess voice="playful" shoppingList focusQuickAccess />);
    for (const name of [FOCUS, SHOPPING]) {
      const link = screen.getByRole("link", { name });
      expect(link.getAttribute("aria-label")).not.toMatch(
        /\p{Extended_Pictographic}/u,
      );
      expect(link.getAttribute("title")).not.toMatch(
        /\p{Extended_Pictographic}/u,
      );
    }
  });

  // …and it still calls the destinations what the menu calls them, so the icon
  // and the row it shortcuts cannot describe two different places.
  it("uses the same words as the menu entries", () => {
    render(<QuickAccess voice="plain" shoppingList focusQuickAccess />);
    expect(
      screen.getByRole("link", { name: FOCUS }).getAttribute("aria-label"),
    ).toBe("Focus Timer");
    expect(
      screen.getByRole("link", { name: SHOPPING }).getAttribute("aria-label"),
    ).toBe("Shopping list");
  });
});
