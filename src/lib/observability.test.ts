import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  recordAnthropicFailure,
  anthropicFailureCount,
  _resetAnthropicFailuresForTest,
} from "./observability";

describe("recordAnthropicFailure", () => {
  beforeEach(() => {
    _resetAnthropicFailuresForTest();
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  it("increments the in-process counter", () => {
    expect(anthropicFailureCount()).toBe(0);
    recordAnthropicFailure("breakdown", new Error("boom"));
    recordAnthropicFailure("breakdown", new Error("boom again"));
    expect(anthropicFailureCount()).toBe(2);
  });

  it("emits one structured log line with a greppable tag", () => {
    recordAnthropicFailure("breakdown", new Error("overloaded"));
    expect(console.error).toHaveBeenCalledTimes(1);
    const line = vi.mocked(console.error).mock.calls[0][0] as string;
    const parsed = JSON.parse(line);
    expect(parsed.tag).toBe("anthropic_failure");
    expect(parsed.route).toBe("breakdown");
    expect(parsed.message).toBe("overloaded");
    expect(parsed.count).toBe(1);
  });

  it("captures the HTTP status from Anthropic APIError-shaped errors", () => {
    const apiErr = Object.assign(new Error("rate limited"), { status: 429 });
    recordAnthropicFailure("breakdown", apiErr);
    const parsed = JSON.parse(vi.mocked(console.error).mock.calls[0][0] as string);
    expect(parsed.status).toBe(429);
  });

  it("never throws, even for junk errors", () => {
    expect(() => recordAnthropicFailure("spark", undefined)).not.toThrow();
    expect(() => recordAnthropicFailure("spark", "string error")).not.toThrow();
    expect(anthropicFailureCount()).toBe(2);
  });
});
