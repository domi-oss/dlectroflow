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

// ── #35 Phase B — a per-request provider bound to a user's own key ───────────
describe("getLLM(credentials)", () => {
  it("returns a FRESH provider, never the memoized instance one", () => {
    const instance = getLLM();
    const withKey = getLLM({ apiKey: "sk-the-users-own" });
    expect(withKey).not.toBe(instance);
    // …and it must not poison the cache for the next instance-key caller.
    expect(getLLM()).toBe(instance);
  });

  it("does not memoize across two different keys", () => {
    const a = getLLM({ apiKey: "sk-a" });
    const b = getLLM({ apiKey: "sk-b" });
    expect(a).not.toBe(b);
  });

  it("honours an explicit provider on the credentials", () => {
    process.env.LLM_BASE_URL = "http://localhost:11434/v1";
    process.env.LLM_MODEL = "llama3.1:8b";
    expect(getLLM({ apiKey: "sk-x", provider: "openai-compatible" }).id).toBe(
      "openai-compatible",
    );
  });

  it("falls back to the instance provider for a null or unknown provider", () => {
    process.env.LLM_PROVIDER = "openai-compatible";
    process.env.LLM_BASE_URL = "http://localhost:11434/v1";
    process.env.LLM_MODEL = "llama3.1:8b";
    expect(getLLM({ apiKey: "sk-x", provider: null }).id).toBe(
      "openai-compatible",
    );
    expect(getLLM({ apiKey: "sk-x", provider: "wat" }).id).toBe(
      "openai-compatible",
    );
  });
});
