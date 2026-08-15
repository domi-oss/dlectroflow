// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from "vitest";

import {
  PREFERS_DARK_QUERY,
  THEME_ATTRIBUTE,
  THEME_BOOTSTRAP_SCRIPT,
  THEME_PREFERENCES,
  THEME_STORAGE_KEY,
  normaliseThemePreference,
  resolveTheme,
  type ThemePreference,
} from "./theme";

/**
 * #85 — the OS preference has to be consulted by the PRE-HYDRATION script, not
 * by a hook, or the first paint is light and the correct theme arrives a frame
 * later. That script ships as a string inside `dangerouslySetInnerHTML`, which
 * is exactly the shape nothing ever tests — so these tests EXECUTE the shipped
 * string rather than asserting on its source text, and check it agrees with the
 * module's own `normaliseThemePreference`/`resolveTheme` for every input.
 *
 * Equivalence, not two independent implementations: if the script and the
 * helpers ever disagree, the bug is a theme flash that only shows up on a real
 * browser's first paint, which is the least observable place in the app.
 */

type Stub = { restore: () => void };

/**
 * Stand a Map-backed `localStorage` up with one value in it.
 *
 * ⚠️ This jsdom build provides **no** `window.localStorage` at all (the same
 * constraint appearance-section.test.tsx and roundup-card.test.tsx record), so
 * `vi.stubGlobal` is the repo's idiom and there is nothing to spy on. Two wrong
 * turns cost a red run each and are worth not repeating:
 *   - `vi.spyOn(Storage.prototype, "getItem")` installs cleanly and is silently
 *     a NO-OP, so every case reads an empty store and only the cases that
 *     expected "light" pass — a suite that looks like it ran and did not.
 *   - touching `window.localStorage` directly throws, because it is absent
 *     rather than empty.
 */
function stubStoredTheme(value: string | null): Stub {
  const store = new Map<string, string>();
  if (value !== null) store.set(THEME_STORAGE_KEY, value);
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => {
      store.set(k, v);
    },
    removeItem: (k: string) => {
      store.delete(k);
    },
    clear: () => store.clear(),
  });
  return { restore: () => vi.unstubAllGlobals() };
}

/** Private mode: `getItem` throws instead of returning null. */
function stubThrowingStorage(): Stub {
  vi.stubGlobal("localStorage", {
    getItem: () => {
      throw new Error("SecurityError: storage is disabled");
    },
    setItem: () => {
      throw new Error("SecurityError: storage is disabled");
    },
    removeItem: () => {},
    clear: () => {},
  });
  return { restore: () => vi.unstubAllGlobals() };
}

/** Pin `prefers-color-scheme` the way a real OS setting would. */
function stubOsPrefersDark(prefersDark: boolean): Stub {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: query === PREFERS_DARK_QUERY ? prefersDark : false,
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  }));
  return { restore: () => {} };
}

/**
 * Run the exact string the `<head>` ships.
 *
 * `new Function` on purpose, and safe here for a reason worth stating rather
 * than assuming: `THEME_BOOTSTRAP_SCRIPT` is assembled entirely from module
 * constants passed through `JSON.stringify` — no argument, no fixture and no
 * stored value reaches its source — so there is nothing untrusted to inject.
 * Executing it is the point: paraphrasing the script into TypeScript would test
 * the paraphrase, and the shipped string is what the browser runs before
 * anything else on the page.
 */
function runBootstrap(): void {
  new Function(THEME_BOOTSTRAP_SCRIPT)();
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  document.documentElement.classList.remove("dark");
  document.documentElement.removeAttribute(THEME_ATTRIBUTE);
});

describe("normaliseThemePreference (#85 tolerant read of df-theme)", () => {
  // The migration requirement: anyone who has already pressed the toggle keeps
  // the choice they made. `light` and `dark` are the only two values shipped
  // code has ever written to this key (theme-toggle.tsx since #23).
  it.each([
    ["dark", "dark"],
    ["light", "light"],
    ["system", "system"],
  ] as const)("reads a known value %s as %s", (raw, expected) => {
    expect(normaliseThemePreference(raw)).toBe(expected);
  });

  // Anything else falls back to the new default rather than guessing — an
  // unset key (a first visit, or an installed app's fresh storage jar) and a
  // value written by some future version both land on `system`.
  it.each([null, undefined, "", "DARK", " dark ", "true", "auto", "0"])(
    "falls back to system for %j",
    (raw) => {
      expect(normaliseThemePreference(raw)).toBe("system");
    },
  );

  it("offers system first, so the default is the first option in the UI", () => {
    expect(THEME_PREFERENCES).toEqual(["system", "light", "dark"]);
  });
});

describe("resolveTheme (#85)", () => {
  it.each([
    ["system", true, "dark"],
    ["system", false, "light"],
    ["light", true, "light"],
    ["light", false, "light"],
    ["dark", true, "dark"],
    ["dark", false, "dark"],
  ] as const)(
    "%s with prefers-color-scheme:dark=%s resolves to %s",
    (pref, osDark, expected) => {
      expect(resolveTheme(pref, osDark)).toBe(expected);
    },
  );
});

describe("THEME_BOOTSTRAP_SCRIPT (#85 — the pre-hydration script itself)", () => {
  const RAW_VALUES = [null, "system", "light", "dark", "nonsense"] as const;

  for (const raw of RAW_VALUES) {
    for (const osDark of [false, true]) {
      it(`stored ${JSON.stringify(raw)} + OS dark=${osDark} paints the theme the helpers resolve`, () => {
        const stored = stubStoredTheme(raw);
        const os = stubOsPrefersDark(osDark);
        try {
          runBootstrap();
        } finally {
          stored.restore();
          os.restore();
        }

        const pref = normaliseThemePreference(raw);
        const resolved = resolveTheme(pref, osDark);

        expect(document.documentElement.getAttribute(THEME_ATTRIBUTE)).toBe(
          pref,
        );
        expect(document.documentElement.classList.contains("dark")).toBe(
          resolved === "dark",
        );
      });
    }
  }

  // The defect this issue is about, stated as one assertion: no stored value,
  // OS set to dark, and the FIRST paint must already be dark.
  it("a first visit on a dark OS starts dark (the #85 defect)", () => {
    const stored = stubStoredTheme(null);
    const os = stubOsPrefersDark(true);
    try {
      runBootstrap();
    } finally {
      stored.restore();
      os.restore();
    }
    expect(document.documentElement.classList.contains("dark")).toBe(true);
    expect(document.documentElement.getAttribute(THEME_ATTRIBUTE)).toBe(
      "system",
    );
  });

  // An explicit choice still wins over the OS — otherwise "keep the manual
  // toggle working" is not true, and the both-schemes CI gate would be
  // measuring whatever the runner preferred.
  it.each([
    ["light", true],
    ["dark", false],
  ] as const)(
    "an explicit %s choice overrides an OS that disagrees",
    (choice, osDark) => {
      const stored = stubStoredTheme(choice);
      const os = stubOsPrefersDark(osDark);
      try {
        runBootstrap();
      } finally {
        stored.restore();
        os.restore();
      }
      expect(document.documentElement.classList.contains("dark")).toBe(
        choice === "dark",
      );
    },
  );

  // Private mode: `localStorage.getItem` throws rather than returning null.
  // The script must still paint the OS theme instead of dying and leaving the
  // page unstyled-light.
  it("falls back to the OS when localStorage throws (private mode)", () => {
    const stored = stubThrowingStorage();
    const os = stubOsPrefersDark(true);
    try {
      expect(() => runBootstrap()).not.toThrow();
    } finally {
      stored.restore();
      os.restore();
    }
    expect(document.documentElement.classList.contains("dark")).toBe(true);
  });

  // No matchMedia at all (very old browser, or a non-browser prerender):
  // resolve light and never throw. A throw here would abort the <head> script
  // and take the returning user's explicit dark theme down with it.
  it("survives a missing matchMedia", () => {
    const stored = stubStoredTheme(null);
    vi.stubGlobal("matchMedia", undefined);
    try {
      expect(() => runBootstrap()).not.toThrow();
    } finally {
      stored.restore();
    }
    expect(document.documentElement.classList.contains("dark")).toBe(false);
    // Still records the preference, so the Settings radiogroup comes up on
    // "Follow my system" rather than on a state the user never chose.
    expect(document.documentElement.getAttribute(THEME_ATTRIBUTE)).toBe(
      "system",
    );
  });

  // It ships inside dangerouslySetInnerHTML, so it must not be able to close
  // its own <script> element.
  it("cannot terminate the script element it is inlined into", () => {
    expect(THEME_BOOTSTRAP_SCRIPT.toLowerCase()).not.toContain("</");
  });

  // Cheap regression guard on the one thing the whole issue is about: the
  // script has to mention the media query at all.
  it("consults prefers-color-scheme", () => {
    expect(THEME_BOOTSTRAP_SCRIPT).toContain(PREFERS_DARK_QUERY);
  });
});

describe("THEME_PREFERENCES is exhaustive over ThemePreference", () => {
  it("covers every member of the union", () => {
    // A compile-time check with a runtime assertion behind it: adding a member
    // to the union without adding it here stops type-checking.
    const seen: Record<ThemePreference, true> = {
      system: true,
      light: true,
      dark: true,
    };
    expect(Object.keys(seen).sort()).toEqual([...THEME_PREFERENCES].sort());
  });
});
