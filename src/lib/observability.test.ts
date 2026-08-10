import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  recordLLMFailure,
  llmFailureCount,
  _resetLLMFailuresForTest,
  recordAnthropicFailure,
  anthropicFailureCount,
  _resetAnthropicFailuresForTest,
  recordAuthFailure,
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

// #174 — diagnosing this took an ingress access log and a referer field,
// because the app said nothing at all when a sign-in failed. Every fail()
// branch now emits one line.
describe("recordAuthFailure", () => {
  beforeEach(() => {
    _resetLLMFailuresForTest();
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  const logged = () =>
    JSON.parse(vi.mocked(console.warn).mock.calls[0][0] as string);

  it("emits one greppable line carrying the reason and the host", () => {
    recordAuthFailure({
      reason: "expired",
      host: "legacy.example",
      hadState: false,
      hadVerifier: false,
    });
    expect(logged()).toMatchObject({
      tag: "auth_failure",
      reason: "expired",
      host: "legacy.example",
      hadState: false,
      hadVerifier: false,
    });
  });

  // The host field is the one that would have answered #174 on its own: a
  // callback arriving on a hostname other than PUBLIC_ORIGIN's is the whole
  // bug, and nothing in the app was recording it.
  it("records the host even when it is absent from the request", () => {
    recordAuthFailure({ reason: "state_mismatch", host: null });
    expect(logged()).toMatchObject({ host: null });
  });

  it("carries a timestamp", () => {
    recordAuthFailure({ reason: "expired", host: "h" });
    expect(() => new Date(logged().ts).toISOString()).not.toThrow();
  });

  // A failure line is not a health signal. /api/livez's counter means "the LLM
  // provider is down and every breakdown is falling back"; a wrong password is
  // not that, and folding it in would make the probe lie.
  it("does not touch the LLM failure counter", () => {
    recordAuthFailure({ reason: "not_authorized", host: "h" });
    expect(llmFailureCount()).toBe(0);
  });

  it("never lets logging take the request down with it", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(() =>
      recordAuthFailure({
        reason: "x",
        host: "h",
        // A value JSON.stringify cannot serialise.
        hadState: circular as unknown as boolean,
      }),
    ).not.toThrow();
  });
});
