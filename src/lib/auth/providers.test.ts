import { afterEach, describe, it, expect, vi } from "vitest";
import { isOwner, getAuthProvider } from "./providers";
import { assertAuthConfig } from "./config";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("isOwner", () => {
  it("matches an allowlisted id", () => {
    expect(isOwner("13595692", ["13595692"])).toBe(true);
  });
  it("is case-insensitive and trims", () => {
    expect(isOwner("  Me@x.com ", ["me@x.com"])).toBe(true);
  });
  it("rejects a non-listed identity", () => {
    expect(isOwner("999", ["13595692"])).toBe(false);
  });
  it("rejects empty identity", () => {
    expect(isOwner("", ["13595692"])).toBe(false);
  });
});

describe("gitlab provider authorize url", () => {
  it("includes client_id, PKCE and read_user scope", () => {
    vi.stubEnv("AUTH_PROVIDER", "gitlab");
    vi.stubEnv("GITLAB_OAUTH_CLIENT_ID", "cid");
    const url = getAuthProvider().buildAuthorizeUrl({
      redirectUri: "https://x/api/auth/gitlab/callback",
      state: "st",
      codeChallenge: "ch",
    });
    expect(url).toContain("client_id=cid");
    expect(url).toContain("scope=read_user");
    expect(url).toContain("code_challenge=ch");
    expect(url).toContain("code_challenge_method=S256");
  });
});

describe("assertAuthConfig", () => {
  it("throws in production when required env vars are unset", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("AUTH_SESSION_SECRET", "");
    vi.stubEnv("GITLAB_OAUTH_CLIENT_ID", "");
    vi.stubEnv("GITLAB_OAUTH_CLIENT_SECRET", "");
    vi.stubEnv("OWNER_ALLOWLIST", "");
    expect(() => assertAuthConfig()).toThrow();
  });

  it("does not throw in production when all required env vars are set validly", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("AUTH_SESSION_SECRET", "a".repeat(32));
    vi.stubEnv("GITLAB_OAUTH_CLIENT_ID", "client-id");
    vi.stubEnv("GITLAB_OAUTH_CLIENT_SECRET", "client-secret");
    vi.stubEnv("OWNER_ALLOWLIST", "13595692");
    vi.stubEnv("GUEST_IP_HASH_SALT", "a".repeat(16));
    expect(() => assertAuthConfig()).not.toThrow();
  });

  it("does not throw in non-production when required env vars are unset", () => {
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("AUTH_SESSION_SECRET", "");
    vi.stubEnv("GITLAB_OAUTH_CLIENT_ID", "");
    vi.stubEnv("GITLAB_OAUTH_CLIENT_SECRET", "");
    vi.stubEnv("OWNER_ALLOWLIST", "");
    expect(() => assertAuthConfig()).not.toThrow();
  });
});
