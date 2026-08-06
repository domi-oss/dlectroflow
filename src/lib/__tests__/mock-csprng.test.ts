import { describe, it, expect, afterEach, vi } from "vitest";
import { mockCsprngDraw } from "./mock-csprng";

afterEach(() => vi.restoreAllMocks());

describe("mockCsprngDraw", () => {
  it("pins the value a caller reads out of the CSPRNG", () => {
    mockCsprngDraw(0x1234abcd);
    const buf = new Uint32Array(1);
    crypto.getRandomValues(buf);
    expect(buf[0]).toBe(0x1234abcd);
  });

  it("fills whatever element width it is handed, not only a Uint32Array", () => {
    // This is the assertion the helper exists for. `pickOne`'s `indexBelow`
    // reads a Uint32Array today; if it is ever rewritten to read bytes and
    // shift them, `0` must still be the bottom of the range and `0xffffffff`
    // still the top, or the pinned-value tests in pick-one.test.ts,
    // fable-lines.test.ts and focus-timer.test.tsx would quietly start
    // asserting a different index instead of failing. Filling per element
    // (which truncates to the element width) is what keeps both ends stable.
    //
    // The 3-byte length is deliberate: the `new Uint32Array(array.buffer)`
    // view the three copied helpers used throws RangeError on a buffer that is
    // not a multiple of 4.
    mockCsprngDraw(0xffffffff);
    const bytes = new Uint8Array(3);
    crypto.getRandomValues(bytes);
    expect([...bytes]).toEqual([0xff, 0xff, 0xff]);
  });

  it("returns the spy, so a test can restore real entropy in a finally", () => {
    const spy = mockCsprngDraw(0);
    const pinned = new Uint32Array(1);
    crypto.getRandomValues(pinned);
    expect(pinned[0]).toBe(0);

    spy.mockRestore();
    // Not flaky: 64 real 32-bit draws all landing on zero is a 2^-2048 event.
    const after = new Uint32Array(64);
    crypto.getRandomValues(after);
    expect(after.some((v) => v !== 0)).toBe(true);
  });
});
