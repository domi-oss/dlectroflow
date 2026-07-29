import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// #119 — the handler-layer half of the two-gate design in src/proxy.ts:36-40.
// The middleware can only tell "signed in" from "guest" (no Prisma client on the
// Edge runtime), so a signed-in MEMBER used to reach this route and mint a PKCE
// flow that ends in storeTokens() overwriting the instance-wide GoogleAuth row
// with their own credentials. The role check had to happen here.
//
// #118 Phase C — the row is per user now, so a member connecting THEIR OWN
// account is the intended behaviour and the gate becomes "is there an account at
// all". It is not redundant with the middleware: a REVOKED account still holds a
// valid signed cookie and passes it, while currentUser() resolves it to null.
const {
  currentUserMock,
  configuredMock,
  createPkceMock,
  randomStateMock,
  buildAuthorizeUrlMock,
} = vi.hoisted(() => ({
  currentUserMock: vi.fn(),
  configuredMock: vi.fn(),
  createPkceMock: vi.fn(),
  randomStateMock: vi.fn(),
  buildAuthorizeUrlMock: vi.fn(),
}));

vi.mock("@/lib/workspace", () => ({ currentUser: currentUserMock }));
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

// The route reads currentUser() and cares only whether it is null: any account
// may connect its own Google account (#118). A member is the interesting case
// precisely because #119 had to reject one.
const memberUser = () => ({
  id: "user-member",
  role: "member" as const,
  workspaceId: "ws-member",
  provider: "gitlab",
  handle: "member",
});

beforeEach(() => {
  vi.clearAllMocks();
  configuredMock.mockReturnValue(true);
  createPkceMock.mockReturnValue({ verifier: "ver", challenge: "chal" });
  randomStateMock.mockReturnValue("st");
  buildAuthorizeUrlMock.mockReturnValue("https://accounts.google.com/o/oauth2");
});

afterEach(() => vi.restoreAllMocks());

describe("google oauth start — authenticated gate (#118, was owner-only in #119)", () => {
  it("lets a signed-in MEMBER start their own connect flow", async () => {
    // Was a 403 in #119. The credential is keyed on the acting user now, so this
    // is a member connecting THEIR account, not overwriting the owner's.
    currentUserMock.mockResolvedValue(memberUser());

    const res = await GET(new Request(START_URL));

    expect(res.status).toBe(307);
    const setCookie = res.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain("google_pkce_verifier=ver");
  });

  it("rejects a caller with no signed-in account with 403", async () => {
    // The middleware already stops guests (AUTHENTICATED_PREFIXES), so this is
    // defence in depth — and it also covers a REVOKED account, which holds a
    // valid signed cookie and resolves to null (workspace.ts:142).
    currentUserMock.mockResolvedValue(null);

    const res = await GET(new Request(START_URL));

    // 403, not a redirect: this is an API route, and bouncing a rejected caller
    // into Google's consent screen is exactly the flow being denied.
    expect(res.status).toBe(403);
    expect(await res.text()).toBe("Forbidden");
  });

  // #119's "hands a rejected caller no PKCE or state cookie" case, kept verbatim
  // with currentUser → null instead of isOwner → false. It is the assertion that
  // the gate runs FIRST.
  it("hands a rejected caller no PKCE or state cookie", async () => {
    currentUserMock.mockResolvedValue(null);

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
    currentUserMock.mockResolvedValue({ ...memberUser(), role: "owner" });

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

  it("still reports an unconfigured instance to a signed-in caller", async () => {
    currentUserMock.mockResolvedValue(memberUser());
    configuredMock.mockReturnValue(false);

    const res = await GET(new Request(START_URL));

    expect(res.headers.get("location")).toContain("/?google=error&reason=");
    expect(createPkceMock).not.toHaveBeenCalled();
  });
});
