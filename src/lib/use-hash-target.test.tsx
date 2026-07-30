// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import {
  currentHashTarget,
  subscribeToHashTarget,
  useHashTarget,
} from "@/lib/use-hash-target";

/** Change the fragment the way a browser does: set it, then announce it. */
function setFragment(next: string): void {
  act(() => {
    window.location.hash = next;
    window.dispatchEvent(new HashChangeEvent("hashchange"));
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  window.location.hash = "";
});

describe("useHashTarget (#115)", () => {
  it("reports the fragment without its `#`, and nothing when there is none", () => {
    window.location.hash = "#settings-demo";
    const { result } = renderHook(() => useHashTarget());
    expect(result.current).toBe("settings-demo");
  });

  it("is empty when the URL carries no fragment", () => {
    const { result } = renderHook(() => useHashTarget());
    expect(result.current).toBe("");
  });

  it("stays live when the fragment changes — clicking a nav pill IS a hashchange", () => {
    const { result } = renderHook(() => useHashTarget());
    expect(result.current).toBe("");
    setFragment("#settings-voice");
    expect(result.current).toBe("settings-voice");
    setFragment("#settings-aging");
    expect(result.current).toBe("settings-aging");
  });

  it("follows Back/Forward too — history.pushState fires popstate, not hashchange", () => {
    // Next's router navigates with the History API, which does NOT fire
    // hashchange. Subscribing to popstate as well is what keeps a fragment
    // arrived at that way visible to React.
    const { result } = renderHook(() => useHashTarget());
    act(() => {
      window.location.hash = "#settings-people";
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    expect(result.current).toBe("settings-people");
  });

  it("percent-decodes the fragment, and survives a malformed escape", () => {
    window.location.hash = "#a%20b";
    expect(currentHashTarget()).toBe("a b");
    // `decodeURIComponent` THROWS on a bad escape rather than returning the
    // input, and this runs during render — the raw fragment is a better answer
    // than a crashed page.
    window.location.hash = "#%zz";
    expect(currentHashTarget()).toBe("%zz");
  });

  it("notifies only when the fragment actually changed", () => {
    // A popstate is fired for every history entry, most of which leave the
    // fragment alone. Treating those as "the reader asked for this section
    // again" would re-open a section they had just closed.
    const onChange = vi.fn();
    window.location.hash = "#settings-demo";
    const unsubscribe = subscribeToHashTarget(onChange);
    try {
      window.dispatchEvent(new PopStateEvent("popstate"));
      expect(onChange).not.toHaveBeenCalled();
      window.location.hash = "#settings-voice";
      window.dispatchEvent(new PopStateEvent("popstate"));
      expect(onChange).toHaveBeenCalledTimes(1);
    } finally {
      unsubscribe();
    }
  });

  it("unsubscribes on unmount — both events", () => {
    const add = vi.spyOn(window, "addEventListener");
    const remove = vi.spyOn(window, "removeEventListener");
    const { unmount } = renderHook(() => useHashTarget());
    const added = add.mock.calls.map(([type]) => type);
    expect(added).toContain("hashchange");
    expect(added).toContain("popstate");
    unmount();
    const removed = remove.mock.calls.map(([type]) => type);
    expect(removed).toContain("hashchange");
    expect(removed).toContain("popstate");
  });

  it("returns a PRIMITIVE snapshot, so React's store comparison settles", () => {
    // The useSyncExternalStore footgun this repo already documents in
    // use-media-query.test.tsx: a fresh object per call never satisfies
    // Object.is and React either loops or throws.
    window.location.hash = "#settings-voice";
    let renders = 0;
    const { result, rerender } = renderHook(() => {
      renders++;
      return useHashTarget();
    });
    expect(typeof result.current).toBe("string");
    const afterMount = renders;
    rerender();
    expect(renders).toBe(afterMount + 1);
    rerender();
    expect(renders).toBe(afterMount + 2);
    expect(result.current).toBe("settings-voice");
  });

  it("answers empty where there is no window (the server / pre-hydration pass)", () => {
    // The fragment is never sent to the server, so "" is the only honest
    // pre-hydration answer — and the subscription must be a no-op, not a throw.
    const original = globalThis.window;
    // @ts-expect-error – simulating the server pass
    delete globalThis.window;
    try {
      expect(currentHashTarget()).toBe("");
      expect(() => subscribeToHashTarget(() => {})()).not.toThrow();
    } finally {
      globalThis.window = original;
    }
  });
});
