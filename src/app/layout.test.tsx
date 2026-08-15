import { describe, it, expect, vi } from "vitest";
import type { ReactElement } from "react";

// next/font/google and next/font/local are rewritten by the Next.js SWC
// build plugin; under vitest (plain Node, no Next compiler) they resolve to
// empty stub modules, so the real family functions aren't callable here. We
// mock them to echo back the `variable` option as both `.variable` and
// `.className` — that way asserting on the className this produces
// genuinely proves each font is wired with the exact CSS variable name that
// globals.css (Task 0.2) and @theme (Task 0.3) will key off of, rather than
// asserting on an opaque test double.
function fontStub(opts: { variable: string }) {
  return { variable: opts.variable, className: opts.variable };
}

vi.mock("next/font/google", () => ({
  Figtree: vi.fn(fontStub),
  Atkinson_Hyperlegible: vi.fn(fontStub),
  Geist_Mono: vi.fn(fontStub),
}));

vi.mock("next/font/local", () => ({
  default: vi.fn(fontStub),
}));

import RootLayout from "./layout";
import { THEME_BOOTSTRAP_SCRIPT } from "@/lib/theme";

/** Depth-first walk over a returned element tree. */
function* walk(
  node: unknown,
): Generator<ReactElement<Record<string, unknown>>> {
  if (Array.isArray(node)) {
    for (const child of node) yield* walk(child);
    return;
  }
  if (!node || typeof node !== "object") return;
  const element = node as ReactElement<Record<string, unknown>>;
  if (!("type" in element)) return;
  yield element;
  yield* walk((element.props as { children?: unknown })?.children);
}

describe("RootLayout", () => {
  it("carries every typeface CSS variable on the <html> element", () => {
    // RootLayout is a Server Component: a plain function returning a React
    // element tree. React-DOM/jsdom won't let an <html> render as a child
    // of the wrapper <div> that @testing-library/react's `render` inserts
    // (it's invalid HTML and jsdom drops the node), so instead we call the
    // component directly and inspect the <html> element it produced.
    const element = RootLayout({
      children: <div>child</div>,
    }) as ReactElement<{ className: string }>;

    expect(element.type).toBe("html");

    for (const cssVar of [
      "--font-figtree",
      "--font-atkinson",
      "--font-opendyslexic",
      "--font-geist-mono",
    ]) {
      expect(element.props.className).toContain(cssVar);
    }
  });

  // #85 — the theme bootstrap has to be THE tested string, not a paraphrase of
  // it inlined here. theme.test.ts executes `THEME_BOOTSTRAP_SCRIPT` against
  // every stored value × both OS settings; this asserts that the string the
  // <head> actually ships is that same one. Without this pairing, either half
  // could be correct while the app shipped the other.
  it("inlines the tested theme bootstrap in <head>", () => {
    const element = RootLayout({ children: <div>child</div> });

    const scripts = [...walk(element)].filter((n) => n.type === "script");
    expect(scripts).toHaveLength(1);
    expect(
      (scripts[0].props as { dangerouslySetInnerHTML?: { __html: string } })
        .dangerouslySetInnerHTML?.__html,
    ).toBe(THEME_BOOTSTRAP_SCRIPT);
  });

  // The bootstrap writes to <html> before React hydrates. Without this prop
  // React reports a mismatch and — the #75 failure — can rebuild from the root,
  // resetting the class list and silently dropping the theme.
  it("suppresses hydration warnings on <html>, which the bootstrap needs", () => {
    const element = RootLayout({ children: <div>child</div> }) as ReactElement<{
      suppressHydrationWarning?: boolean;
    }>;
    expect(element.props.suppressHydrationWarning).toBe(true);
  });
});
