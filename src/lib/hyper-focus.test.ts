import { describe, it, expect, vi } from "vitest";
import {
  HYPER_FOCUS_STORAGE_KEY,
  readHyperFocus,
  writeHyperFocus,
  type KeyValueStore,
} from "@/lib/hyper-focus";

function memoryStore(seed: Record<string, string> = {}): KeyValueStore {
  const map = new Map(Object.entries(seed));
  return {
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, v),
  };
}

describe("hyper focus mode persistence (#142)", () => {
  it("is OFF when nothing has been stored — the default is off, not remembered-off", () => {
    expect(readHyperFocus(memoryStore())).toBe(false);
  });

  it("is OFF when there is no storage at all (server render, or a locked-down browser)", () => {
    expect(readHyperFocus(null)).toBe(false);
    expect(readHyperFocus(undefined)).toBe(false);
  });

  it("round-trips on", () => {
    const store = memoryStore();
    writeHyperFocus(store, true);
    expect(readHyperFocus(store)).toBe(true);
  });

  it("round-trips off again", () => {
    const store = memoryStore({ [HYPER_FOCUS_STORAGE_KEY]: "1" });
    writeHyperFocus(store, false);
    expect(readHyperFocus(store)).toBe(false);
  });

  it("only the exact stored token means on — anything else falls back to off", () => {
    // A mode that starts a timed navigation must not be switched on by a
    // corrupt, half-written or foreign value in a shared storage namespace.
    for (const junk of ["true", "yes", "0", "", "  1", "1 ", "{}"]) {
      expect(
        readHyperFocus(memoryStore({ [HYPER_FOCUS_STORAGE_KEY]: junk })),
      ).toBe(false);
    }
  });

  it("a storage that throws leaves the mode off rather than breaking the screen", () => {
    // Safari in private mode throws from setItem, and getItem can throw behind
    // a blocked-cookies policy. Neither is a reason to take down the focus
    // timer, and neither is a reason to guess "on".
    const hostile: KeyValueStore = {
      getItem: () => {
        throw new Error("SecurityError");
      },
      setItem: () => {
        throw new Error("QuotaExceededError");
      },
    };
    expect(readHyperFocus(hostile)).toBe(false);
    expect(() => writeHyperFocus(hostile, true)).not.toThrow();
  });

  it("writes under a namespaced key, like the theme preference does", () => {
    expect(HYPER_FOCUS_STORAGE_KEY).toMatch(/^df-/);
    const setItem = vi.fn();
    writeHyperFocus({ getItem: () => null, setItem }, true);
    expect(setItem).toHaveBeenCalledWith(HYPER_FOCUS_STORAGE_KEY, "1");
  });
});
