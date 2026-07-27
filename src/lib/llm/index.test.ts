import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { getLLM, _resetLLMForTest } from "./index";

beforeEach(() => {
  _resetLLMForTest();
  process.env.ANTHROPIC_API_KEY = "test-key";
  delete process.env.LLM_PROVIDER;
});

afterEach(() => {
  delete process.env.LLM_PROVIDER;
  delete process.env.LLM_BASE_URL;
  delete process.env.LLM_MODEL;
});

describe("getLLM()", () => {
  it("defaults to the anthropic provider", () => {
    expect(getLLM().id).toBe("anthropic");
  });

  it("memoizes the provider instance", () => {
    expect(getLLM()).toBe(getLLM());
  });

  it("selects the openai-compatible provider when LLM_PROVIDER=openai-compatible", () => {
    process.env.LLM_PROVIDER = "openai-compatible";
    process.env.LLM_BASE_URL = "http://localhost:11434/v1";
    process.env.LLM_MODEL = "llama3.1:8b";
    expect(getLLM().id).toBe("openai-compatible");
  });

  it("falls back to anthropic for an unknown LLM_PROVIDER", () => {
    process.env.LLM_PROVIDER = "bogus";
    expect(getLLM().id).toBe("anthropic");
  });
});
