import { describe, it, expect, beforeEach } from "vitest";
import { getLLM, _resetLLMForTest } from "./index";

beforeEach(() => {
  _resetLLMForTest();
  process.env.ANTHROPIC_API_KEY = "test-key";
  delete process.env.LLM_PROVIDER;
});

describe("getLLM()", () => {
  it("defaults to the anthropic provider", () => {
    expect(getLLM().id).toBe("anthropic");
  });

  it("memoizes the provider instance", () => {
    expect(getLLM()).toBe(getLLM());
  });
});
