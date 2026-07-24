// @vitest-environment jsdom
import { render, cleanup } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { BrandMark } from "./brand-mark";

afterEach(cleanup);

describe("BrandMark", () => {
  it("is decorative (aria-hidden, non-focusable)", () => {
    const { container } = render(<BrandMark />);
    const svg = container.querySelector("svg")!;
    expect(svg).toHaveAttribute("aria-hidden", "true");
    expect(svg).toHaveAttribute("focusable", "false");
  });

  it("wires the gradient <defs> id to the rect fill so the fill resolves", () => {
    const { container } = render(<BrandMark gradientId="x" />);
    const grad = container.querySelector("linearGradient")!;
    const rect = container.querySelector("rect")!;
    expect(grad).toHaveAttribute("id", "x");
    expect(rect).toHaveAttribute("fill", "url(#x)");
  });

  it("gives distinct gradient ids when two instances share a page (no duplicate-id collision)", () => {
    // Duo finding: guest users render BrandMark in both the header and the
    // guest indicator at once — a hardcoded shared id is invalid HTML and can
    // make the fill reference the wrong <defs>.
    const { container } = render(
      <>
        <BrandMark gradientId="df-brand-mark-header" />
        <BrandMark gradientId="df-brand-mark-guest" />
      </>,
    );
    const ids = Array.from(container.querySelectorAll("linearGradient")).map(
      (g) => g.getAttribute("id"),
    );
    expect(ids).toEqual(["df-brand-mark-header", "df-brand-mark-guest"]);
    expect(new Set(ids).size).toBe(ids.length); // all unique
    // each rect points at its own gradient
    const fills = Array.from(container.querySelectorAll("rect")).map((r) =>
      r.getAttribute("fill"),
    );
    expect(fills).toEqual([
      "url(#df-brand-mark-header)",
      "url(#df-brand-mark-guest)",
    ]);
  });
});
