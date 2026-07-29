import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// #119 — the handler-layer half of the two-gate design in src/proxy.ts:36-40.
// The middleware can only tell "signed in" from "guest" (no Prisma client on the
// Edge runtime), so a signed-in MEMBER used to reach this route and mint a PKCE
// flow that ends in storeTokens() overwriting the instance-wide GoogleAuth row
// with their own credentials. The role check has to happen here.
const {
  isOwnerMock,
  configuredMock,
  createPkceMock,
  randomStateMock,
  buildAuthorizeUrlMock,
} = vi.hoisted(() => ({
  isOwnerMock: vi.fn(),
  configuredMock: vi.fn(),
  createPkceMock: vi.fn(),
  randomStateMock: vi.fn(),
  buildAuthorizeUrlMock: vi.fn(),
}));

vi.mock("@/lib/workspace", () => ({ isOwnerRequest: isOwnerMock }));
vi.mock("@/lib/google", () => ({
  googleConfigured: configuredMock,
  createPkce: createPkceMock,
  randomState: randomStateMock,
  buildAuthorizeUrl: buildAuthorizeUrlMock,
}));
vi.mock("@/lib/origin", () => ({
  requestOrigin: () => "https://dlectroflow.test",
}));

import { GET } from "./route";

const START_URL = "https://dlectroflow.test/api/google/oauth/start";

beforeEach(() => {
  vi.clearAllMocks();
  configuredMock.mockReturnValue(true);
  createPkceMock.mockReturnValue({ verifier: "ver", challenge: "chal" });
  randomStateMock.mockReturnValue("st");
  buildAuthorizeUrlMock.mockReturnValue("https://accounts.google.com/o/oauth2");
});

afterEach(() => vi.restoreAllMocks());

describe("google oauth start — owner gate (#119)", () => {
  it("rejects a signed-in non-owner with 403", async () => {
    isOwnerMock.mockResolvedValue(false);

    const res = await GET(new Request(START_URL));

    // 403, not a redirect: this is an API route, and bouncing a member into
    // Google's consent screen is exactly the flow being denied.
    expect(res.status).toBe(403);
    expect(await res.text()).toBe("Forbidden");
  });

  it("hands a rejected caller no PKCE or state cookie", async () => {
    isOwnerMock.mockResolvedValue(false);

    const res = await GET(new Request(START_URL));

    // The gate runs FIRST, so nothing usable is minted: no cookies to replay
    // against the callback, and no authorize URL to follow.
    expect(res.headers.get("set-cookie")).toBeNull();
    expect(createPkceMock).not.toHaveBeenCalled();
    expect(randomStateMock).not.toHaveBeenCalled();
    expect(buildAuthorizeUrlMock).not.toHaveBeenCalled();
    // Not even the configuration probe — the caller learns nothing about how
    // this instance is set up.
    expect(configuredMock).not.toHaveBeenCalled();
  });

  it("still redirects the owner to Google with both cookies set", async () => {
    isOwnerMock.mockResolvedValue(true);

    const res = await GET(new Request(START_URL));

    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toBe(
      "https://accounts.google.com/o/oauth2",
    );
    expect(buildAuthorizeUrlMock).toHaveBeenCalledWith({
      redirectUri: "https://dlectroflow.test/api/google/oauth/callback",
      state: "st",
      codeChallenge: "chal",
    });
    const setCookie = res.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain("google_pkce_verifier=ver");
    expect(setCookie).toContain("google_oauth_state=st");
  });

  it("still reports an unconfigured instance to the owner", async () => {
    isOwnerMock.mockResolvedValue(true);
    configuredMock.mockReturnValue(false);

    const res = await GET(new Request(START_URL));

    expect(res.headers.get("location")).toContain("/?google=error&reason=");
    expect(createPkceMock).not.toHaveBeenCalled();
  });
});
