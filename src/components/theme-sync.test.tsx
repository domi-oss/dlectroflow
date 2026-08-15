// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, cleanup, act } from "@testing-library/react";

import { ThemeSync } from "./theme-sync";
import { PREFERS_DARK_QUERY, THEME_ATTRIBUTE } from "@/lib/theme";

/**
 * #85 — `system` has to stay LIVE. macOS and iOS switch appearance on their own
 * schedule, which is the "automatic with time of day" the issue was originally
 * asking for, so a session that is open across the switch must follow it
 * without a reload.
 *
 * ⚠️ The other half of this component's job is what it must NOT do: it must not
 * strip the `dark` class the `<head>` bootstrap just wrote. That is the flash
 * #85 exists to remove, and the obvious implementation reintroduces it — see
 * the "does not undo the bootstrap" test.
 */

/** A `matchMedia` stub whose value can be changed and whose listeners fire. */
function installMatchMedia(initiallyDark: boolean) {
  let matches = initiallyDark;
  const listeners = new Set<(e: { matches: boolean }) => void>();
  vi.stubGlobal("matchMedia", (query: string) => ({
    get matches() {
      return query === PREFERS_DARK_QUERY ? matches : false;
    },
    media: query,
    onchange: null,
    addEventListener: (
      _type: string,
      fn: (e: { matches: boolean }) => void,
    ) => {
      listeners.add(fn);
    },
    removeEventListener: (
      _type: string,
      fn: (e: { matches: boolean }) => void,
    ) => {
      listeners.delete(fn);
    },
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  }));
  return {
    listenerCount: () => listeners.size,
    async set(next: boolean) {
      matches = next;
      await act(async () => {
        for (const fn of [...listeners]) fn({ matches: next });
      });
    },
  };
}

/** What the bootstrap would have left behind for a given preference. */
function seedHtml(pref: string, dark: boolean) {
  document.documentElement.setAttribute(THEME_ATTRIBUTE, pref);
  document.documentElement.classList.toggle("dark", dark);
}

const isDark = () => document.documentElement.classList.contains("dark");

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  document.documentElement.classList.remove("dark");
  document.documentElement.removeAttribute(THEME_ATTRIBUTE);
});

describe("ThemeSync (#85)", () => {
  it("follows the OS switching to dark while the preference is system", async () => {
    const mq = installMatchMedia(false);
    seedHtml("system", false);
    render(<ThemeSync />);
    expect(isDark()).toBe(false);

    await mq.set(true);
    expect(isDark()).toBe(true);
  });

  it("follows the OS switching back to light", async () => {
    const mq = installMatchMedia(true);
    seedHtml("system", true);
    render(<ThemeSync />);

    await mq.set(false);
    expect(isDark()).toBe(false);
  });

  // An explicit choice is an override, so the OS moving must not overrule it.
  it.each([
    ["dark", true, true],
    ["light", false, false],
  ] as const)(
    "leaves an explicit %s preference alone when the OS changes",
    async (pref, seeded, expected) => {
      const mq = installMatchMedia(!seeded);
      seedHtml(pref, seeded);
      render(<ThemeSync />);

      await mq.set(seeded);
      expect(isDark()).toBe(expected);
      await mq.set(!seeded);
      expect(isDark()).toBe(expected);
    },
  );

  /**
   * ⚠️ The regression this component is most likely to cause.
   *
   * Driving the class off `useMediaQuery(PREFERS_DARK_QUERY)` reads `false` on
   * the hydration pass (that hook's documented server snapshot), so the first
   * effect would run with "OS is light", strip the `dark` class the `<head>`
   * script had already written, and restore it on the next commit — a
   * one-frame light flash on every load for every dark-OS user, which is
   * precisely the defect #85 is about. So the OS value is read LIVE from
   * `matchMedia` at effect time and never taken from a hook's snapshot.
   */
  it("does not undo the bootstrap on mount (no flash)", () => {
    installMatchMedia(true);
    seedHtml("system", true);
    render(<ThemeSync />);
    expect(isDark()).toBe(true);
  });

  it("renders nothing", () => {
    installMatchMedia(false);
    const { container } = render(<ThemeSync />);
    expect(container).toBeEmptyDOMElement();
  });

  it("unsubscribes on unmount", () => {
    const mq = installMatchMedia(false);
    seedHtml("system", false);
    const { unmount } = render(<ThemeSync />);
    expect(mq.listenerCount()).toBe(1);
    unmount();
    expect(mq.listenerCount()).toBe(0);
  });

  // Never throw in the root layout: a browser with no matchMedia would take the
  // whole app down with it.
  it("survives a missing matchMedia", () => {
    vi.stubGlobal("matchMedia", undefined);
    seedHtml("system", false);
    expect(() => render(<ThemeSync />)).not.toThrow();
  });
});
