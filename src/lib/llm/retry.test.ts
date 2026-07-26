import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { withRetry } from "./retry";
import { LLMError } from "./types";

describe("withRetry", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("retries a retryable failure with exponential backoff and returns the eventual success", async () => {
    let calls = 0;
    const fn = vi.fn(async () => {
      calls++;
      if (calls < 3) {
        throw new LLMError("rate_limit", 429, "rate limited", true);
      }
      return "ok";
    });

    const promise = withRetry(fn);
    await vi.advanceTimersByTimeAsync(200); // 1st backoff (attempt 0 -> 1)
    await vi.advanceTimersByTimeAsync(400); // 2nd backoff (attempt 1 -> 2)

    await expect(promise).resolves.toBe("ok");
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("throws immediately without retrying a non-retryable error", async () => {
    const fn = vi.fn(async () => {
      throw new LLMError("auth", 401, "nope", false);
    });

    await expect(withRetry(fn)).rejects.toMatchObject({ kind: "auth" });
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("gives up after `tries` retries and throws the last error", async () => {
    const fn = vi.fn(async () => {
      throw new LLMError("server", 500, "down", true);
    });

    const promise = withRetry(fn, 2);
    const assertion = expect(promise).rejects.toMatchObject({ kind: "server" });
    await vi.advanceTimersByTimeAsync(200);
    await vi.advanceTimersByTimeAsync(400);
    await assertion;

    expect(fn).toHaveBeenCalledTimes(3); // initial attempt + 2 retries
  });
});
