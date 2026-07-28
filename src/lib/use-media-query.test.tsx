// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useMediaQuery } from "@/lib/use-media-query";

type Listener = (e: MediaQueryListEvent) => void;

/** Controllable `window.matchMedia` stub (same idiom as
 *  use-prefers-reduced-motion.test.tsx); returns a fire() to flip the match. */
function mockMatchMedia(initial: boolean) {
  let matches = initial;
  const listeners = new Set<Listener>();
  const seen: string[] = [];
  const mql = {
    get matches() {
      return matches;
    },
    media: "",
    addEventListener: (_: string, cb: Listener) => listeners.add(cb),
    removeEventListener: (_: string, cb: Listener) => listeners.delete(cb),
    addListener: (cb: Listener) => listeners.add(cb),
    removeListener: (cb: Listener) => listeners.delete(cb),
    dispatchEvent: () => true,
    onchange: null,
  };
  window.matchMedia = vi.fn().mockImplementation((query: string) => {
    seen.push(query);
    return mql;
  }) as unknown as typeof window.matchMedia;
  return {
    seen,
    listenerCount: () => listeners.size,
    fire(next: boolean) {
      matches = next;
      listeners.forEach((cb) => cb({ matches } as MediaQueryListEvent));
    },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  // @ts-expect-error – clean the stub between tests
  delete window.matchMedia;
});

describe("useMediaQuery", () => {
  it("reports whether the query matches, and asks about the query given", () => {
    const mm = mockMatchMedia(true);
    const { result } = renderHook(() => useMediaQuery("(min-width: 40rem)"));
    expect(result.current).toBe(true);
    expect(mm.seen).toContain("(min-width: 40rem)");
  });

  it("stays live when the viewport crosses the breakpoint mid-session", () => {
    const mm = mockMatchMedia(false);
    const { result } = renderHook(() => useMediaQuery("(min-width: 40rem)"));
    expect(result.current).toBe(false);
    act(() => mm.fire(true));
    expect(result.current).toBe(true);
    act(() => mm.fire(false));
    expect(result.current).toBe(false);
  });

  it("unsubscribes on unmount", () => {
    const mm = mockMatchMedia(true);
    const { unmount } = renderHook(() => useMediaQuery("(min-width: 40rem)"));
    expect(mm.listenerCount()).toBe(1);
    unmount();
    expect(mm.listenerCount()).toBe(0);
  });

  // Regression guard for the classic useSyncExternalStore footgun, raised in
  // review of !162: if getSnapshot returned the MediaQueryList itself (a fresh
  // object per call) React's Object.is comparison would never settle and it
  // would either loop forever or throw "The result of getSnapshot should be
  // cached". It returns `.matches` — a boolean — so the comparison is stable.
  it("returns a PRIMITIVE snapshot, so React's store comparison settles", () => {
    mockMatchMedia(true);
    let renders = 0;
    const { result, rerender } = renderHook(() => {
      renders++;
      return useMediaQuery("(min-width: 40rem)");
    });
    expect(typeof result.current).toBe("boolean");

    const afterMount = renders;
    rerender();
    // Exactly one more render. A fresh-object snapshot would not stop here.
    expect(renders).toBe(afterMount + 1);
    rerender();
    expect(renders).toBe(afterMount + 2);
    expect(result.current).toBe(true);
  });

  it("falls back to the caller's server snapshot when matchMedia is unavailable", () => {
    // No matchMedia installed — the SSR / pre-hydration path.
    const { result: dflt } = renderHook(() =>
      useMediaQuery("(min-width: 1px)"),
    );
    expect(dflt.current).toBe(false);
    const { result: optimistic } = renderHook(() =>
      useMediaQuery("(min-width: 1px)", true),
    );
    expect(optimistic.current).toBe(true);
  });
});
