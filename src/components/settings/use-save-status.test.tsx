// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { SaveIndicator } from "@/components/settings/use-save-status";

afterEach(cleanup);

describe("SaveIndicator", () => {
  it("renders nothing while idle", () => {
    const { container } = render(<SaveIndicator status="idle" voice="plain" />);
    expect(container).toBeEmptyDOMElement();
  });

  // #72 review finding: four section headings now sit inside a band that turns
  // magenta while you are reading that section, and the band forces its inline
  // badges to inherit its foreground so they stay legible. The save indicator
  // must be spared that, because its COLOUR is its meaning — green saved, red
  // failed. `data-save-status` is the hook globals.css keys the carve-out off,
  // so it has to exist on every visible state.
  it.each([
    ["saving", "status"],
    ["saved", "status"],
    ["error", "alert"],
  ] as const)(
    "tags the %s state so a highlighted band leaves its colour alone",
    (status, role) => {
      render(<SaveIndicator status={status} voice="plain" />);
      expect(screen.getByRole(role)).toHaveAttribute(
        "data-save-status",
        status,
      );
    },
  );

  it("keeps saved and failed visually distinct, not just textually", () => {
    const saved = render(<SaveIndicator status="saved" voice="plain" />);
    const savedClass = screen.getByRole("status").className;
    saved.unmount();

    render(<SaveIndicator status="error" voice="plain" />);
    const errorClass = screen.getByRole("alert").className;

    expect(savedClass).toMatch(/green/);
    expect(errorClass).toMatch(/red/);
    expect(savedClass).not.toBe(errorClass);
  });
});
