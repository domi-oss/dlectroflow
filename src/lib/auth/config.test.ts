import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { assertAuthConfig } from "./config";

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
  };
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
