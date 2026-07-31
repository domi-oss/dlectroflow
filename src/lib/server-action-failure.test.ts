import { describe, it, expect, vi, afterEach } from "vitest";
import { UnrecognizedActionError } from "next/dist/client/components/unrecognized-action-error";
import {
  ActionTimeoutError,
  isStaleActionError,
  withActionTimeout,
} from "@/lib/server-action-failure";

describe("isStaleActionError", () => {
  /**
   * The pin. `UnrecognizedActionError` is the class Next's own client throws
   * for this case (`server-action-reducer.ts`, on the
   * `x-nextjs-action-not-found` response header), and this asserts against the
   * real one from the installed Next rather than a hand-written lookalike. If
   * an upgrade renames it or drops the marker, THIS fails — which is the point:
   * a stale-deployment detector that has quietly stopped detecting is worse
   * than none, because the UI would go back to offering a "try again" that can
   * never succeed.
   */
  it("recognises the real error Next 16 throws for an unrecognised action", () => {
    const real = new UnrecognizedActionError(
      'Server Action "40bef5efc6" was not found on the server.',
    );
    expect(isStaleActionError(real)).toBe(true);
  });

  it("recognises it by name alone, without the class identity", () => {
    // Serialised across a boundary (a React error boundary's `error` prop, a
    // logged-and-rethrown copy), the prototype is gone but `name` survives.
    const copy = Object.assign(new Error("anything"), {
      name: "UnrecognizedActionError",
    });
    expect(isStaleActionError(copy)).toBe(true);
  });

  it("recognises the server-side message from the production pod log (#137)", () => {
    expect(
      isStaleActionError(
        new Error(
          'Failed to find Server Action "40bef5efc6c80527f80d35d95a902c7e0bc4056eb0". ' +
            "This request might be from an older or newer deployment.",
        ),
      ),
    ).toBe(true);
  });

  it("recognises the plain-text body served when the header is stripped", () => {
    // A proxy that drops `x-nextjs-action-not-found` sends the client down
    // Next's generic invalid-response path, which surfaces the 404 body as the
    // message. Same cause, different words.
    expect(isStaleActionError(new Error("Server action not found."))).toBe(
      true,
    );
  });

  it("recognises Next's error code when the message has been replaced", () => {
    const coded = Object.assign(new Error("redacted"), {
      __NEXT_ERROR_CODE: "E715",
    });
    expect(isStaleActionError(coded)).toBe(true);
  });

  it("looks through a cause chain", () => {
    const wrapped = new Error("Something went wrong", {
      cause: new UnrecognizedActionError("Server Action was not found."),
    });
    expect(isStaleActionError(wrapped)).toBe(true);
  });

  // Duo review round 3 (!223) renamed the bound to count what the loop counts.
  // Pinned so the rename stays behaviour-preserving: six errors examined — the
  // thrown one plus five links.
  function chain(depth: number): Error {
    let error: Error = new UnrecognizedActionError("Server Action not found.");
    for (let i = 0; i < depth; i++) {
      error = new Error("wrapped", { cause: error });
    }
    return error;
  }

  it("reaches a marker five cause-links down", () => {
    expect(isStaleActionError(chain(5))).toBe(true);
  });

  it("gives up rather than walking a pathological chain forever", () => {
    expect(isStaleActionError(chain(6))).toBe(false);
  });

  it("does not loop forever on a self-referential cause", () => {
    const looped: Error & { cause?: unknown } = new Error("nope");
    looped.cause = looped;
    expect(isStaleActionError(looped)).toBe(false);
  });

  // The whole value of the distinction is that a stale action must NOT offer
  // "try again". Anything else must, so a false positive is a real cost.
  it.each([
    ["a network failure", new TypeError("Failed to fetch")],
    ["an LLM rate limit", new Error("429 Too Many Requests")],
    ["a database error", new Error("Server Components render failed")],
    ["our own timeout", new ActionTimeoutError(30000)],
    ["a non-error", "Server Action not found"],
    ["null", null],
    ["undefined", undefined],
  ])("does not classify %s as stale", (_label, error) => {
    expect(isStaleActionError(error)).toBe(false);
  });
});

describe("withActionTimeout", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("passes a resolved value straight through", async () => {
    await expect(withActionTimeout(Promise.resolve(42), 1000)).resolves.toBe(
      42,
    );
  });

  it("passes a rejection straight through, unwrapped", async () => {
    const boom = new Error("boom");
    await expect(withActionTimeout(Promise.reject(boom), 1000)).rejects.toBe(
      boom,
    );
  });

  it("rejects with ActionTimeoutError when the action never settles", async () => {
    vi.useFakeTimers();
    // #137's third failure mode: not a rejection, just silence. A pod rolling
    // mid-request leaves the fetch hanging, and an un-timed-out await is
    // indistinguishable from the original bug from the user's side.
    const hung = withActionTimeout(new Promise<number>(() => {}), 30000);
    const settled = expect(hung).rejects.toBeInstanceOf(ActionTimeoutError);
    await vi.advanceTimersByTimeAsync(30000);
    await settled;
  });

  it("clears its timer once the action settles, so nothing is left pending", async () => {
    vi.useFakeTimers();
    await expect(withActionTimeout(Promise.resolve("ok"), 30000)).resolves.toBe(
      "ok",
    );
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not raise an unhandled rejection when a timed-out action later fails", async () => {
    vi.useFakeTimers();
    let fail: (reason: Error) => void = () => {};
    const late = new Promise<never>((_, reject) => {
      fail = reject;
    });
    const raced = withActionTimeout(late, 30000);
    const settled = expect(raced).rejects.toBeInstanceOf(ActionTimeoutError);
    await vi.advanceTimersByTimeAsync(30000);
    await settled;
    // The losing promise still rejects afterwards; Promise.race has already
    // attached a handler to it, so this must not surface as an unhandled
    // rejection (which vitest fails the run on).
    fail(new Error("too late"));
    await vi.advanceTimersByTimeAsync(0);
  });
});
