import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { configuredProvider } from "./configured-provider";

// #177 — `index.test.ts` already covers this behaviour THROUGH `getLLM()`, which
// is what callers see. These specs cover it directly, because the second caller
// (`saveOwnLlmKey`'s key-shape guard) never builds a provider and so would not
// be protected by those.
beforeEach(() => {
  delete process.env.LLM_PROVIDER;
});
afterEach(() => {
  delete process.env.LLM_PROVIDER;
  vi.restoreAllMocks();
});

describe("configuredProvider()", () => {
  it("defaults to anthropic when LLM_PROVIDER is unset", () => {
    expect(configuredProvider()).toBe("anthropic");
  });

  it("returns openai-compatible when that is configured", () => {
    process.env.LLM_PROVIDER = "openai-compatible";
    expect(configuredProvider()).toBe("openai-compatible");
  });

  it("falls back to anthropic for an unknown value", () => {
    process.env.LLM_PROVIDER = "bogus";
    expect(configuredProvider()).toBe("anthropic");
  });

  it("stays quiet about an unknown value unless asked to warn", () => {
    // The default matters: the key-shape guard calls this on every save, and a
    // misconfigured instance should not turn each one into a log line.
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    process.env.LLM_PROVIDER = "bogus";

    configuredProvider();
    expect(error).not.toHaveBeenCalled();

    configuredProvider(true);
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining('unknown LLM_PROVIDER="bogus"'),
    );
  });

  it("does not warn for a value it recognises", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    process.env.LLM_PROVIDER = "openai-compatible";
    configuredProvider(true);
    expect(error).not.toHaveBeenCalled();
  });
});
