import { vi } from "vitest";

/**
 * Pin the platform CSPRNG to a chosen draw, for tests of code that picks at
 * random through `crypto.getRandomValues` — today `pickOne` (src/lib/pick-one.ts)
 * and the three call sites that use it.
 *
 * Shared rather than copied per suite (raised by Duo review on !275): the same
 * helper was defined identically in `focus-timer.test.tsx` and
 * `fable-lines.test.ts`, with a third inline copy in `pick-one.test.ts`. Three
 * copies of one assumption about `pickOne`'s internals can drift apart
 * silently, and the tests that depend on it assert a specific index.
 *
 * It lives in `__tests__/` for the reason `src/lib/export/__tests__/fixture.ts`
 * gives: it is not app code, nothing under `src/app` or `src/components` may
 * import it, and the directory name is the signal. Vitest collects
 * `src/**‍/*.test.ts`, so a module without that suffix is not picked up as a
 * suite.
 *
 * `fill` is applied to the array that was requested, rather than to a
 * `new Uint32Array(array.buffer)` view over it — which is what the three copies
 * did. That is deliberate on two counts:
 *
 *  - **It survives a change of element width.** If `indexBelow` is ever
 *    rewritten to read a `Uint8Array` and shift bytes together, `0` is still
 *    the bottom of the range and `0xffffffff` still the top, because `fill`
 *    truncates to each element. Without that, the pinned-value tests would
 *    quietly start asserting a different index instead of failing.
 *  - **It cannot throw on a buffer whose length is not a multiple of 4**, which
 *    a `Uint32Array` view over one does (`RangeError`).
 *
 * Returns the spy, so a test that pins mid-run can `mockRestore()` it in a
 * `finally` instead of waiting for `restoreAllMocks`.
 */
export function mockCsprngDraw(value: number) {
  return vi
    .spyOn(globalThis.crypto, "getRandomValues")
    .mockImplementation(<T extends ArrayBufferView | null>(array: T): T => {
      // Every integer TypedArray `getRandomValues` accepts has `fill`; the cast
      // is only needed because `ArrayBufferView` itself does not declare it.
      (array as unknown as { fill?: (v: number) => void } | null)?.fill?.(
        value,
      );
      return array;
    });
}
