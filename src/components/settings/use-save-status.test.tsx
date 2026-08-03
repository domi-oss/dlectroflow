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

  // #109 — both indicators are 12px, so the 4.5:1 NORMAL-text threshold applies,
  // not the 3:1 large-text one. `text-green-600` measured 3.03:1 and
  // `text-red-600` 4.48:1 on the light --background; each only paints for the
  // moment after a save resolves, so /settings' zero-tolerance contrast gate has
  // only ever scanned an idle page. green-700 is 4.65:1, red-700 is 6.04:1.
  it.each([
    ["saved", "status", "text-green-700", "dark:text-green-400", "green-600"],
    ["error", "alert", "text-red-700", "dark:text-red-400", "red-600"],
  ] as const)(
    "paints the %s state with the AA-tuned pair, not the sub-AA %s",
    (status, role, light, dark, banned) => {
      render(<SaveIndicator status={status} voice="plain" />);
      const className = screen.getByRole(role).className;
      expect(className).toContain(light);
      expect(className).toContain(dark);
      expect(className).not.toContain(`text-${banned}`);
    },
  );
});
