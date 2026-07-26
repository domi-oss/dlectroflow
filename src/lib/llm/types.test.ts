import { describe, it, expect } from "vitest";
import { LLMError } from "./types";

describe("LLMError", () => {
  it("carries kind, status, retryable and message", () => {
    const e = new LLMError("rate_limit", 429, "slow down", true);
    expect(e).toBeInstanceOf(Error);
    expect(e.kind).toBe("rate_limit");
    expect(e.status).toBe(429);
    expect(e.retryable).toBe(true);
    expect(e.message).toBe("slow down");
  });

  it("preserves the original cause", () => {
    const cause = new Error("socket hang up");
    const e = new LLMError("network", undefined, "network error", true, cause);
    expect(e.cause).toBe(cause);
    expect(e.status).toBeUndefined();
  });
});
