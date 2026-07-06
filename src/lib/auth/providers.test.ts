import { describe, it, expect } from "vitest";
import { isOwner, getAuthProvider } from "./providers";

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
    process.env.AUTH_PROVIDER = "gitlab";
    process.env.GITLAB_OAUTH_CLIENT_ID = "cid";
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
