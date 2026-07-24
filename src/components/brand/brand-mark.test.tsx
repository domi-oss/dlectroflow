// @vitest-environment jsdom
import { render, cleanup } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { BrandMark } from "./brand-mark";

afterEach(cleanup);

describe("BrandMark", () => {
  it("renders the shipped app-icon asset", () => {
    const { container } = render(<BrandMark />);
    const img = container.querySelector("img")!;
    expect(img).toHaveAttribute("src", "/brand-mark.png");
  });

  it("is decorative (empty alt + aria-hidden) so the accessible name comes from adjacent text", () => {
    const { container } = render(<BrandMark />);
    const img = container.querySelector("img")!;
    expect(img).toHaveAttribute("alt", "");
    expect(img).toHaveAttribute("aria-hidden", "true");
  });

  it("passes the caller's className through for sizing", () => {
    const { container } = render(<BrandMark className="h-6 w-6 shrink-0" />);
    expect(container.querySelector("img")).toHaveClass(
      "h-6",
      "w-6",
      "shrink-0",
    );
  });
});
