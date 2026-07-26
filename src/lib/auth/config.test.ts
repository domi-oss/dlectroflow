import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { assertAuthConfig, assertLLMConfig } from "./config";

const ENV = process.env;
beforeEach(() => {
  process.env = {
    ...ENV,
    NODE_ENV: "production",
    AUTH_SESSION_SECRET: "x".repeat(32),
    GITLAB_OAUTH_CLIENT_ID: "cid",
    GITLAB_OAUTH_CLIENT_SECRET: "csecret",
    OWNER_ALLOWLIST: "123",
    GUEST_IP_HASH_SALT: "y".repeat(16),
    TOKEN_ENC_KEY: "0".repeat(64),
    ANTHROPIC_API_KEY: "sk-test",
  };
  delete process.env.LLM_PROVIDER;
  delete process.env.LLM_BASE_URL;
  delete process.env.LLM_MODEL;
});
afterEach(() => {
  process.env = ENV;
});

describe("assertAuthConfig — TOKEN_ENC_KEY", () => {
  it("passes when all secrets incl. TOKEN_ENC_KEY are present", () => {
    expect(() => assertAuthConfig()).not.toThrow();
  });

  it("throws when TOKEN_ENC_KEY is missing", () => {
    delete process.env.TOKEN_ENC_KEY;
    expect(() => assertAuthConfig()).toThrow(/TOKEN_ENC_KEY/);
  });

  it("throws when TOKEN_ENC_KEY is not 64 hex chars", () => {
    process.env.TOKEN_ENC_KEY = "abc";
    expect(() => assertAuthConfig()).toThrow(/TOKEN_ENC_KEY/);
  });

  it("throws when TOKEN_ENC_KEY is 64 chars but not hex", () => {
    process.env.TOKEN_ENC_KEY = "g".repeat(64);
    expect(() => assertAuthConfig()).toThrow(/TOKEN_ENC_KEY/);
  });
});

describe("assertLLMConfig — provider-conditional env", () => {
  it("passes for the default (anthropic) provider when ANTHROPIC_API_KEY is set", () => {
    expect(() => assertLLMConfig()).not.toThrow();
  });

  it("throws when anthropic is selected but ANTHROPIC_API_KEY is missing", () => {
    delete process.env.ANTHROPIC_API_KEY;
    expect(() => assertLLMConfig()).toThrow(/ANTHROPIC_API_KEY/);
  });

  it("passes for openai-compatible when LLM_BASE_URL + LLM_MODEL are set", () => {
    process.env.LLM_PROVIDER = "openai-compatible";
    process.env.LLM_BASE_URL = "http://localhost:11434/v1";
    process.env.LLM_MODEL = "llama3.1:8b";
    delete process.env.ANTHROPIC_API_KEY;
    expect(() => assertLLMConfig()).not.toThrow();
  });

  it("throws for openai-compatible when LLM_BASE_URL / LLM_MODEL are missing", () => {
    process.env.LLM_PROVIDER = "openai-compatible";
    expect(() => assertLLMConfig()).toThrow(
      /LLM_BASE_URL.*LLM_MODEL|LLM_MODEL/,
    );
  });

  it("is a no-op outside production", () => {
    process.env = { ...process.env, NODE_ENV: "test" };
    delete process.env.ANTHROPIC_API_KEY;
    expect(() => assertLLMConfig()).not.toThrow();
  });

  it("assertAuthConfig also enforces the LLM provider config", () => {
    process.env.LLM_PROVIDER = "openai-compatible";
    delete process.env.LLM_BASE_URL;
    delete process.env.LLM_MODEL;
    expect(() => assertAuthConfig()).toThrow(/LLM provider .* misconfigured/);
  });
});
