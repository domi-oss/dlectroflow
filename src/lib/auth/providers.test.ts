import { afterEach, describe, it, expect, vi } from "vitest";
import { getAuthProvider, PROVIDER_FETCH_TIMEOUT_MS } from "./providers";
import { assertAuthConfig } from "./config";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

// #35 Phase A — the callback needs more than an opaque subject now: invites are
// typed as a username (owner decision), so the normalized profile has to carry
// one. The ACCOUNT still keys on `subject`, because usernames can be changed
// and reused; the typed value only has to match the invite once.
describe("gitlab provider fetchProfile", () => {
  function stubUserResponse(body: unknown, status = 200) {
    const fetchMock = vi.fn(
      async () => new Response(JSON.stringify(body), { status }),
    );
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  it("returns subject, username and email from the GitLab profile", async () => {
    stubUserResponse({ id: 42, username: "Domi", email: "d@example.com" });
    const profile = await getAuthProvider().fetchProfile("tok");
    expect(profile).toEqual({
      subject: "42",
      username: "domi",
      email: "d@example.com",
    });
  });

  it("tolerates a profile with no email (GitLab may withhold it)", async () => {
    stubUserResponse({ id: 42, username: "Domi" });
    const profile = await getAuthProvider().fetchProfile("tok");
    expect(profile).toEqual({
      subject: "42",
      username: "domi",
      email: undefined,
    });
  });

  it("normalises surrounding whitespace and case on both identity fields", async () => {
    stubUserResponse({ id: 7, username: "  MiXeD  ", email: " A@B.COM " });
    const profile = await getAuthProvider().fetchProfile("tok");
    expect(profile).toEqual({
      subject: "7",
      username: "mixed",
      email: "a@b.com",
    });
  });

  it("drops an empty-string username rather than matching an empty invite", async () => {
    stubUserResponse({ id: 7, username: "   ", email: "" });
    const profile = await getAuthProvider().fetchProfile("tok");
    expect(profile).toEqual({
      subject: "7",
      username: undefined,
      email: undefined,
    });
  });

  it("sends the bearer token to the GitLab user endpoint", async () => {
    const fetchMock = stubUserResponse({ id: 1, username: "x" });
    await getAuthProvider().fetchProfile("tok-123");
    expect(fetchMock).toHaveBeenCalledWith(
      "https://gitlab.com/api/v4/user",
      expect.objectContaining({
        headers: { Authorization: "Bearer tok-123" },
      }),
    );
  });

  it("throws on a non-ok profile response", async () => {
    stubUserResponse({ message: "401 Unauthorized" }, 401);
    await expect(getAuthProvider().fetchProfile("tok")).rejects.toThrow(
      /GitLab user fetch failed \(401\)/,
    );
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
    vi.stubEnv("OWNER_ALLOWLIST", "1234567");
    vi.stubEnv("GUEST_IP_HASH_SALT", "a".repeat(16));
    vi.stubEnv("TOKEN_ENC_KEY", "0".repeat(64));
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-test");
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

// #174 — a hang is the worst failure mode this flow has: no error, no retry
// affordance, no explanation. Neither of these two calls carried a deadline, so
// a stalled provider left the callback sitting on undici's default 300 s header
// timeout with a blank screen. Every failure path in the callback redirects to
// /login?error=…; the point of the deadline is to make sure one is reached.
describe("gitlab provider request deadlines (#174)", () => {
  // Typed with `fetch`'s real parameters even though the body ignores them.
  // `vi.fn(async () => …)` infers a zero-argument signature, which makes
  // `mock.calls` an empty tuple — so reading `calls[0][1]` to get at the
  // RequestInit is a type error, and the `as RequestInit` cast that hid it was
  // casting `undefined`. The assertions below are about the second argument, so
  // the mock has to admit it has one.
  function okFetch(body: unknown) {
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        new Response(JSON.stringify(body)),
    );
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  it("bounds the deadline — long enough for a slow mobile network, short enough to be an error", () => {
    expect(PROVIDER_FETCH_TIMEOUT_MS).toBeGreaterThanOrEqual(5_000);
    expect(PROVIDER_FETCH_TIMEOUT_MS).toBeLessThanOrEqual(15_000);
  });

  it("gives the token exchange an abort signal that is live, not already spent", async () => {
    const fetchMock = okFetch({ access_token: "at" });
    vi.stubEnv("AUTH_PROVIDER", "gitlab");
    vi.stubEnv("GITLAB_OAUTH_CLIENT_ID", "cid");
    vi.stubEnv("GITLAB_OAUTH_CLIENT_SECRET", "secret");

    await getAuthProvider().exchangeCode({
      code: "c",
      codeVerifier: "v",
      redirectUri: "https://x/api/auth/gitlab/callback",
    });

    const init = fetchMock.mock.calls[0][1];
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    expect(init?.signal?.aborted).toBe(false);
  });

  it("gives the profile fetch one too", async () => {
    const fetchMock = okFetch({ id: 1, username: "x" });

    await getAuthProvider().fetchProfile("tok");

    const init = fetchMock.mock.calls[0][1];
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    expect(init?.signal?.aborted).toBe(false);
  });

  // The user-facing half. An expired deadline surfaces from fetch as a
  // TimeoutError DOMException; the callback's catch turns any rejection into a
  // /login?error=… redirect, so what matters here is that it rejects at all
  // rather than resolving to something the caller then treats as a profile.
  it.each([
    [
      "exchangeCode",
      () =>
        getAuthProvider().exchangeCode({
          code: "c",
          codeVerifier: "v",
          redirectUri: "https://x/api/auth/gitlab/callback",
        }),
    ],
    ["fetchProfile", () => getAuthProvider().fetchProfile("tok")],
  ])("propagates a timed-out %s as a rejection", async (_name, call) => {
    vi.stubEnv("AUTH_PROVIDER", "gitlab");
    vi.stubEnv("GITLAB_OAUTH_CLIENT_ID", "cid");
    vi.stubEnv("GITLAB_OAUTH_CLIENT_SECRET", "secret");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new DOMException("The operation was aborted", "TimeoutError");
      }),
    );

    await expect(call()).rejects.toThrow(/aborted/i);
  });
});
