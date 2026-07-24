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
});
