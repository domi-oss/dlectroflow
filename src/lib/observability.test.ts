import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  recordLLMFailure,
  llmFailureCount,
  _resetLLMFailuresForTest,
  recordAnthropicFailure,
  anthropicFailureCount,
  _resetAnthropicFailuresForTest,
} from "./observability";

describe("recordLLMFailure", () => {
  beforeEach(() => {
    _resetLLMFailuresForTest();
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  it("increments the counter and logs a provider-tagged line", () => {
    recordLLMFailure(
      "openai-compatible",
      "breakdown",
      Object.assign(new Error("boom"), { status: 500 }),
    );
    expect(llmFailureCount()).toBe(1);
    const logged = JSON.parse(
      vi.mocked(console.error).mock.calls[0][0] as string,
    );
    expect(logged).toMatchObject({
      tag: "llm_failure",
      provider: "openai-compatible",
      route: "breakdown",
      status: 500,
    });
  });

  it("increments the counter across calls", () => {
    expect(llmFailureCount()).toBe(0);
    recordLLMFailure("anthropic", "breakdown", new Error("boom"));
    recordLLMFailure("anthropic", "breakdown", new Error("boom again"));
    expect(llmFailureCount()).toBe(2);
  });

  it("captures the HTTP status from APIError-shaped errors", () => {
    const apiErr = Object.assign(new Error("rate limited"), { status: 429 });
    recordLLMFailure("anthropic", "breakdown", apiErr);
    const parsed = JSON.parse(
      vi.mocked(console.error).mock.calls[0][0] as string,
    );
    expect(parsed.status).toBe(429);
  });

  it("never throws, even for junk errors", () => {
    expect(() =>
      recordLLMFailure("anthropic", "spark", undefined),
    ).not.toThrow();
    expect(() =>
      recordLLMFailure("anthropic", "spark", "string error"),
    ).not.toThrow();
    expect(llmFailureCount()).toBe(2);
  });
});

describe("recordAnthropicFailure (deprecated alias)", () => {
  beforeEach(() => {
    _resetLLMFailuresForTest();
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  it("anthropicFailureCount reflects the same counter as llmFailureCount", () => {
    recordLLMFailure("anthropic", "spark", new Error("x"));
    expect(anthropicFailureCount()).toBe(1);
    expect(llmFailureCount()).toBe(1);
  });

  it("records against the shared counter, tagged provider:anthropic", () => {
    recordAnthropicFailure("breakdown", new Error("overloaded"));
    expect(anthropicFailureCount()).toBe(1);
    const parsed = JSON.parse(
      vi.mocked(console.error).mock.calls[0][0] as string,
    );
    expect(parsed).toMatchObject({
      tag: "llm_failure",
      provider: "anthropic",
      route: "breakdown",
      message: "overloaded",
    });
  });

  it("_resetAnthropicFailuresForTest resets the shared counter", () => {
    recordAnthropicFailure("breakdown", new Error("x"));
    expect(anthropicFailureCount()).toBe(1);
    _resetAnthropicFailuresForTest();
    expect(anthropicFailureCount()).toBe(0);
  });

  it("never throws, even for junk errors", () => {
    expect(() => recordAnthropicFailure("spark", undefined)).not.toThrow();
    expect(() => recordAnthropicFailure("spark", "string error")).not.toThrow();
    expect(anthropicFailureCount()).toBe(2);
  });
});
