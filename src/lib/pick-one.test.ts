import { describe, it, expect, vi, afterEach } from "vitest";
import { pickOne } from "./pick-one";
import { mockCsprngDraw } from "./__tests__/mock-csprng";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("pickOne", () => {
  it("returns a member of the list", () => {
    const list = ["a", "b", "c"] as const;
    for (let i = 0; i < 50; i++) {
      expect(list).toContain(pickOne(list));
    }
  });

  it("returns the only member of a one-item list", () => {
    expect(pickOne(["only"])).toBe("only");
  });

  it("can reach every index — the point of picking at random", () => {
    // Guards against an off-by-one that silently makes the last item
    // unreachable, which no "returns a member of the list" assertion sees.
    const list = ["a", "b", "c", "d"];
    const seen = new Set<string>();
    for (let i = 0; i < 500; i++) seen.add(pickOne(list));
    expect(seen.size).toBe(list.length);
  });

  it("never returns undefined for an index at the top of the range", () => {
    // The failure this exists for: scaling a full-range unsigned integer by
    // `n / 2**32` must never round up to `n`. Force the largest value the
    // generator can produce.
    //
    // This is also the drift guard for the shared helper (!275 review). The
    // helper encodes how `indexBelow` reads the CSPRNG, and this is the
    // canonical test of that mapping — so if the two ever disagree, it fails
    // here, next to the code, rather than in a consumer suite.
    mockCsprngDraw(0xffffffff);
    expect(pickOne(["a", "b", "c"])).toBe("c");
  });

  it("throws on an empty list rather than returning undefined", () => {
    // A silent `undefined` here reaches the UI as a blank line; the caller
    // lists are all compile-time constants, so an empty one is a bug at the
    // call site and should say so.
    expect(() => pickOne([])).toThrow(/empty/i);
  });

  it("draws from the platform CSPRNG, not Math.random", () => {
    // The whole reason this helper exists (see the module docblock): the
    // `Math.random` form regenerates a SAST finding every time a line number
    // moves. If a refactor reintroduces it, this fails.
    const spy = vi.spyOn(globalThis.crypto, "getRandomValues");
    pickOne(["a", "b"]);
    expect(spy).toHaveBeenCalled();
  });
});
